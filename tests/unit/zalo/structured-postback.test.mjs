import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {SyntheticFixtureNormalizer,SyntheticTestVerifier,ZaloIngress} from '../../../backend/integrations/zalo/protocol.ts';
import {confirmationIntent} from '../../../backend/conversation/confirmation-candidate.ts';
import {ConversationProcessor} from '../../../backend/conversation/processor.ts';

const challenge_id=randomUUID();
const challenge_token=randomBytes(32).toString('base64url');
const postback={kind:'verified_confirmation_accept',challenge_id,challenge_token};
const fixture=(overrides={})=>({
 synthetic_fixture:true,event_id:'event-postback',oa_id:'oa',customer_id:'customer',
 conversation_id:'chat',occurred_at:'2026-10-13T02:00:00Z',
 kind:'postback',confirmation_postback:postback,...overrides
});
const raw=value=>new TextEncoder().encode(JSON.stringify(value));
const normalizer=new SyntheticFixtureNormalizer();
const normalized=normalizer.normalize(raw(fixture()));
test('strict synthetic postback retains ONLY exact challenge data, never text or inferred credential',()=>{
 assert.equal(normalized.kind,'postback');
 assert.deepEqual(normalized.confirmation_postback,postback);
 assert.equal(normalized.text,undefined);
 assert.equal(normalized.file_ref,undefined);
 assert.equal(confirmationIntent({key:'k',first_at:0,deadline_at:1,events:[normalized]})?.event_id,
   'event-postback');
 assert.equal(confirmationIntent({key:'k',first_at:0,deadline_at:1,events:[
   normalized,{...normalized,event_id:'other'}
 ]}),undefined);
 assert.equal(confirmationIntent({key:'k',first_at:0,deadline_at:1,events:[
   {...normalized,kind:'text',text:'OK',confirmation_postback:undefined}
 ]})?.event_id,'event-postback'); // Still only a candidate: never consent.
});
test('malformed, hidden, spoofed, oversized or mixed postback metadata is rejected, never stripped',()=>{
 const bad=[
   {kind:'postback',confirmation_postback:undefined},
   {kind:'postback',confirmation_postback:null},
   {kind:'postback',confirmation_postback:[]},
   {kind:'postback',confirmation_postback:{...postback,extra:'privilege'}},
   {kind:'postback',confirmation_postback:{...postback,kind:'confirm'}},
   {kind:'postback',confirmation_postback:{...postback,challenge_id:'not-uuid'}},
   {kind:'postback',confirmation_postback:{...postback,challenge_id:'X'.repeat(1024)}},
   {kind:'postback',confirmation_postback:{...postback,challenge_token:'short'}},
   {kind:'postback',confirmation_postback:{...postback,challenge_token:'A'.repeat(300)}},
   {kind:'postback',confirmation_postback:{...postback,challenge_token:'!'.repeat(43)}},
   {kind:'postback',confirmation_postback:{...postback,challenge_token:'A'.repeat(42)+'B'}},
   {kind:'postback',text:'OK'},
   {kind:'postback',file_ref:'synthetic:proof'},
   {kind:'postback',filename:'untrusted'},
   {kind:'postback',mime_type:'application/json'}
 ];
 for(const change of bad)
   assert.throws(()=>normalizer.normalize(raw(fixture(change))),/INVALID_CONFIRMATION_POSTBACK/);
});
test('signed ordinary messages discard untrusted postback metadata, never promote it',()=>{
 const msg=normalizer.normalize(raw(fixture({kind:'text',text:'OK'})));
 assert.equal(msg.kind,'text');
 assert.equal(msg.confirmation_postback,undefined);
 const img=normalizer.normalize(raw(fixture({kind:'image',file_ref:'synthetic:proof'})));
 assert.equal(img.kind,'image');
 assert.equal(img.confirmation_postback,undefined);
 assert.equal(confirmationIntent({key:'k',events:[img],first_at:0,deadline_at:1}),undefined);
});
test('raw unverified fixture cannot enter DB; signed synthetic fixture retains postback as JSON',async()=>{
 const inserts=[];
 const ingress=new ZaloIngress(new SyntheticTestVerifier('fixture-only-secret'),normalizer,{
   async insert_once(event){inserts.push(event);return 'inserted'}
 });
 const bytes=raw(fixture());
 await assert.rejects(ingress.receive(bytes,{'x-test-fixture-key':'WRONG'}),
   /WEBHOOK_SIGNATURE_REJECTED/);
 assert.equal(inserts.length,0);
 assert.deepEqual(await ingress.receive(bytes,{'x-test-fixture-key':'fixture-only-secret'}),
   {status:'accepted',event_id:'event-postback'});
 assert.deepEqual(JSON.parse(JSON.stringify(inserts[0])).confirmation_postback,postback);
 const masquerade=await ingress.receive(raw(fixture({kind:'text',text:JSON.stringify(postback)})),
   {'x-test-fixture-key':'fixture-only-secret'});
 assert.equal(masquerade.status,'accepted');
 assert.equal(inserts.length,2);
 assert.equal(inserts[1].confirmation_postback,undefined);
 assert.equal(inserts[1].text,JSON.stringify(postback));
});
test('structured postback without server challenge resolver is HELD; never draft/approve/reply',async()=>{
 let effects=0;
 const gate={async read(){return {mode:'AI',generation:2,conversation_id:'chat'}}};
 const processor=new ConversationProcessor(gate,{async inspect(){effects++;return []}},{
   async suggest_draft(){effects++},async route_human(){effects++},
   async apply_incoming_batch(){effects++}
 },{async enqueue(){effects++}},undefined,{
   async consider({batch,expected_generation}){
     assert.equal(expected_generation,2);
     assert.deepEqual(batch.events[0].confirmation_postback,postback);
     return {status:'pending',reason:'CHALLENGE_PORT_UNAVAILABLE'};
   }
 });
 assert.equal(await processor.consume({key:'pb',events:[normalized],first_at:0,deadline_at:0}),'held');
 assert.equal(effects,0);
});
