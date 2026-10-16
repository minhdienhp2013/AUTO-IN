/**
 * AI0-owned fixture/controller for AI4 Chromium stale preview test.
 * Source: actual AI3 process-order bridge + real Fastify + isolated PostgreSQL.
 * Does not intercept product HTTP, forge images, grant auth bypass, or print.
 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
assert.ok(databaseUrl,'NOT RUN: TEST_DATABASE_URL missing');
assertIsolatedSimulationDatabase(databaseUrl);
assert.equal(process.env.AUTOIN_OPERATION_MODE,'simulation');
assert.equal(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE,'YES_ISOLATED_TEST_DB');
const execFile=promisify(execFileCb);
const run=(cmd,args,env)=>execFile(cmd,args,{
  cwd:process.cwd(),timeout:90000,maxBuffer:1024*1024,...(env?{env}:{})
});
const hash=b=>createHash('sha256').update(b).digest('hex');
const dist=resolve('web/dist');
const html=await readFile(resolve(dist,'index.html'),'utf8');
assert.ok((await stat('web/package-lock.json')).isFile()&&html.includes('/assets/'),
  'NOT RUN: genuine compiled web/dist is required');
const scratch=await mkdtemp(join(tmpdir(),'autoin-preview-ui409-'));
const inputRoot=join(scratch,'input'),artifactRoot=join(scratch,'artifacts');
const pool=new pg.Pool({connectionString:databaseUrl,max:7,connectionTimeoutMillis:5000});
const id=randomUUID(),shop='autoin-test-preview-ui-'+id;
const password='test-only-'+randomUUID();
const mime={'.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml',
  '.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
const orders={},anchors={},tokens={};
let app,controllerRevisionPosts=0;

const http=async(method,url,body,token)=>{
  const address=app.server.address();
  assert.ok(address && typeof address!=='string');
  const response=await fetch('http://127.0.0.1:'+address.port+url,{
    method,headers:{...(body?{'Content-Type':'application/json'}:{}),
      ...(token?{Authorization:'Bearer '+token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  const bytes=Buffer.from(await response.arrayBuffer());
  const data=response.headers.get('content-type')?.includes('json')
    ?JSON.parse(bytes.toString('utf8')):null;
  return {status:response.status,data,bytes,headers:response.headers};
};
const counts=async orderIds=>{
  const r=await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) AS confirmations,'+
    ' (SELECT COUNT(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) AS approvals,'+
    ' (SELECT COUNT(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) AS print_jobs',
    [orderIds]);
  return r.rows[0];
};

try{
  await mkdir(inputRoot,{mode:0o700});
  await mkdir(artifactRoot,{mode:0o700});
  await run('python3',['-c',
    'from PIL import Image;import sys;Image.new("RGB",(120,160),"white").save(sys.argv[1])',
    join(inputRoot,'fixture.png')]);
  const core=createCoreModule({pool:asSqlPool(pool)});
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
    password,bootstrap_enabled:true});
  app=buildIntegratedApp({pool:asSqlPool(pool),previewArtifactRoot:artifactRoot});
  // Product Vite assets share the same genuine Fastify origin as product APIs.
  app.get('/',async(_request,reply)=>reply.type('text/html; charset=utf-8')
    .header('Cache-Control','no-store').send(html));
  app.get('/assets/*',async(request,reply)=>{
    const tail=request.params?.['*'];
    if(typeof tail!=='string'||!tail||!/^[a-zA-Z0-9._/-]+$/.test(tail)||
      tail.split('/').some(x=>!x||x==='.'||x==='..'))
      return reply.code(404).send();
    const pathname=resolve(dist,'assets',tail);
    if(!pathname.startsWith(resolve(dist,'assets')+sep))
      return reply.code(404).send();
    const bytes=await readFile(pathname).catch(()=>null);
    return bytes?reply.header('Cache-Control','no-store')
      .type(mime[extname(pathname)]||'application/octet-stream')
      .send(bytes):reply.code(404).send();
  });
  await app.listen({host:'127.0.0.1',port:0});
  const login=await http('POST','/api/v1/auth/login',{
    shop_id:shop,username:'owner',password
  });
  assert.equal(login.status,200,JSON.stringify(login.data));
  const token=login.data?.token;
  assert.equal(typeof token,'string');
  tokens.staff=token;
  for(const device of ['desktop','mobile']){
    const requestData={documents:[{
      artifact_name:'fixture.png',copies:1,duplex:false,paper:'A4'
    }]};
    const created=await http('POST','/api/v1/orders',{
      customer_id:'test-customer-'+device,request_data:requestData,
      idempotency_key:'preview-ui-create-'+device+'-'+randomUUID()
    },token);
    assert.equal(created.status,200,JSON.stringify(created.data));
    const orderId=created.data?.order_id;
    assert.match(orderId,/^[a-f0-9-]{36}$/i);
    orders[device]=orderId;
    const processor=await run(process.execPath,
      ['--import','tsx','scripts/process-order.ts',shop,orderId],{
        ...process.env,DATABASE_URL:databaseUrl,AUTOIN_INPUT_ROOT:inputRoot,
        AUTOIN_ARTIFACT_ROOT:artifactRoot,
        AUTOIN_PROCESSOR_ID:'ai0-test-preview-ui-processor',AUTOIN_PYTHON:'python3'
      });
    const result=JSON.parse(processor.stdout);
    assert.equal(result.revision,2,'only genuine AI3 rendering may publish plan');
    const a=await pool.query(
      'SELECT artifact_ref,manifest_sha256,request_hash FROM ai0_verified_plan_manifests '+
      'WHERE shop_id=$1 AND order_id=$2 AND revision=2',[shop,orderId]);
    assert.equal(a.rowCount,1,'real AI3 sealed SQL anchor required');
    const proof=a.rows[0];
    const raw=await readFile(join(artifactRoot,proof.artifact_ref));
    assert.equal(hash(raw),proof.manifest_sha256);
    const manifest=JSON.parse(raw.toString('utf8'));
    assert.equal(manifest.schema,'ai3.document_bridge.v1');
    assert.equal(manifest.request_hash,proof.request_hash);
    const first=manifest.previews?.[0];
    assert.ok(first?.ref&&first?.sha256,'actual raster preview must exist');
    const png=await readFile(join(artifactRoot,first.ref));
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(hash(png),first.sha256);
    assert.equal(png.length,first.bytes);
    const prefix='/api/v1/orders/'+orderId+'/revisions/2/previews';
    const catalog=await http('GET',prefix,null,token);
    const image=await http('GET',prefix+'/0',null,token);
    assert.equal(catalog.status,200,JSON.stringify(catalog.data));
    assert.equal(catalog.data?.preview_verified,true);
    assert.equal(image.status,200);
    assert.equal(hash(image.bytes),first.sha256);
    anchors[device]={...proof,first};
  }
  const before=await counts(Object.values(orders));
  assert.deepEqual(before,{confirmations:0,approvals:0,print_jobs:0});
  const address=app.server.address();
  assert.ok(address&&typeof address!=='string');
  const env={...process.env,
    AUTOIN_CODE008_PREVIEW_URL:'http://127.0.0.1:'+address.port+'/',
    AUTOIN_CODE008_PREVIEW_SHOP:shop,AUTOIN_CODE008_PREVIEW_USER:'owner',
    AUTOIN_CODE008_PREVIEW_PASSWORD:password,
    AUTOIN_CODE008_PREVIEW_ORDERS:JSON.stringify(orders)};
  const status=await new Promise((done,fail)=>{
    const child=spawn('python3',['tests/ui/code008-preview-stale-browser.py'],{
      cwd:process.cwd(),env,stdio:['pipe','pipe','inherit']
    });
    let buffer='',closed=false,serial=Promise.resolve();
    const abort=error=>{
      if(closed)return;
      closed=true;
      child.kill();
      fail(error);
    };
    const handle=async line=>{
      if(line.startsWith('CONTROL REVISE ')){
        const device=line.slice('CONTROL REVISE '.length);
        assert.ok(device==='desktop'||device==='mobile',
          'Unexpected browser revision control');
        assert.ok(!anchors[device].revised,'Duplicate browser revision control');
        const orderId=orders[device];
        const revised=await http('POST','/api/v1/orders/'+orderId+'/revisions',{
          expected_revision:2,request_data:{documents:[{
            artifact_name:'fixture.png',copies:2,duplex:false,paper:'A4'
          }]},idempotency_key:'preview-ui-revise-'+device+'-'+randomUUID()
        },token);
        assert.equal(revised.status,200,JSON.stringify(revised.data));
        assert.equal(revised.data?.revision,3);
        const current=await http('GET','/api/v1/orders/'+orderId,null,token);
        assert.equal(current.status,200);
        assert.equal(current.data?.order?.active_revision,3);
        assert.notEqual(current.data?.current?.request_hash,
          anchors[device].request_hash);
        const proof=anchors[device];
        assert.equal(hash(await readFile(join(artifactRoot,proof.artifact_ref))),
          proof.manifest_sha256);
        assert.equal(hash(await readFile(join(artifactRoot,proof.first.ref))),
          proof.first.sha256);
        const still=await pool.query(
          'SELECT COUNT(*)::int AS n FROM ai0_verified_plan_manifests '+
          'WHERE shop_id=$1 AND order_id=$2 AND revision=2',[shop,orderId]);
        assert.equal(still.rows[0].n,1);
        proof.revised=true;
        controllerRevisionPosts++;
        child.stdin.write('OK\n');
      }else if(line)console.log(line);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      while(buffer.includes('\n')){
        const i=buffer.indexOf('\n'),line=buffer.slice(0,i).trimEnd();
        buffer=buffer.slice(i+1);
        serial=serial.then(()=>handle(line)).catch(abort);
      }
    });
    child.on('error',abort);
    child.on('close',code=>{
      void serial.then(()=>{
        if(!closed){closed=true;done(code);}
      }).catch(abort);
    });
  });
  const after=await counts(Object.values(orders));
  console.log('AI0 PREVIEW UI409 counts_before='+JSON.stringify(before)+
    ' counts_after='+JSON.stringify(after)+
    ' intentional_staff_revision_posts='+controllerRevisionPosts);
  assert.equal(status,0,'Chromium stale preview test failed');
  assert.equal(controllerRevisionPosts,2,'two controlled Core revisions required');
  assert.ok(Object.values(anchors).every(x=>x.revised),
    'each viewport must advance its own order');
  assert.deepEqual(after,before,
    'preview browsing/controlled revisions must not approve/confirm/print');
  console.log('PASS REAL AI0 CODE008 PREVIEW UI409 1440x900+390x844 '+
    'two Chromium GET409 stale after genuine AI3 sealed GET200, '+
    'browser_business_mutation=0, real Core revisions=2, guards=0');
}finally{
  if(app)await app.close();
  await pool.end();
  await rm(scratch,{recursive:true,force:true});
}
