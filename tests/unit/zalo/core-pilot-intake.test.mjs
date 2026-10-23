import test from "node:test";
import assert from "node:assert/strict";
import {createCorePilotIntakeAdapter} from "../../../backend/conversation/core-pilot-intake.ts";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";
import {DurableConversationWorker} from "../../../backend/conversation/durable-worker.ts";

const SHOP="shop-safe",OA="oa-safe",CUSTOMER="customer-1",CHAT="chat-1";
const code=(id="code-1",text="Mã cửa hàng: 0123456789")=>event(id,"text",text);
const settings=(id="settings-1",text="A4, in 2 bản, hai mặt, đen trắng")=>event(id,"text",text);
const file=(id="file-1")=>event(id,"file",undefined);
function event(id,kind,text){return {event_id:id,oa_id:OA,customer_id:CUSTOMER,
  conversation_id:CHAT,occurred_at:"2026-10-22T00:00:00Z",kind,
  ...(text===undefined?{file_ref:`synthetic:${id}`}:{text})};}
function lease(batch_id,events,lease_token=`lease-${batch_id}`,order=events.map(x=>x.event_id)){
  return {batch_id,lease_token,attempts:1,key:`key-${batch_id}`,first_at:0,deadline_at:60000,
    events,server_received_event_ids:order};
}
function harness({applyResult={status:"created",order_id:"order-1",active_revision:1},
  acceptStatus="OPEN",readiness:readinessOverride,throwAccept,throwApply}={}){
  const seen={accept:[],apply:[],reads:[],snapshots:[]},intakes=new Map();let nextIntake=0;
  const core={trusted_shop_id:SHOP,trusted_oa_id:OA,
    async acceptIncomingQueueBatch(input){
      seen.accept.push(structuredClone(input));
      if(throwAccept)throw throwAccept;
      const currentEvents=input.event_ids.map(id=>currentLease.events.find(e=>e.event_id===id));
      assert.ok(currentEvents.every(Boolean));
      const first=currentEvents[0];
      let intake=intakes.get(first.conversation_id);
      if(input.boundary==="NEW"||!intake){intake={id:`intake-${++nextIntake}`,events:new Map()};intakes.set(first.conversation_id,intake);}
      for(const e of currentEvents)if(!intake.events.has(e.event_id))
        intake.events.set(e.event_id,{event_id:e.event_id,kind:e.kind,role:"CONTEXT",event:e});
      const roles=input.selection??{};
      if(roles.code_event_id)intake.events.get(roles.code_event_id).role="CODE";
      if(roles.source_event_id)intake.events.get(roles.source_event_id).role="SOURCE";
      for(const id of roles.settings_event_ids??[])intake.events.get(id).role="SETTINGS";
      const rows=[...intake.events.values()];
      const snapshot={schema:"ai1.oa_intake_batch.v1",status:acceptStatus,
        readiness:readinessOverride??(!rows.some(e=>e.role==="SOURCE")?"WAITING_FOR_FILE":
          !rows.some(e=>e.role==="SETTINGS")?"WAITING_FOR_SETTINGS":"READY"),
        intake_batch_id:intake.id,queue_batch_id:input.queue_batch_id,shop_id:SHOP,oa_id:OA,
        customer_id:CUSTOMER,conversation_id:CHAT,purpose:"PILOT",opened_at:"2026-10-22T00:00:00Z",
        expires_at:"2026-10-22T00:30:00Z",order_id:null,revision:null,
        events:rows.map(({event_id,kind,role})=>({event_id,kind,role,received_at:"2026-10-22T00:00:00Z"}))};
      seen.snapshots.push(structuredClone(snapshot));
      return snapshot;
    },
    async read_settings_events(input){
      seen.reads.push(structuredClone(input));
      const intake=[...intakes.values()].find(x=>x.id===input.intake_batch_id);
      return input.event_ids.map(id=>intake?.events.get(id)?.event);
    },
    async apply_incoming_batch(input){
      seen.apply.push(structuredClone(input));
      if(throwApply)throw throwApply;
      return applyResult;
    }};
  let currentLease;
  const adapter=createCorePilotIntakeAdapter({trusted_shop_id:SHOP,trusted_oa_id:OA,core});
  return {adapter,core,seen,setLease(value){currentLease=value;},get currentLease(){return currentLease;}};
}

