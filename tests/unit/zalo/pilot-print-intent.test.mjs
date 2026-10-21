import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractPilotPrintIntent} from '../../../backend/conversation/pilot-print-intent.ts';
import {createOfficialZaloWebhookAdapter} from '../../../backend/integrations/zalo/official-webhook.ts';
import {createOfficialZaloVerifiedIngress} from '../../../backend/integrations/zalo/official-quarantine.ts';

const now=Date.parse('2026-10-21T03:00:00Z');
const config={app_id:'app-test',oa_id:'oa-test',oa_secret_key:'synthetic-secret-not-live',
  now:()=>now,resolve_verified_user:id=>id==='sender-test'?
    {customer_id:'customer-test',conversation_id:'chat-test'}:null};
const payload=(event_name,message)=>({app_id:config.app_id,recipient:{id:config.oa_id},
  sender:{id:'sender-test'},event_name,timestamp:now,message});
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const signed=bytes=>({'x-zevent-signature':'mac='+createHash('sha256')
  .update(config.app_id).update(bytes).update(String(now)).update(config.oa_secret_key).digest('hex')});
const event=(id,text)=>({event_id:id,oa_id:'oa-test',customer_id:'customer-test',
  conversation_id:'chat-test',occurred_at:new Date(now).toISOString(),kind:'text',text});

test('signed, server-mapped OA text yields a candidate only; no automatic authority',async()=>{
  const raw=encode(payload('user_send_text',{
    msg_id:'msg-1',text:'Mã cửa hàng: AB1234. In 2 bản, A4, 2 mặt, đen trắng.'}));
  const {verifier,normalizer}=createOfficialZaloWebhookAdapter(config);
  assert.equal(await verifier.verify(raw,signed(raw)),true);
  const intent=extractPilotPrintIntent([normalizer.normalize(raw)]);
  assert.deepEqual(intent,{
    scope:{oa_id:'oa-test',customer_id:'customer-test',conversation_id:'chat-test'},
    event_ids:['msg-1'],code_candidate:'AB1234',copies:2,paper:'A4',sides:2,
    black_white:true,status:'ready_for_core_validation',reasons:[]
  });
  assert.equal('approved' in intent,false);
  assert.equal('print_job_id' in intent,false);
});

test('code and settings may arrive in separate verified text events, conflicts hold',()=>{
  const ready=extractPilotPrintIntent([
    event('one','Mã: 123456'),event('two','In 1 bản A4 một mặt đen trắng')
  ]);
  assert.equal(ready.status,'ready_for_core_validation');
  assert.deepEqual(ready.event_ids,['one','two']);
  assert.equal(ready.code_candidate,'123456');
  const conflicting=extractPilotPrintIntent([
    ...[event('one','Mã: 123456'),event('two','In 1 bản A4 một mặt đen trắng')],
    event('three','Mã: 987654; 2 bản; hai mặt')
  ]);
  assert.equal(conflicting.status,'needs_clarification');
  assert.ok(conflicting.reasons.includes('CONFLICTING_CODE'));
  assert.ok(conflicting.reasons.includes('CONFLICTING_COPIES'));
  assert.ok(conflicting.reasons.includes('CONFLICTING_SIDES'));
});

test('bare number, absent setting, A3/color, mixed identity never become ready',()=>{
  for(const text of [
    '123456 In 2 bản A4 một mặt đen trắng',
    'Mã: 123456 In 2 bản A4 đen trắng',
    'Mã: 123456 In 2 bản A3 một mặt đen trắng',
    'Mã: 123456 In 2 bản A4 một mặt in màu',
    'Mã: 123456 In 0 bản A4 một mặt đen trắng'
  ])assert.equal(extractPilotPrintIntent([event('one',text)]).status,'needs_clarification');
  assert.equal(extractPilotPrintIntent([event('one','Mã: 123456'),
    {...event('two','In 1 bản A4 một mặt đen trắng'),customer_id:'other'}]),null);
  assert.equal(extractPilotPrintIntent([{...event('file',''),kind:'file',file_ref:'untrusted'}]),null);
});

test('signed PDF-looking OA file remains quarantined until verified bytes exist',async()=>{
  const rows=[],normal=[];
  const tx={async transaction(body){return body({async query(sql,params){
    if(sql.startsWith('INSERT INTO zalo_official_quarantine_scopes'))return {rowCount:1,rows:[]};
    if(sql.startsWith('SELECT oa_id FROM zalo_official_quarantine_scopes'))
      return {rowCount:1,rows:[{oa_id:params[0]}]};
    if(sql.startsWith('INSERT INTO zalo_official_quarantine')){
      rows.push(params);return {rowCount:1,rows:[{id:params[0],status:'NEEDS_HUMAN'}]};
    }
    throw new Error('UNEXPECTED_SQL');
  }})}};
  const ingress=createOfficialZaloVerifiedIngress(config,
    {async insert_once(value){normal.push(value);return 'inserted'}},tx);
  const raw=encode(payload('user_send_file',{msg_id:'file-1',attachments:[
    {type:'file',payload:{name:'looks-like.pdf',url:'https://media.invalid/private.pdf'}}
  ]}));
  const receipt=await ingress.receive_webhook(raw,signed(raw));
  assert.equal(receipt.status_code,200);
  assert.equal(receipt.body.status,'held');
  assert.equal(receipt.body.kind,'file');
  assert.equal(normal.length,0);
  assert.equal(rows.length,1);
  assert.equal(JSON.stringify(rows).includes('media.invalid'),false);
});
