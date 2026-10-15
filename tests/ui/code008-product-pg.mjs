/**
 * AI4 CODE-008: real compiled React + Fastify + isolated PostgreSQL Chromium E2E.
 * No API interception, no debug product endpoint, no customer/OA/printer contact.
 * AI0 owns CI integration; run after DB migration + VITE_DEMO_MODE=false build.
 *
 * TEST_DATABASE_URL must identify an isolated localhost autoin_test* database.
 * Preconditions: AUTOIN_OPERATION_MODE=simulation and Playwright + Chromium.
 * This test intentionally seeds synthetic-only staff/OA evidence BEFORE its
 * mutation baseline. It NEVER confirms/approves/prints an order.
 */
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import pg from 'pg';
import {createCoreModule} from '../../backend/core/factory.ts';
import {createAiOrderPort} from '../../backend/core/ai-order-port.ts';
import {createVerifiedConfirmationPort} from '../../backend/core/verified-confirmation-port.ts';
import {buildIntegratedApp} from '../../backend/composition/runtime.ts';
import {createSyntheticZaloIngress} from '../../backend/composition/zalo-simulation.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw Error('NOT RUN: TEST_DATABASE_URL is required');
assertIsolatedSimulationDatabase(url);
if(process.env.AUTOIN_OPERATION_MODE!=='simulation')
  throw Error('NOT RUN: AUTOIN_OPERATION_MODE=simulation required');
if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
  throw Error('NOT RUN: isolated PostgreSQL acceptance opt-in missing');
const dist=resolve('web/dist');
const html=await readFile(resolve(dist,'index.html'),'utf8');
if(!(await stat('web/package-lock.json')).isFile()||!html.includes('/assets/'))
  throw Error('NOT RUN: genuine web/dist production bundle and lockfile required');

const extraOnly=process.env.AUTOIN_CODE008_EXTRA_ONLY==='YES';
const browserRead503Only=process.env.AUTOIN_CODE008_BROWSER_503_ONLY==='YES';
if(extraOnly&&browserRead503Only)throw Error('Choose one CODE008 opt-in suite');
const pool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000,
  ...((extraOnly||browserRead503Only)?{options:'-c lock_timeout=500ms'}:{})});
