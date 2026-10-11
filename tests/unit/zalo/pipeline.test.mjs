import test from 'node:test';
import assert from 'node:assert/strict';
import {createZaloPipeline} from '../../../backend/integrations/zalo/pipeline.ts';
import {SyntheticFixtureNormalizer,SyntheticTestVerifier} from '../../../backend/integrations/zalo/protocol.ts';

const requirements={
  trusted_shop_id:'shop-from-authenticated-config',
  documents:{async inspect(){return []}},
  orders:{async suggest_draft(){throw Error('unexpected draft')},async route_human(){throw Error('unexpected route')}},
  schedule:{allowed:()=>true},clock:{now:()=>new Date('2026-10-11T03:00:00Z')}
};
function fakeDb(){
  const inbound=new Map(),outbound=new Map(),sqlLog=[];
  let generation='2',status='AI',sends=0;
  const db={async transaction(fn){return fn({async query(sql,args=[]){
    sqlLog.push(sql);
    if(sql.includes('INSERT INTO zalo_inbound_events')){
      const key=args[0]+':'+args[1];
      if(inbound.has(key))return {rowCount:0,rows:[]};
      inbound.set(key,args);return {rowCount:1,rows:[]};
    }
    if(sql.includes('INSERT INTO zalo_process_queue'))return {rowCount:1,rows:[]};
    if(sql.includes('core_conversation_controls'))return {rowCount:1,rows:[{generation,status}]};
    if(sql.includes("FROM zalo_outbound WHERE status='QUEUED'")){
      return {rowCount:outbound.size,rows:[...outbound.entries()].filter(([,r])=>r.status==='QUEUED')
        .map(([outbound_id,r])=>({outbound_id,conversation_id:r.conversation_id,generation:String(r.generation),body_text:r.text}))};
    }
    if(sql.includes("SET status='RESERVED'")){
      const [id,cid,gen]=args,r=outbound.get(id);
      if(!r||r.status!=='QUEUED'||r.generation!==gen||r.conversation_id!==cid)return {rowCount:0,rows:[]};
      r.status='RESERVED';return {rowCount:1,rows:[]};
    }
    if(sql.includes('SET status=$2')){
      const [id,newStatus]=args,r=outbound.get(id);
      if(!r||((newStatus==='SENT'||newStatus==='UNKNOWN')&&r.status!=='RESERVED'))return {rowCount:0,rows:[]};
      r.status=newStatus;return {rowCount:1,rows:[]};
    }
    throw Error('UNEXPECTED_SQL '+sql);
  }})}};
  return {db,inbound,outbound,sqlLog,
    handover(){generation='3';status='HUMAN'},
    resume(){generation='4';status='AI'},
    countSend(){sends++},get sends(){return sends}};
}
const event=new TextEncoder().encode(JSON.stringify({synthetic_fixture:true,event_id:'evt-1',oa_id:'oa1',
  customer_id:'customer-1',conversation_id:'conv-1',occurred_at:'2026-10-11T01:00:00Z',
  kind:'text',text:'In A4'}));
const synthetic={kind:'synthetic_fixture',verifier:new SyntheticTestVerifier('fixture-key'),
  normalizer:new SyntheticFixtureNormalizer()};
test('factory fails closed without configured verifier and sender',async()=>{
  const x=fakeDb(),pipeline=createZaloPipeline({...requirements,db:x.db});
  const response=await pipeline.receive_webhook(event,{'x-test-fixture-key':'fixture-key'});
  assert.equal(response.status_code,403);assert.equal(x.inbound.size,0);
  assert.deepEqual(await pipeline.tick_outbound(),{attempted:0,sent:0,unknown:0,blocked:0,disabled:true});
  assert.equal(x.sends,0);
  assert.throws(()=>createZaloPipeline({...requirements,db:x.db,mode:'production'}),/LIVE_DISABLED/);
  assert.throws(()=>createZaloPipeline({...requirements,db:x.db,mode:'controlled_test'}),/LIVE_DISABLED/);
});
test('synthetic webhook uses raw-byte verifier before durable insert and dedupe',async()=>{
  const x=fakeDb(),pipeline=createZaloPipeline({...requirements,db:x.db,synthetic_provider:synthetic});
  assert.equal((await pipeline.receive_webhook(event,{})).status_code,403);
  const headers={'x-test-fixture-key':'fixture-key'};
  assert.equal((await pipeline.receive_webhook(event,headers)).body.status,'accepted');
  assert.equal((await pipeline.receive_webhook(event,headers)).body.status,'duplicate');
  assert.equal(x.inbound.size,1);
});
test('simulation sender blocked on AI1 takeover and return does not resurrect old generation',async()=>{
  const x=fakeDb();x.outbound.set('reply-1',{conversation_id:'conv-1',generation:2,text:'Chào bạn',status:'QUEUED'});
  const pipeline=createZaloPipeline({...requirements,db:x.db,
    synthetic_provider:{...synthetic,sender:{async send_text(){x.countSend()}}}});
  x.handover();
  assert.deepEqual(await pipeline.tick_outbound(),{attempted:1,sent:0,unknown:0,blocked:1,disabled:false});
  x.resume();
  assert.equal((await pipeline.tick_outbound()).sent,0);
  assert.equal(x.sends,0);
  assert.ok(x.sqlLog.some(sql=>sql.includes('FOR UPDATE')&&sql.includes('core_conversation_controls')));
});
test('simulated ambiguous send becomes UNKNOWN and never sends twice',async()=>{
  const x=fakeDb();x.outbound.set('reply-2',{conversation_id:'conv-1',generation:2,text:'Chào bạn',status:'QUEUED'});
  const pipeline=createZaloPipeline({...requirements,db:x.db,
    synthetic_provider:{...synthetic,sender:{async send_text(){x.countSend();throw Error('simulated timeout')}}}});
  assert.equal((await pipeline.tick_outbound()).unknown,1);
  assert.equal(x.outbound.get('reply-2').status,'UNKNOWN');
  assert.equal((await pipeline.tick_outbound()).attempted,0);
  assert.equal(x.sends,1);
});
