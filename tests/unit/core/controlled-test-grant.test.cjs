const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {issueControlledTestGrant,revokeControlledTestGrant}=require(path.join(root,'core/controlled-test-grant.js'));

const shop='shop-a',order='00000000-0000-4000-8000-000000000001';
const owner='00000000-0000-4000-8000-000000000002',printer='RMP7000';
const request={shop_id:shop,order_id:order,printer_id:printer,owner_id:owner,ttl_seconds:1800,ticket_ref:'OPS-123'};

function fixture({operator='autoin_controlled_operator',ownerRole='owner',ownerActive=true,
  mode='simulation',printingEnabled=false,active=[],auditFail=false,remaining=[],revokeFound=true}={}){
 const calls=[];
 const client={release(){},async query(sql,args=[]){
  calls.push({sql,args});
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],rowCount:null};
  if(sql.startsWith('SELECT session_user::text'))return {rows:[{operator_role:operator}],rowCount:1};
  if(sql.includes('FROM core_shop_settings ss JOIN core_orders')&&sql.includes('JOIN core_revisions'))
   return {rows:[{shop_id:shop,mode,printing_enabled:printingEnabled,order_id:order,active_revision:1,
    manual_lock:false,print_closed:false,owner_id:owner,owner_role:ownerRole,owner_active:ownerActive}],rowCount:1};
  if(sql.startsWith('SELECT order_id,printer_id FROM core_print_controlled_test_scopes'))
   return {rows:active,rowCount:active.length};
  if(sql.startsWith("UPDATE core_shop_settings SET mode='controlled_test'"))
   return {rows:[{shop_id:shop}],rowCount:1};
  if(sql.startsWith('WITH issue_clock AS'))
   return {rows:[{shop_id:shop,order_id:order,printer_id:printer,expires_at:'2026-10-24T04:30:00.000Z'}],rowCount:1};
  if(sql.startsWith('SELECT ss.shop_id,o.id AS order_id,ss.mode'))
   return {rows:[{shop_id:shop,order_id:order,mode:'controlled_test'}],rowCount:1};
  if(sql.startsWith('UPDATE core_print_controlled_test_scopes'))
   return revokeFound?{rows:[{configured_by:owner}],rowCount:1}:{rows:[],rowCount:0};
  if(sql.startsWith('SELECT order_id FROM core_print_controlled_test_scopes'))
   return {rows:remaining,rowCount:remaining.length};
  if(sql.startsWith("UPDATE core_shop_settings SET mode='simulation'"))
   return {rows:[{shop_id:shop}],rowCount:1};
  if(sql.startsWith('INSERT INTO core_audit'))
   return {rows:[],rowCount:auditFail?0:1};
  throw new Error(`unexpected query: ${sql}`);
 }};
 const store=new PgStore({connect:async()=>client,query:client.query.bind(client)});
 return {store,calls};
}

test('grant is one DB-clock-limited transaction with exact owner, mode and audit',async()=>{
 const f=fixture();
 const result=await issueControlledTestGrant(f.store,request,'autoin_controlled_operator');
 assert.equal(result.order_id,order);assert.equal(result.printer_id,printer);
 const begin=f.calls.findIndex(x=>x.sql==='BEGIN'),commit=f.calls.findIndex(x=>x.sql==='COMMIT');
 const mode=f.calls.findIndex(x=>x.sql.startsWith("UPDATE core_shop_settings SET mode='controlled_test'"));
 const grant=f.calls.findIndex(x=>x.sql.startsWith('WITH issue_clock AS'));
 const audit=f.calls.findIndex(x=>x.sql.startsWith('INSERT INTO core_audit'));
 assert.ok(begin<mode&&mode<grant&&grant<audit&&audit<commit);
 assert.match(f.calls[grant].sql,/clock_timestamp\(\)/);
 assert.equal(f.calls[grant].args[3],owner);assert.equal(f.calls[grant].args[4],1800);
 assert.equal(f.calls[audit].args[2],owner);
 assert.equal(f.calls[audit].args[3],'controlled_test.scope.granted');
 assert.match(f.calls[audit].args[5],/OPS-123/);
 assert.match(f.calls[audit].args[5],/autoin_controlled_operator/);
});

test('grant rejects over-30-minute TTL before opening a transaction',async()=>{
 const f=fixture();
 await assert.rejects(issueControlledTestGrant(f.store,{...request,ttl_seconds:1801},'autoin_controlled_operator'),
  error=>error.code==='CONTROLLED_TEST_GRANT_INPUT_INVALID');
 assert.deepEqual(f.calls,[]);
});

test('grant requires the dedicated database operator role',async()=>{
 const f=fixture({operator:'generic_app'});
 await assert.rejects(issueControlledTestGrant(f.store,request,'autoin_controlled_operator'),
  error=>error.code==='CONTROLLED_TEST_OPERATOR_ROLE_MISMATCH');
 assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
 assert.ok(!f.calls.some(x=>x.sql.startsWith("UPDATE core_shop_settings SET mode='controlled_test'")));
});

test('grant fails closed for non-owner and an already active grant',async()=>{
 const wrongOwner=fixture({ownerRole:'staff'});
 await assert.rejects(issueControlledTestGrant(wrongOwner.store,request,'autoin_controlled_operator'),
  error=>error.code==='CONTROLLED_TEST_GRANT_SCOPE_REQUIRED');
 assert.ok(!wrongOwner.calls.some(x=>x.sql.startsWith("UPDATE core_shop_settings SET mode='controlled_test'")));
 const active=fixture({active:[{order_id:order,printer_id:printer}]});
 await assert.rejects(issueControlledTestGrant(active.store,request,'autoin_controlled_operator'),
  error=>error.code==='CONTROLLED_TEST_GRANT_ALREADY_ACTIVE');
 assert.ok(!active.calls.some(x=>x.sql.startsWith("UPDATE core_shop_settings SET mode='controlled_test'")));
});

test('grant rolls back shop mode and scope when audit insert fails',async()=>{
 const f=fixture({auditFail:true});
 await assert.rejects(issueControlledTestGrant(f.store,request,'autoin_controlled_operator'),
  error=>error.code==='CONTROLLED_TEST_AUDIT_FAILED');
 assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
 assert.ok(!f.calls.some(x=>x.sql==='COMMIT'));
});

test('operator revoke disables exact scope and audits before commit',async()=>{
 const f=fixture();
 await revokeControlledTestGrant(f.store,{shop_id:shop,order_id:order,printer_id:printer,ticket_ref:'OPS-124'},
  'autoin_controlled_operator');
 const revoke=f.calls.findIndex(x=>x.sql.startsWith('UPDATE core_print_controlled_test_scopes'));
 const safe=f.calls.findIndex(x=>x.sql.startsWith("UPDATE core_shop_settings SET mode='simulation'"));
 const audit=f.calls.findIndex(x=>x.sql.startsWith('INSERT INTO core_audit'));
 const commit=f.calls.findIndex(x=>x.sql==='COMMIT');
 assert.ok(revoke<safe&&safe<audit&&audit<commit);
 assert.equal(f.calls[audit].args[2],'autoin_controlled_operator');
 assert.equal(f.calls[audit].args[3],'controlled_test.scope.revoked');
});