const id=randomUUID();
const shop='autoin-test-code008-browser-'+id;
const oa='synthetic-oa-'+id;
const password='synthetic-only-'+randomUUID();
const customer='synthetic-customer-'+id;
const initial='synthetic-initial-'+id;
const extra='synthetic-extra-'+id;
const convo='synthetic-chat-'+id;
const fixtureKey=randomUUID()+randomUUID();
const mime={'.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml',
  '.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
let app;
const counts=async orderIds=>{
  const q=await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) AS confirmations,'+
    ' (SELECT COUNT(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) AS approvals,'+
    ' (SELECT COUNT(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) AS print_jobs',
    [orderIds]);
  return q.rows[0];
};
const ensure=(ok,label)=>{if(!ok)throw Error('FAIL REAL PG fixture: '+label)};
try{
  const core=createCoreModule({pool:asSqlPool(pool)});
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
    password,bootstrap_enabled:true});
  const actor=(await core.auth.login(shop,'owner',password)).principal;
  const staff=(customerId,conversationId)=>core.service.createDraft(actor,{
    customer_id:customerId,...(conversationId?{conversation_id:conversationId}:{}),
    request_data:{documents:[],source:'synthetic_browser_fixture'},
    idempotency_key:'staff-'+randomUUID()
  });
  const processing0=await staff(customer+'-processing');
  const clear=await staff(customer+'-clear');
  const human0=await staff(customer+'-human','unbound-chat-'+id);
  const plan={
    request_hash:clear.request_hash,physical_sheets:1,document_pages:1,
    printed_faces:1,ready:true,printer_id:'SYNTHETIC_NO_PRINTER',
    artifact_ref:'synthetic/browser-only-no-physical-artifact',
    verified_by:'test-processor-not-real-document-evidence'
  };
  await core.service.publishVerifiedPlan({
    id:'synthetic-test-processor',shop_id:shop,role:'processor',verified:true
  },clear.order_id,{expected_revision:1,plan,idempotency_key:'plan-'+randomUUID()});

  // Exercise the real ingress/AI1 Port into real PostgreSQL. Only the
  // test-local synthetic verifier is configured. No provider webhook or OA.
  app=buildIntegratedApp({
    pool:asSqlPool(pool),zaloWebhook:createSyntheticZaloIngress(pool,{
      kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:fixtureKey
    })
  });

  // One origin: compiled React assets and actual Fastify business routes.
  app.get('/',async(_r,reply)=>reply.type('text/html; charset=utf-8')
    .header('Cache-Control','no-store').send(html));
  app.get('/assets/*',async(request,reply)=>{
    const tail=request.params?.['*'];
    if(typeof tail!=='string'||!tail||!/^[a-zA-Z0-9._/-]+$/.test(tail)||
       tail.split('/').some(x=>!x||x==='.'||x==='..'))return reply.code(404).send();
    const path=resolve(dist,'assets',tail);
    if(!path.startsWith(resolve(dist,'assets')+sep))return reply.code(404).send();
    const content=await readFile(path).catch(()=>null);
    return content?reply.header('Cache-Control','no-store')
      .type(mime[extname(path)]||'application/octet-stream').send(content):reply.code(404).send();
  });
  let mutationRequests=0;
  // Passive Node HTTP observation is not a mock/intercept and covers routes
  // registered earlier by buildIntegratedApp. Never supply a response here.
  app.server.on('request',request=>{
    const path=request.url?.split('?')[0]??'';
    if(path.startsWith('/api/v1/')&&
      !['GET','HEAD','OPTIONS'].includes(request.method??'')&&
      !(path==='/api/v1/auth/login'&&request.method==='POST'))
      mutationRequests++;
  });
  const event=(eventId,kind='text')=>({
    synthetic_fixture:true,event_id:eventId,oa_id:oa,
    customer_id:customer,conversation_id:convo,
    occurred_at:new Date().toISOString(),kind,
    ...(kind==='text'?{text:'Synthetic request'}:
      {filename:'synthetic-extra.png',file_ref:'SYNTHETIC_NO_CUSTOMER_FILE'})
  });
  const send=async(evt)=>{
    const r=await app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':fixtureKey},
      payload:JSON.stringify(evt)});
    ensure(r.statusCode===200,'synthetic signed ingress rejected');
    ensure(['accepted','duplicate'].includes(r.json().status),'synthetic ingress not accepted');
  };
  await send(event(initial));
  const port=createAiOrderPort({store:core.store,trusted:{shop_id:shop,oa_id:oa}});
  const proposal=await port.suggest_draft({
    conversation_id:convo,customer_id:customer,event_ids:[initial],
    text:'Synthetic request',expected_generation:0,idempotency_key:'draft-'+randomUUID()
  });
  ensure(proposal.status==='created','trusted AI1 synthetic draft');
  const pendingId=proposal.order_id;
  await send(event(extra,'image'));

  const orders={clear:clear.order_id,processing0:processing0.order_id,
    needs_human0:human0.order_id,pending1:pendingId,stale_revision:clear.order_id};
  const scenarios=[
    ['clear','clear',0],['processing0','processing',0],
    ['needs_human0','needs_human',0],['pending1','processing',1]
  ];
  for(const [name,status,count] of scenarios){
    const detail=await core.service.getOrder(actor,orders[name]);
    const got=detail.current.pending_updates;
    ensure(got.status===status && got.unresolved_count===count,
      name+' expected '+status+'('+count+'), got '+got.status+'('+got.unresolved_count+')');
    ensure(got.order_id===detail.order.id && got.revision===detail.order.active_revision &&
      got.request_hash===detail.current.request_hash,name+' must be server-scoped');
    if(name==='pending1')ensure(got.items.length===1 && got.items[0].kind==='file',
      'unreconciled inbound must preserve safe metadata');
  }
  const orderIds=[...new Set(Object.values(orders))];
  const before=await counts(orderIds);
  ensure(before.confirmations===0 && before.approvals===0 && before.print_jobs===0,
    'baseline must not contain approval/print/confirmation');

  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();
  if(!address||typeof address==='string')throw Error('Fastify did not bind localhost');
  const pageUrl='http://127.0.0.1:'+address.port+'/';
  if(browserRead503Only){
    // The old 14 Chromium cases are intentionally NOT invoked by this mode.
    // Chromium drives the real product UI, and a second PG connection induces
    // a bounded SQL 55P03 on the authenticated order-detail GET.
    const env={...process.env,AUTOIN_CODE008_URL:pageUrl,
      AUTOIN_CODE008_SHOP:shop,AUTOIN_CODE008_USER:'owner',
      AUTOIN_CODE008_PASSWORD:password,
      AUTOIN_CODE008_ORDERS:JSON.stringify(orders),
      AUTOIN_CODE008_BROWSER_MODE:'order_detail_503'};
    let lockClient=null;
    let inTransaction=false;
    try{
      const status=await new Promise((done,fail)=>{
        const child=spawn('python3',['tests/ui/code008-product-browser.py'],{
          cwd:process.cwd(),env,stdio:['pipe','pipe','inherit']
        });
        let remainder='',closed=false,serial=Promise.resolve();
        const abort=error=>{
          if(closed)return;
          closed=true;
          child.kill();
          fail(error);
        };
        const release=async()=>{
          if(!lockClient)return;
          const client=lockClient;
          lockClient=null;
          try{
            if(inTransaction)await client.query('ROLLBACK');
          }finally{
            inTransaction=false;
            client.release();
          }
        };
        const control=async line=>{
          if(line==='CONTROL LOCK_ORDER_DETAIL'){
            ensure(lockClient===null,'duplicate PostgreSQL lock request');
            lockClient=await pool.connect();
            try{
              await lockClient.query('BEGIN');
              inTransaction=true;
              await lockClient.query(
                'LOCK TABLE public.core_ai_draft_proposals IN ACCESS EXCLUSIVE MODE');
              child.stdin.write('OK\n');
            }catch(error){
              await release();
              throw error;
            }
          }else if(line==='CONTROL RELEASE_ORDER_DETAIL'){
            ensure(lockClient!==null,'unexpected unlock request');
            await release();
            child.stdin.write('OK\n');
          }else if(line)console.log(line);
        };
        child.stdout.setEncoding('utf8');
        child.stdout.on('data',chunk=>{
          remainder+=chunk;
          while(remainder.includes('\n')){
            const at=remainder.indexOf('\n');
            const line=remainder.slice(0,at).trimEnd();
            remainder=remainder.slice(at+1);
            serial=serial.then(()=>control(line)).catch(abort);
          }
        });
        child.on('error',abort);
        child.on('close',code=>{
          void serial.then(async()=>{
            try{
              // Also restore after browser failure, unexpected exit or timeout.
              await release();
              if(!closed){closed=true;done(code);}
            }catch(error){abort(error);}
          });
        });
      });
      const after=await counts(orderIds);
      console.log('CODE008 REAL BROWSER503 counts_before='+JSON.stringify(before)+
        ' counts_after='+JSON.stringify(after)+
        ' business_mutation_requests='+mutationRequests);
      ensure(JSON.stringify(after)===JSON.stringify(before),
        'browser GET503 mutated confirmation/approval/print-job tables');
      ensure(mutationRequests===0,'browser GET503 sent a business mutation request');
      ensure(status===0,'real Chromium order-detail 503 test failed');
      console.log('PASS REAL CODE008 BROWSER503 Fastify/PostgreSQL 1440x900+390x844; '+
        'GET order detail=503 PENDING_READ_UNAVAILABLE, recovery=200, mutation=0');
    }finally{
      // No managed transaction survives the child session. Dedicated test DB
      // is discarded by AI0 CI independently of this process.
    }
  }else if (extraOnly) {
    // Runs INSTEAD OF the already-proved 14 Chromium cases. All requests use
    // genuine authenticated Fastify handlers; no route interception or fake
    // HTTP responses. Test setup happens before each immutable snapshot.
    const session=(await core.auth.login(shop,'owner',password)).token;
    const headers={authorization:'Bearer '+session};
    const get=async(path,code,errorCode)=>{
      const reply=await app.inject({method:'GET',url:path,headers});
      ensure(reply.statusCode===code,path+' expected HTTP '+code+', got '+reply.statusCode);
      const body=reply.json();
      if(errorCode)ensure(body?.error?.code===errorCode,
        path+' expected error.code='+errorCode+', got '+body?.error?.code);
      console.log('PASS REAL CODE008 EXTRA GET '+path+' HTTP='+code+
        (errorCode?' error.code='+errorCode:''));
      return body;
    };
    const extraBefore=await counts(orderIds);
    const challengeCount=async()=>(await pool.query(
      'SELECT count(*)::int AS n FROM core_confirmation_challenges WHERE order_id=$1',
      [pendingId])).rows[0].n;
    const challengesBefore=await challengeCount();

    // 409 is a genuine GET /runtime-status boundary, NOT GET /orders/:id
    // (which has no expected revision/hash query contract).
    await pool.query("UPDATE core_shop_settings SET mode='safe' WHERE shop_id=$1",[shop]);
    try{
      await get('/api/v1/runtime-status',409,'SIMULATION_REQUIRED');
    }finally{
      await pool.query("UPDATE core_shop_settings SET mode='simulation' WHERE shop_id=$1",[shop]);
    }
    await get('/api/v1/runtime-status',200);

    // This existing preview route has no configured artifact root; it is a
    // genuine FEATURE_UNAVAILABLE GET503, not a Core provenance failure.
    await get('/api/v1/orders/'+processing0.order_id+'/revisions/1/previews',
      503,'FEATURE_UNAVAILABLE');

    // Induce an actual Core order-detail read timeout via a separate PG
    // connection locking ONLY this disposable test database. The app pool's
    // test-only lock_timeout bounds the wait; rollback is mandatory.
    const blocker=await pool.connect();
    try{
      await blocker.query('BEGIN');
      try{
        await blocker.query('LOCK TABLE public.core_ai_draft_proposals IN ACCESS EXCLUSIVE MODE');
        await get('/api/v1/orders/'+processing0.order_id,503,'PENDING_READ_UNAVAILABLE');
      }finally{
        await blocker.query('ROLLBACK');
      }
    }finally{
      blocker.release();
    }
    await get('/api/v1/orders/'+processing0.order_id,200);

    // Advance the EXISTING verified synthetic OA-bound draft with the actual
    // OrderService Port, preserving verified event_ids. No fake hash edits.
    const previous=await core.service.getOrder(actor,pendingId);
    const oldRevision=previous.order.active_revision;
    const oldHash=previous.current.request_hash;
    const source=previous.revisions.find(x=>x.revision===oldRevision)?.request_data;
    ensure(source&&!Array.isArray(source)&&typeof source==='object',
      'source revision request_data absent');
    const revised=await core.service.revise(actor,pendingId,{
      expected_revision:oldRevision,
      request_data:{...source,code008_hash_fixture:'changed-'+id},
      idempotency_key:'real-hash-revision-'+randomUUID()
    });
    ensure(revised.revision===oldRevision+1&&revised.request_hash!==oldHash,
      'real Core revision must change request_hash');
    const confirm=createVerifiedConfirmationPort({
      store:core.store,trusted:{shop_id:shop,oa_id:oa}
    });
    const target={order_id:pendingId,kind:'request',expected_generation:0};
    const oldRevisionChallenge=await confirm.issue_challenge({
      ...target,expected_revision:oldRevision,request_hash:oldHash
    });
    const oldHashChallenge=await confirm.issue_challenge({
      ...target,expected_revision:revised.revision,request_hash:oldHash
    });
    ensure(oldRevisionChallenge.status==='stale'&&oldHashChallenge.status==='stale',
      'old revision/hash must never mint challenge or customer confirmation');
    const latest=await get('/api/v1/orders/'+pendingId,200);
    ensure(latest.current?.revision===revised.revision&&
      latest.current?.request_hash===revised.request_hash&&
      latest.current?.pending_updates?.request_hash===revised.request_hash,
      'genuine GET must return only server current revision/hash scope');
    ensure(!latest.current.request_confirmed&&!latest.current.staff_approved,
      'stale request_hash must not confirm or approve');
    const challengesAfter=await challengeCount();
    ensure(challengesBefore===challengesAfter,
      'old revision/hash minted confirmation challenge unexpectedly');
    const extraAfter=await counts(orderIds);
    ensure(JSON.stringify(extraAfter)===JSON.stringify(extraBefore),
      'extra GET/stale-hash tests changed confirmation/approval/print-job rows');
    ensure(mutationRequests===0,'extra read-only HTTP generated business mutation');
    console.log('PASS REAL CODE008 EXTRA stale-request-hash revision='+
      oldRevision+'->'+revised.revision+' hash_changed=true challenge_status=stale');
    console.log('PASS REAL CODE008 EXTRA counts_before='+JSON.stringify(extraBefore)+
      ' counts_after='+JSON.stringify(extraAfter)+
      ' challenge_counts='+challengesBefore+'/'+challengesAfter+
      ' business_mutation_requests='+mutationRequests);
    console.log('NOT_RUN: browser UI GET-order-detail HTTP409 has no AI1 contract; '+
      'sealed-artifact stale preview GET409 fixture not supplied; Safari iPhone 10/10');
  } else {
  const env={...process.env,AUTOIN_CODE008_URL:pageUrl,
    AUTOIN_CODE008_SHOP:shop,AUTOIN_CODE008_USER:'owner',
    AUTOIN_CODE008_PASSWORD:password,
    AUTOIN_CODE008_ORDERS:JSON.stringify(orders)};
  const status=await new Promise((resolveStatus,reject)=>{
    const child=spawn('python3',['tests/ui/code008-product-browser.py'],{
      cwd:process.cwd(),env,stdio:['pipe','pipe','inherit']
    });
    let rest='',closed=false;
    const handle=async line=>{
      if(line==='CONTROL REVOKE_SESSIONS'){
        await pool.query('UPDATE core_sessions SET revoked_at=now() WHERE user_id IN '+
          '(SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
        child.stdin.write('OK\n');
      }else if(line)console.log(line);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      rest+=chunk;
      while(rest.includes('\n')){
        const at=rest.indexOf('\n'),line=rest.slice(0,at).trimEnd();
        rest=rest.slice(at+1);
        void handle(line).catch(e=>{
          if(!closed){closed=true;child.kill();reject(e);}
        });
      }
    });
    child.on('error',reject);
    child.on('close',code=>{if(!closed){closed=true;resolveStatus(code);}});
  });
  const after=await counts(orderIds);
  console.log('CODE008 REAL PG counts_before='+JSON.stringify(before)+
    ' counts_after='+JSON.stringify(after)+' business_mutation_requests='+mutationRequests);
  ensure(JSON.stringify(after)===JSON.stringify(before),
    'customer confirmation, staff approval or print-job count changed');
  ensure(mutationRequests===0,'browser sent unexpected business mutation');
  if(status!==0)throw Error('FAIL: real Fastify/PostgreSQL Chromium test did not pass');
  console.log('PASS CODE008 Fastify+isolated PG browser scope; no business mutation');
  console.log('NOT_RUN: extra 409/503/stale-hash tests require AUTOIN_CODE008_EXTRA_ONLY=YES; '+
    'physical Safari/OA/Ricoh');
  }
}finally{
  if(app)await app.close();
  await pool.end();
}