test("code-before-file stays in the same persistent intake; source/settings apply only under the current lease",async()=>{
  const h=harness();
  const first=lease("11",[code()]);h.setLease(first);
  assert.equal(await h.adapter.consume(first,4),"processed");
  assert.equal(h.seen.apply.length,0);
  assert.deepEqual(h.seen.accept[0].selection,{code_event_id:"code-1"});

  const second=lease("12",[file(),settings()]);h.setLease(second);
  assert.equal(await h.adapter.consume(second,4),"processed");
  assert.equal(h.seen.accept[1].selection.source_event_id,"file-1");
  assert.deepEqual(h.seen.accept[1].selection.settings_event_ids,["settings-1"]);
  assert.deepEqual(h.seen.apply[0].event_ids,["file-1","settings-1"]);
  assert.equal(h.seen.apply[0].queue_batch_id,"12");
  assert.equal(h.seen.apply[0].lease_token,"lease-12");
  assert.match(h.seen.apply[0].intake_batch_id,/^intake-/);
  assert.deepEqual(h.seen.apply[0].pilot_settings,
    {copies:2,duplex:true,paper:"A4",color:"black_white"});
  assert.ok(!Object.keys(h.seen.apply[0]).some(key=>/artifact|sha|path|bytes|source_ref/i.test(key)));
  assert.deepEqual(h.seen.reads[0].event_ids,["settings-1"]);
  assert.equal(h.seen.reads[0].queue_batch_id,"12");
});

test("settings received before the source are read only from Core's SETTINGS role in the same intake",async()=>{
  const h=harness();
  const first=lease("21",[settings()]);h.setLease(first);
  assert.equal(await h.adapter.consume(first,0),"processed");
  assert.equal(h.seen.apply.length,0);
  const second=lease("22",[file()]);h.setLease(second);
  assert.equal(await h.adapter.consume(second,0),"processed");
  assert.deepEqual(h.seen.apply[0].pilot_settings,
    {copies:2,duplex:true,paper:"A4",color:"black_white"});
  assert.deepEqual(h.seen.reads[0].event_ids,["settings-1"]);
  assert.deepEqual(h.seen.apply[0].event_ids,["file-1"]);
});

test("split SETTINGS events are combined only within the Core intake batch",async()=>{
  const h=harness();
  const first=lease("25",[settings("partial","A4, in 2 bản, hai mặt")]);h.setLease(first);
  assert.equal(await h.adapter.consume(first,0),"processed");
  const second=lease("26",[file(),settings("final","đen trắng")]);h.setLease(second);
  assert.equal(await h.adapter.consume(second,0),"processed");
  assert.deepEqual(h.seen.reads[0].event_ids,["partial","final"]);
  assert.deepEqual(h.seen.apply[0].pilot_settings,
    {copies:2,duplex:true,paper:"A4",color:"black_white"});
  assert.deepEqual(h.seen.apply[0].event_ids,["file-1","final"]);
});

test("explicit new order opens a new intake and cannot carry the old code event",async()=>{
  const h=harness();
  const old=lease("31",[code()]);h.setLease(old);
  assert.equal(await h.adapter.consume(old,1),"processed");
  const next=lease("32",[file("new-file"),settings("new-settings",
    "Đơn mới, A4, in 2 bản, hai mặt, đen trắng")]);h.setLease(next);
  assert.equal(await h.adapter.consume(next,1),"processed");
  assert.equal(h.seen.accept[1].boundary,"NEW");
  assert.equal(h.seen.accept[1].selection.code_event_id,undefined);
  assert.equal(h.seen.apply[0].intake_batch_id,"intake-2");
  assert.deepEqual(h.seen.apply[0].event_ids,["new-file","new-settings"]);
  assert.equal(h.seen.snapshots[1].events.some(e=>e.event_id==="old-code"),false);
});

