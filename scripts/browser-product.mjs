/** AI0 ONLY: isolated PostgreSQL + Fastify API + compiled React web UI on ONE localhost origin.
 * E2E session transport: never use customer/agent credentials, send live Zalo or print.
 * CI must build web with VITE_DEMO_MODE=false before executing this harness.
 */
import { randomUUID,createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import {createCoreModule} from '../backend/core/factory.ts';
import {buildIntegratedApp} from '../backend/composition/runtime.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../backend/composition/postgres.ts';

const db=process.env.TEST_DATABASE_URL;
if (!db) throw Error('TEST_DATABASE_URL required: product browser NOT RUN');
assertIsolatedSimulationDatabase(db);
if (process.env.AUTOIN_OPERATION_MODE !== 'simulation')
  throw Error('Product browser must run in simulation mode');
const root=resolve('web/dist');
const html=await readFile(resolve(root,'index.html'),'utf8');
const lock=await stat('web/package-lock.json');
if (!lock.isFile() || !html.includes('/assets/'))
  throw Error('Real AI4 build/lockfile required, browser NOT RUN');

const pool=new pg.Pool({connectionString:db,connectionTimeoutMillis:5000});
let app;
const previewRoot=await mkdtemp(join(tmpdir(),'autoin-browser-verified-'));
const digest=value=>createHash('sha256').update(value).digest('hex');
const mime={
  '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png',
  '.webp':'image/webp',
  '.ico':'image/x-icon',
  '.woff2':'font/woff2'
};
async function staticAsset(request,reply) {
  const tail=request.params?.['*'];
  if(typeof tail!=='string'||!tail||!(/^[a-zA-Z0-9._/-]+$/).test(tail)||
     tail.split('/').some(x=>!x||x==='.'||x==='..'))
    return reply.code(404).send();
  const full=resolve(root,'assets',tail);
  if(!full.startsWith(resolve(root,'assets')+sep))return reply.code(404).send();
  const data=await readFile(full).catch(()=>null);
  if(!data)return reply.code(404).send();
  return reply.header('Cache-Control','no-store')
    .type(mime[extname(full)]??'application/octet-stream').send(data);
}
try{
  const core=createCoreModule({pool:asSqlPool(pool)});
  const shop='autoin-test-browser-'+randomUUID();
  const password='isolated-browser-'+randomUUID();
  await core.auth.bootstrapOwner({
    shop_id:shop,username:'owner',password,bootstrap_enabled:true
  });
  const login=await core.auth.login(shop,'owner',password);
  const proposal=await core.service.createDraft(login.principal,{
    customer_id:'synthetic-browser-customer',
    conversation_id:'synthetic-browser-conversation',
    request_data:{documents:[{
      artifact_name:'synthetic-unverified.pdf',copies:1,paper:'A4',duplex:false
    }]},
    idempotency_key:'browser-'+randomUUID()
  });
  // A second order has a synthetic server-anchored raster proof, to test
  // REAL authenticated PNG loading in Chrome. This is NOT AI3-render evidence
  // or customer confirmation; AI3 end-to-end is tested separately in PG CI.
  const withPreview=await core.service.createDraft(login.principal,{
    customer_id:'synthetic-preview-customer',
    conversation_id:'synthetic-preview-conversation',
    request_data:{documents:[{artifact_name:'server-fixture-only.png',copies:1,paper:'A4',duplex:false}]},
    idempotency_key:'browser-preview-'+randomUUID()
  });
  const relativeDir='doc-browserpreview123';
  const folder=join(previewRoot,relativeDir);
  await mkdir(folder,{mode:0o700});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==','base64');
  const pageRef=relativeDir+'/page-1.png',manifestRef=relativeDir+'/manifest.json';
  const pngPath=join(previewRoot,pageRef);
  await writeFile(pngPath,png,{mode:0o400});
  const manifest=Buffer.from(JSON.stringify({
    schema:'ai3.document_bridge.v1',request_hash:withPreview.request_hash,
    previews:[{ref:pageRef,sha256:digest(png),bytes:png.length}]
  }));
  await writeFile(join(previewRoot,manifestRef),manifest,{mode:0o400});
  const verifiedPlan={
    request_hash:withPreview.request_hash,physical_sheets:1,document_pages:1,
    printed_faces:1,ready:true,printer_id:'SYNTHETIC_NO_PRINTER',
    artifact_ref:manifestRef,verified_by:'synthetic-browser-hash-fixture'
  };
  await pool.query('UPDATE core_revisions SET plan=$1::jsonb WHERE order_id=$2 AND revision=1',
    [JSON.stringify(verifiedPlan),withPreview.order_id]);
  await pool.query(
    'INSERT INTO ai0_verified_plan_manifests (shop_id,order_id,revision,request_hash,artifact_ref,manifest_sha256) '+
    'VALUES ($1,$2,1,$3,$4,$5)',
    [shop,withPreview.order_id,withPreview.request_hash,manifestRef,digest(manifest)]);
  app=buildIntegratedApp({pool:asSqlPool(pool),previewArtifactRoot:previewRoot});
  app.addHook('onRequest',async request=>{
    if(request.url.startsWith('/api/v1/auth') || request.url.startsWith('/api/v1/orders'))
      console.log('PRODUCT E2E SERVER REQUEST',request.method,request.url.split('?')[0]);
  });
  app.addHook('onResponse',async(request,reply)=>{
    if(request.url.startsWith('/api/v1/auth') || request.url.startsWith('/api/v1/orders'))
      console.log('PRODUCT E2E SERVER RESPONSE',request.method,request.url.split('?')[0],reply.statusCode);
  });
  app.get('/',async(_request,reply)=>reply.type('text/html; charset=utf-8')
    .header('Cache-Control','no-store').send(html));
  app.get('/assets/*',staticAsset);
  app.get('/manifest.webmanifest',async(_request,reply)=>{
    const data=await readFile(resolve(root,'manifest.webmanifest')).catch(()=>null);
    return data?reply.type('application/manifest+json').send(data):reply.code(404).send();
  });
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();
  if(!address||typeof address==='string')throw Error('No localhost server address');
  const url='http://127.0.0.1:'+address.port+'/';
  const env={...process.env,AUTOIN_BROWSER_URL:url,AUTOIN_BROWSER_SHOP:shop,
    AUTOIN_BROWSER_USER:'owner',AUTOIN_BROWSER_PASSWORD:password,
    AUTOIN_BROWSER_ORDER:proposal.order_id,
    AUTOIN_BROWSER_PREVIEW_ORDER:withPreview.order_id};
  const status=await new Promise((resolveStatus,reject)=>{
    const child=spawn('python3',['scripts/browser-product.py'],{
      cwd:process.cwd(),env,stdio:['ignore','inherit','inherit']
    });
    child.on('error',reject);
    child.on('close',code=>resolveStatus(code));
  });
  if(status!==0)throw Error('Authenticated real Fastify/PostgreSQL Chromium E2E failed');
  const counts=await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM core_confirmations WHERE order_id=$1) AS confirms,'+
    ' (SELECT COUNT(*)::int FROM core_approvals WHERE order_id=$1) AS approvals,'+
    ' (SELECT COUNT(*)::int FROM core_print_jobs WHERE order_id=$1) AS print_jobs,'+
    ' (SELECT COUNT(*)::int FROM core_deliveries WHERE order_id=$1) AS deliveries',
    [proposal.order_id]);
  const row=counts.rows[0];
  if(!row||row.confirms!==0||row.approvals!==0||row.print_jobs!==0||row.deliveries!==0)
    throw Error('Browser UI performed an unauthorized order/print/delivery mutation');
  console.log('PASS real Fastify/PostgreSQL browser UI; staff session; NO customer approval/print job/delivery');
  // Tamper an already-registered preview without touching the sealed manifest.
  // The very same browser UI must now REFUSE that page on both viewports.
  await writeFile(pngPath,Buffer.from('CORRUPT_AFTER_PUBLISH'));
  const badResult=await new Promise((resolveStatus,reject)=>{
    const child=spawn('python3',['scripts/browser-product.py'],{
      cwd:process.cwd(),
      env:{...env,AUTOIN_BROWSER_EXPECT_TAMPER:'1'},
      stdio:['ignore','inherit','inherit']
    });
    child.on('error',reject);child.on('close',resolveStatus);
  });
  if(badResult!==0)throw Error('Tampered preview browser fail-closed check failed');
  console.log('PASS real browser rejected tampered PNG on desktop and mobile');
}finally{
  if(app)await app.close();
  await pool.end();
  await rm(previewRoot,{recursive:true,force:true});
}
