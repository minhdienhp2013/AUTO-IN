/**
 * AI5 V1-ACCEPTANCE-01: BASELINE real-Core PostgreSQL guard probes, not full V1.
 *
 * AUTOIN_OPERATION_MODE=simulation AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB \
 * TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/autoin_test_v1wp \
 * node --import tsx --test tests/acceptance/v1-word-pdf/core_baseline_pg.mjs
 *
 * Does NOT prove native DOCX, print-agent, OA, AI2 image routing, source bytes
 * or preview digest binding: those require AI0's new combined candidate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {asSqlPool, assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';

const url=process.env.TEST_DATABASE_URL;
const ready=Boolean(url);
const key=()=>randomUUID();
const hash=value=>createHash('sha256').update(value).digest('hex');
const expectCode=code=>error=>error?.code===code;
const isolated=()=>{
  assert.equal(process.env.AUTOIN_OPERATION_MODE,'simulation');
  assert.equal(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE,'YES_ISOLATED_TEST_DB');
  assert.ok(url && /^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:\d+\/autoin_test_[a-z0-9_]+$/.test(url),
    'Only localhost DB explicitly named autoin_test_* is permitted');
  assertIsolatedSimulationDatabase(url);
};

test('V1 Core baseline: source/settings invalidate old confirmation, idempotency and staff boundaries',{
  skip:!ready?'NOT RUN: isolated TEST_DATABASE_URL required':false,
  timeout:180_000
},async()=>{
  isolated();
  const pool=new pg.Pool({connectionString:url,max:6,connectionTimeoutMillis:5000});
  const sql=asSqlPool(pool);
  const core=createCoreModule({pool:sql});
  const shop='autoin_test_v1wp_'+key(),password='fixture-v1-'+key();
  const accepted=[],guards=[];
  let approvedJobs=0;
  const report={schema:'autoin.v1.word_pdf.core_baseline.v1',
    source:'isolated_synthetic_core_only',
    candidate_verified:false,status:'NOT_RUN',cases:{},
    not_run:['V1-001_full_word_pdf','V1-002_word_native','V1-014_agent_unknown_no_retry',
      'V1-015_ai_failure_end_to_end','V1-016_network_failure_end_to_end',
      'V1-017_image_ingress_routing','V1-018_cccd','V1-019_color',
      'V1-020_excel','V1-021_zip','V1-022_word_layout','V1-023_pdf_preflight',
      'V1-024_inbound_approval_race'],unexpected_print_jobs:null};
  const set=(id,value)=>{report.cases[id]=value;};
  try{
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const owner=(await core.auth.login(shop,'owner',password)).principal;
    // Staff is a persisted server login, not an untrusted role passed in the request.
    const staffId=key();
    await pool.query(
      "INSERT INTO core_users(id,shop_id,username,password_hash,role) "+
      "SELECT $1,$2,'staff',password_hash,'staff' FROM core_users WHERE shop_id=$2 AND username='owner'",
      [staffId,shop]);
    const staff=(await core.auth.login(shop,'staff',password)).principal;
    assert.equal(staff.role,'staff');

    const total=async()=>{
      if(!accepted.length)return {orders:0,confirmations:0,approvals:0,print_jobs:0};
      const r=(await pool.query(
        'SELECT (SELECT count(*)::int FROM core_orders WHERE id=ANY($1::uuid[])) orders,'+
        '(SELECT count(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) confirmations,'+
        '(SELECT count(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) approvals,'+
        '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) print_jobs',
        [accepted])).rows[0];
      return r;
    };
    const draft=async(label,format='pdf',settings={copies:1,paper:'A4',duplex:false})=>{
      const data={documents:[{kind:format,source_sha256:hash('PUBLIC-V1-'+label)}],
        print_settings:settings,synthetic_only:true};
      const result=await core.service.createDraft(staff,{customer_id:'fixture-'+label,
        conversation_id:'conv-'+label,idempotency_key:'draft-'+key(),request_data:data});
      accepted.push(result.order_id);
      return {result,data};
    };
    const processor={id:'synthetic-processor',shop_id:shop,role:'processor',verified:true};
    async function staleOnMutation(label,format,newData){
      const {result:initial,data}=await draft(label,format);
      const plan={request_hash:initial.request_hash,physical_sheets:1,document_pages:1,
        printed_faces:1,ready:true,printer_id:'test-only-no-driver',
        artifact_ref:'synthetic-no-paper',verified_by:processor.id};
      const publication=await core.service.publishVerifiedPlan(processor,initial.order_id,{
        expected_revision:1,plan,idempotency_key:key()});
      assert.equal(publication.revision,2);
      // This is a verified-channel FIXTURE principal, NOT provider OA evidence.
      const customer={id:'synthetic-fixture-'+label,shop_id:shop,role:'customer',
        customer_id:'fixture-'+label,verified:true};
      await core.service.confirm(customer,initial.order_id,{expected_revision:2,
        kind:'request',idempotency_key:key()});
      const changed=await core.service.revise(staff,initial.order_id,{
        expected_revision:2,request_data:newData(data),idempotency_key:key()});
      assert.equal(changed.revision,3);
      assert.notEqual(changed.request_hash,initial.request_hash);
      assert.equal(changed.requires_reconfirmation,true);
      await assert.rejects(core.service.confirm(customer,initial.order_id,{
        expected_revision:2,kind:'request',idempotency_key:key()}),expectCode('STALE_REVISION'));
      await assert.rejects(core.service.approve(staff,initial.order_id,{
        expected_revision:2,acknowledge_deposit_shortage:true,
        idempotency_key:key()}),expectCode('STALE_REVISION'));
      const current=(await pool.query(
        'SELECT active_revision FROM core_orders WHERE id=$1',[initial.order_id])).rows[0];
      assert.equal(current.active_revision,3);
      set(label,'PASS_CORE_REVISION_GUARD_ONLY');
    }
    await staleOnMutation('V1-003','pdf',data=>({...data,documents:[
      {...data.documents[0],source_sha256:hash('REPLACED-PDF-SYNTHETIC')}]}));
    await staleOnMutation('V1-004','docx',data=>({...data,documents:[
      {...data.documents[0],source_sha256:hash('REPLACED-DOCX-SYNTHETIC')}]}));
    await staleOnMutation('V1-005','pdf',data=>({...data,
      print_settings:{...data.print_settings,copies:2}}));
    await staleOnMutation('V1-006','pdf',data=>({...data,
      print_settings:{...data.print_settings,duplex:true,flip:'short_edge'}}));
    await staleOnMutation('V1-007','docx',data=>({...data,
      print_settings:{...data.print_settings,paper:'A3',orientation:'landscape'}}));

    const duplicateData={documents:[{source_sha256:hash('V1-DUPLICATE')}],
      print_settings:{copies:1,paper:'A4'},synthetic_only:true};
    const sameKey='same-submit-'+key();
    const payload={customer_id:'fixture-duplicate',conversation_id:'conv-duplicate',
      request_data:duplicateData,idempotency_key:sameKey};
    const one=await core.service.createDraft(staff,payload);accepted.push(one.order_id);
    const replay=await core.service.createDraft(staff,payload);
    assert.deepEqual(one,replay,'Lost ACK replay must return same persisted draft');
    await assert.rejects(core.service.createDraft(staff,{
      ...payload,request_data:{...duplicateData,print_settings:{copies:2,paper:'A4'}}
    }),expectCode('IDEMPOTENCY_CONFLICT'));
    assert.equal((await pool.query('SELECT count(*)::int n FROM core_orders WHERE id=$1',
      [one.order_id])).rows[0].n,1);
    set('V1-012','PASS_SINGLE_CORE_ORDER');
    set('V1-013','PASS_CONFLICT_NO_SECOND_ORDER');

    const unauthorized={...staff,role:'customer',customer_id:'fixture'};
    await assert.rejects(core.service.approve(unauthorized,one.order_id,{
      expected_revision:1,acknowledge_deposit_shortage:true,idempotency_key:key()
    }),expectCode('FORBIDDEN'));
    await assert.rejects(core.service.approve({...staff,verified:false},one.order_id,{
      expected_revision:1,acknowledge_deposit_shortage:true,idempotency_key:key()
    }),expectCode('UNAUTHENTICATED'));
    const other={...staff,shop_id:'other-shop-v1-synthetic'};
    await assert.rejects(core.service.revise(other,one.order_id,{
      expected_revision:1,request_data:duplicateData,idempotency_key:key()
    }),expectCode('FORBIDDEN'));
    set('V1-010','PASS_CROSS_SHOP_CORE_GUARD');
    set('V1-011','PASS_UNVERIFIED_AND_CUSTOMER_DENIED');

    // Staff has a server-issued session and may retain an unsupported image
    // by manual-locking the Core order. AI2 image routing itself is NOT tested.
    const image=await draft('manual-image','png');
    const manual=await core.service.manual(staff,image.result.order_id,{
      expected_revision:1,reason:'synthetic-image-await-staff',idempotency_key:key()});
    assert.equal(manual.manual_lock,true);
    set('V1-017','PASS_CORE_MANUAL_ONLY_AI2_ROUTE_NOT_RUN');

    // Simulate a failure AFTER successful Core persistence, not an actual
    // network or LLM outage. This verifies a narrower DB durability property.
    const retained=await draft('retained-ai-fail','docx');
    try{throw new Error('SYNTHETIC_AI_UNAVAILABLE')}catch(e){
      assert.equal(e.message,'SYNTHETIC_AI_UNAVAILABLE');
    }
    const saved=(await pool.query('SELECT id FROM core_orders WHERE id=$1',
      [retained.result.order_id])).rows;
    assert.equal(saved.length,1);
    set('V1-015','PASS_CORE_PERSISTENCE_ONLY_AI_INTEGRATION_NOT_RUN');

    guards.push(await total());
    approvedJobs=guards.at(-1).print_jobs;
    assert.equal(approvedJobs,0,'No print job allowed in these unapproved cases');
    report.unexpected_print_jobs=approvedJobs;
    report.status='CORE_BASELINE_PASS_NOT_V1_ACCEPTED';
  }finally{
    await pool.end();
    console.log('V1_CORE_BASELINE_JSON '+JSON.stringify(report));
  }
});