test("standalone NEW boundary between leases separates old CODE from later file and settings",async()=>{
  const h=harness();
  const old=lease("33",[code("old-code")]);h.setLease(old);
  assert.equal(await h.adapter.consume(old,1),"processed");
  assert.equal(h.seen.snapshots[0].events.find(e=>e.event_id==="old-code")?.role,"CODE");

  const boundary=lease("34",[event("new-order-boundary","text","Đơn mới")]);h.setLease(boundary);
  assert.equal(await h.adapter.consume(boundary,1),"processed");
  assert.equal(h.seen.accept[1].boundary,"NEW");
  assert.equal(h.seen.accept[1].selection.code_event_id,undefined);
  assert.equal(h.seen.snapshots[1].intake_batch_id,"intake-2");

  const later=lease("35",[file("new-file"),settings("new-settings")]);h.setLease(later);
  assert.equal(await h.adapter.consume(later,1),"processed");
  assert.equal(h.seen.accept[2].boundary,"CONTINUE");
  assert.equal(h.seen.snapshots[2].intake_batch_id,"intake-2");
  assert.deepEqual(h.seen.snapshots[2].events.map(e=>e.event_id).sort(),
    ["new-file","new-order-boundary","new-settings"]);
  assert.equal(h.seen.snapshots[2].events.some(e=>e.event_id==="old-code"),false);
  assert.equal(h.seen.apply[0].intake_batch_id,"intake-2");
  assert.deepEqual(h.seen.apply[0].event_ids,["new-file","new-settings"]);
});

test("negated or conflicting boundary signal holds the leased batch for human review",async()=>{
  for(const message of [
    "Không tạo đơn mới",
    "Đơn mới nhưng tiếp tục đơn cũ",
    "Đơn mới, gửi thêm file vào đơn cũ",
    "Làm một đơn rồi gửi file"
  ]){
    const h=harness(),candidate=lease("36",[file("ambiguous-file"),
      settings("ambiguous-settings"),event("boundary-text","text",message)]);
    h.setLease(candidate);
    assert.equal(await h.adapter.consume(candidate,1),"held",message);
    assert.equal(h.seen.accept.length,0,message);
    assert.equal(h.seen.apply.length,0,message);
  }
});

test("unknown Core readiness is held; only the declared waiting states are processed",async()=>{
  const unknown=harness({readiness:"WAITING_FOR_ARBITRARY_STATE"}),candidate=lease("37",[code()]);
  unknown.setLease(candidate);
  assert.equal(await unknown.adapter.consume(candidate,1),"held");
  assert.equal(unknown.seen.apply.length,0);

  const waiting=harness({readiness:"WAITING_FOR_CODE"}),known=lease("38",[code()]);
  waiting.setLease(known);
  assert.equal(await waiting.adapter.consume(known,1),"processed");
  assert.equal(waiting.seen.apply.length,0);
});

test("duplicate or forged lease event IDs fail closed before any Core call",async()=>{
  for(const ids of [["x","x"],["foreign"]]){
    const h=harness(),candidate=lease("41",[code("x")],"lease-41",ids);h.setLease(candidate);
    assert.equal(await h.adapter.consume(candidate,0),"held");
    assert.equal(h.seen.accept.length,0);assert.equal(h.seen.apply.length,0);
  }
});

test("closed/expired intake and permanent Core statuses hold instead of completing",async()=>{
  for(const acceptStatus of ["CLOSED","EXPIRED","NEEDS_HUMAN"]){
    const h=harness({acceptStatus}),candidate=lease("51",[code("x")]);h.setLease(candidate);
    assert.equal(await h.adapter.consume(candidate,0),"held");
    assert.equal(h.seen.apply.length,0);
  }
  const lost={code:"INCOMING_BATCH_LEASE_LOST"};
  const h=harness({throwAccept:lost}),candidate=lease("52",[code("x")]);h.setLease(candidate);
  assert.equal(await h.adapter.consume(candidate,0),"held");
});

test("ambiguous Core result is held; uncertain transport error propagates for queue retry",async()=>{
  const h=harness({applyResult:{status:"ambiguous"}});
  const candidate=lease("61",[file(),settings()]);h.setLease(candidate);
  assert.equal(await h.adapter.consume(candidate,7),"held");
  const uncertain=Object.assign(new Error("temporary connection failure"),{code:"DB_CONNECTION_LOST"});
  const retry=harness({throwApply:uncertain}),later=lease("62",[file(),settings()]);retry.setLease(later);
  await assert.rejects(retry.adapter.consume(later,7),/temporary connection failure/);
});

