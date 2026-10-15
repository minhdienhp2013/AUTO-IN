import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCb} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';

const execFile=promisify(execFileCb);
const databaseUrl=process.env.TEST_DATABASE_URL;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(command,args,options={})=>execFile(command,args,{
  cwd:process.cwd(),timeout:90000,maxBuffer:1024*1024,...options
});

/**
 * AI0-owned product test. No fake HTTP or fabricated manifest. Creates a
 * synthetic PNG with Pillow and lets scripts/process-order.ts call the real
 * AI3 renderer, publish a plan, and anchor the immutable manifest to SQL.
 * Both preview URLs use genuine authenticated localhost Fastify GETs.
 */
test('AI0 sealed AI3 preview: current GET200 and both old-revision GET409 after real Core revise',{
  skip:!databaseUrl?'TEST_DATABASE_URL required; real PostgreSQL NOT RUN':false,
  timeout:180000
},async()=>{
  assertIsolatedSimulationDatabase(databaseUrl);
  const scratch=await mkdtemp(join(tmpdir(),'autoin-preview-stale-'));
  const inputRoot=join(scratch,'input');
  const artifactRoot=join(scratch,'sealed');
  let pool,app;
  try{
    await mkdir(inputRoot,{mode:0o700});
    await mkdir(artifactRoot,{mode:0o700});
    await run('python3',['-c',
      'from PIL import Image;import sys;Image.new("RGB",(120,160),"white").save(sys.argv[1])',
      join(inputRoot,'fixture.png')]);
    pool=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
    const core=createCoreModule({pool:asSqlPool(pool)});
    const shop='autoin-test-preview-stale-'+randomUUID();
    const password='test-only-'+randomUUID();
    await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
    await core.auth.bootstrapOwner({
      shop_id:shop,username:'owner',password,bootstrap_enabled:true
    });
    app=buildIntegratedApp({pool:asSqlPool(pool),previewArtifactRoot:artifactRoot});
    await app.listen({host:'127.0.0.1',port:0});
    const addr=app.server.address();
    assert.ok(addr && typeof addr!=='string');
    const base='http://127.0.0.1:'+addr.port;
    const http=async(method,path,body,token)=>{
      const response=await fetch(base+path,{
        method,
        headers:{...(body?{'Content-Type':'application/json'}:{}),
          ...(token?{Authorization:'Bearer '+token}:{})},
        ...(body?{body:JSON.stringify(body)}:{})
      });
      const bytes=Buffer.from(await response.arrayBuffer());
      const data=response.headers.get('content-type')?.includes('json')
        ?JSON.parse(bytes.toString('utf8')):null;
      return {status:response.status,bytes,data,headers:response.headers};
    };
    const login=await http('POST','/api/v1/auth/login',{
      shop_id:shop,username:'owner',password
    });
    assert.equal(login.status,200,JSON.stringify(login.data));
    const token=login.data?.token;
    assert.equal(typeof token,'string');
    const firstRequest={documents:[{
      artifact_name:'fixture.png',copies:1,duplex:false,paper:'A4'
    }]};
    const created=await http('POST','/api/v1/orders',{
      customer_id:'synthetic-customer',request_data:firstRequest,
      idempotency_key:'preview-create-'+randomUUID()
    },token);
    assert.equal(created.status,200,JSON.stringify(created.data));
    const orderId=created.data?.order_id;
    assert.match(orderId,/^[a-f0-9-]{36}$/i);
    const rendered=await run(process.execPath,
      ['--import','tsx','scripts/process-order.ts',shop,orderId],{
        env:{...process.env,DATABASE_URL:databaseUrl,
          AUTOIN_INPUT_ROOT:inputRoot,AUTOIN_ARTIFACT_ROOT:artifactRoot,
          AUTOIN_PROCESSOR_ID:'ai0-test-sealed-preview',AUTOIN_PYTHON:'python3'}
      });
    const processor=JSON.parse(rendered.stdout);
    assert.equal(processor.revision,2);
    const anchor=await pool.query(
      'SELECT artifact_ref,manifest_sha256,request_hash FROM ai0_verified_plan_manifests '+
      'WHERE shop_id=$1 AND order_id=$2 AND revision=2',[shop,orderId]);
    assert.equal(anchor.rowCount,1,'AI3 processor must create genuine SQL anchor');
    const proof=anchor.rows[0];
    const immutable=await readFile(join(artifactRoot,proof.artifact_ref));
    assert.equal(sha(immutable),proof.manifest_sha256);
    const parsed=JSON.parse(immutable.toString('utf8'));
    assert.equal(parsed.schema,'ai3.document_bridge.v1');
    assert.equal(parsed.request_hash,proof.request_hash);
    assert.ok(parsed.previews?.length>0,'AI3 must render genuine preview PNGs');
    const item=parsed.previews[0];
    const png=await readFile(join(artifactRoot,item.ref));
    assert.equal(sha(png),item.sha256);
    assert.equal(png.length,item.bytes);
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');

    const previewPath='/api/v1/orders/'+orderId+'/revisions/2/previews';
    const catalog=await http('GET',previewPath,null,token);
    assert.equal(catalog.status,200,JSON.stringify(catalog.data));
    assert.equal(catalog.data?.preview_verified,true);
    assert.equal(catalog.data?.revision,2);
    assert.equal(catalog.data?.request_hash,proof.request_hash);
    assert.ok(catalog.data?.preview_count>=1);
    assert.equal(catalog.headers.get('cache-control'),'no-store');
    const raster=await http('GET',previewPath+'/0',null,token);
    assert.equal(raster.status,200);
    assert.equal(raster.headers.get('content-type'),'image/png');
    assert.equal(sha(raster.bytes),item.sha256);
    const counted=async table=>{
      const z=await pool.query(
        'SELECT COUNT(*)::int AS n FROM '+table+' WHERE order_id=$1',[orderId]);
      return z.rows[0].n;
    };
    const countsBefore={
      confirmations:await counted('core_confirmations'),
      approvals:await counted('core_approvals'),
      print_jobs:await counted('core_print_jobs')
    };
    assert.deepEqual(countsBefore,{confirmations:0,approvals:0,print_jobs:0});
    // Ordinary authenticated Core revision mutation: no forged hash/SQL plan.
    const revised=await http('POST','/api/v1/orders/'+orderId+'/revisions',{
      expected_revision:2,
      request_data:{documents:[{
        artifact_name:'fixture.png',copies:2,duplex:false,paper:'A4'
      }]},
      idempotency_key:'preview-revise-'+randomUUID()
    },token);
    assert.equal(revised.status,200,JSON.stringify(revised.data));
    assert.equal(revised.data?.revision,3);
    const current=await http('GET','/api/v1/orders/'+orderId,null,token);
    assert.equal(current.status,200,JSON.stringify(current.data));
    assert.equal(current.data?.order?.active_revision,3);
    assert.notEqual(current.data?.current?.request_hash,proof.request_hash);
    const staleCatalog=await http('GET',previewPath,null,token);
    const staleRaster=await http('GET',previewPath+'/0',null,token);
    for(const [kind,response] of [['catalog',staleCatalog],['raster',staleRaster]]){
      assert.equal(response.status,409,kind+': '+JSON.stringify(response.data));
      assert.equal(response.data?.error?.code,'STALE_OR_UNVERIFIED_PREVIEW');
    }
    const countsAfter={
      confirmations:await counted('core_confirmations'),
      approvals:await counted('core_approvals'),
      print_jobs:await counted('core_print_jobs')
    };
    assert.deepEqual(countsAfter,countsBefore);
    assert.equal(sha(await readFile(join(artifactRoot,proof.artifact_ref))),
      proof.manifest_sha256,'old AI3 manifest must remain immutable');
    assert.equal(sha(await readFile(join(artifactRoot,item.ref))),
      item.sha256,'old AI3 PNG must remain immutable');
    const retained=await pool.query(
      'SELECT COUNT(*)::int AS n FROM ai0_verified_plan_manifests '+
      'WHERE shop_id=$1 AND order_id=$2 AND revision=2',[shop,orderId]);
    assert.equal(retained.rows[0].n,1,'old DB anchor must remain intact');
    console.log('PASS REAL AI0 SEALED PREVIEW GET catalog=200 png=200 -> '+ 
      'catalog=409 STALE_OR_UNVERIFIED_PREVIEW png=409 STALE_OR_UNVERIFIED_PREVIEW');
    console.log('PASS AI3 sealed manifest sha256='+proof.manifest_sha256+
      ' immutable_artifacts=true revision=2->3 hash_changed=true');
    console.log('PASS PREVIEW409 counts_before='+JSON.stringify(countsBefore)+
      ' counts_after='+JSON.stringify(countsAfter)+
      ' physical_printer=NOT_RUN provider_OA=NOT_RUN');
  }finally{
    if(app)await app.close();
    if(pool)await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