test("unsupported/conflicting settings and settings embedded in the CODE event never authorize apply",async()=>{
  const h=harness(),mixed=lease("71",[
    event("code-and-settings","text","Mã cửa hàng: 0123456789, A4, in 2 bản, hai mặt, đen trắng"),file()
  ]);h.setLease(mixed);
  assert.equal(await h.adapter.consume(mixed,2),"processed");
  assert.equal(h.seen.accept[0].selection.code_event_id,"code-and-settings");
  assert.equal(h.seen.accept[0].selection.settings_event_ids,undefined);
  assert.equal(h.seen.apply.length,0);

  const unsupported=harness(),bad=lease("72",[file(),settings("a","A3, in 2 bản, hai mặt, đen trắng")]);
  unsupported.setLease(bad);
  assert.equal(await unsupported.adapter.consume(bad,2),"held");
  assert.equal(unsupported.seen.apply.length,0);

  const overLimit=harness(),tooMany=lease("73",[file(),settings("b","A4, 100 bản, hai mặt, đen trắng")]);
  overLimit.setLease(tooMany);
  assert.equal(await overLimit.adapter.consume(tooMany,2),"held");
  assert.equal(overLimit.seen.apply.length,0);
});

test("ConversationProcessor sends pilot leases to Core before document/general processing",async()=>{
  const h=harness(),candidate=lease("81",[file(),settings()]);h.setLease(candidate);
  let inspected=0,drafted=0;
  const gate={async read(){return {mode:"AI",generation:8,conversation_id:CHAT};}};
  const processor=new ConversationProcessor(gate,{async inspect(){inspected++;return []; }},
    {async suggest_draft(){drafted++;return {status:"created",order_id:"wrong"};},
      async route_human(){return {status:"routed",generation:8};}},
    {async enqueue(){assert.fail("pilot intake must not send a reply");}},undefined,undefined,undefined,h.core);
  assert.equal(await processor.consume(candidate),"processed");
  assert.equal(h.seen.apply.length,1);assert.equal(inspected,0);assert.equal(drafted,0);
});

test("durable worker completes the lease only after Core returns a committed result",async()=>{
  const h=harness(),candidate=lease("82",[file(),settings()]);h.setLease(candidate);
  const trace=[],gate={async read(){return {mode:"AI",generation:3,conversation_id:CHAT};}};
  const processor=new ConversationProcessor(gate,{async inspect(){assert.fail("pilot bypasses document port");}},
    {async suggest_draft(){assert.fail("pilot bypasses legacy draft port");},async route_human(){assert.fail("no handover");}},
    {async enqueue(){assert.fail("no OA reply");}},undefined,undefined,undefined,h.core);
  const queue={async ingest_pending(){return 0;},async claim_due(){return [candidate];},
    async complete(){trace.push("queue-complete");assert.equal(h.seen.apply.length,1);return true;},
    async hold(){trace.push("queue-hold");return true;},
    async fail(_batch,error){throw new Error(`unexpected queue failure: ${error}`);}};
  const apply=h.core.apply_incoming_batch.bind(h.core);
  h.core.apply_incoming_batch=async(input)=>{trace.push("core-apply-start");const result=await apply(input);
    trace.push("core-apply-committed");return result;};
  const worker=new DurableConversationWorker(queue,processor);
  const result=await worker.tick();
  assert.equal(result.processed,1);assert.deepEqual(trace,["core-apply-start","core-apply-committed","queue-complete"]);
});

test("pilot signal without the Core adapter is held instead of entering legacy draft flow",async()=>{
  let drafts=0;
  const processor=new ConversationProcessor(
    {async read(){return {mode:"AI",generation:1,conversation_id:CHAT};}},
    {async inspect(){assert.fail("must not inspect unbound file");}},
    {async suggest_draft(){drafts++;return {status:"created",order_id:"wrong"};},
      async route_human(){assert.fail("durable queue hold owns handoff");}},
    {async enqueue(){assert.fail("must not reply");}});
  assert.equal(await processor.consume(lease("83",[file()])),"held");
  assert.equal(drafts,0);
});
