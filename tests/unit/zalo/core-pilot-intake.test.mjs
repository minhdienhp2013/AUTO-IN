import test from "node:test";
import assert from "node:assert/strict";
import {createCorePilotIntakeAdapter,createPilotSourceCaptureAdapter} from "../../../backend/conversation/core-pilot-intake.ts";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";
import {DurableConversationWorker} from "../../../backend/conversation/durable-worker.ts";
import {createHash} from "node:crypto";

const SHOP="shop-safe",OA="oa-safe",CUSTOMER="customer-1",CHAT="chat-1";
const PDF_BYTES=Buffer.from("%PDF-1.7\nsynthetic public fixture\n%%EOF\n");
const PDF_SHA=createHash("sha256").update(PDF_BYTES).digest("hex");
const PDF_REF=`doc-${"a".repeat(32)}/source-000-${PDF_SHA}.pdf`;
function makeZip(entries){
  const localParts=[],centralParts=[];let localOffset=0;
  for(const [name,contentValue] of entries){
    const nameBytes=Buffer.from(name),content=Buffer.from(contentValue),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);
    local.writeUInt16LE(0,8);local.writeUInt32LE(0,14);local.writeUInt32LE(content.length,18);
    local.writeUInt32LE(content.length,22);local.writeUInt16LE(nameBytes.length,26);local.writeUInt16LE(0,28);
    localParts.push(local,nameBytes,content);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);
    central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);central.writeUInt32LE(0,16);
    central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);
    central.writeUInt16LE(nameBytes.length,28);central.writeUInt16LE(0,30);central.writeUInt16LE(0,32);
    central.writeUInt16LE(0,34);central.writeUInt32LE(0,38);central.writeUInt32LE(localOffset,42);
    centralParts.push(central,nameBytes);
    localOffset+=local.length+nameBytes.length+content.length;
  }
  const central=Buffer.concat(centralParts),local=Buffer.concat(localParts),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(central.length,12);end.writeUInt32LE(local.length,16);end.writeUInt16LE(0,20);
  return Buffer.concat([local,central,end]);
}
const DOCX_BYTES=makeZip([["[Content_Types].xml","<Types/>"] , ["word/document.xml","<document/>"]]);
const DOCX_SHA=createHash("sha256").update(DOCX_BYTES).digest("hex");
const DOCX_REF=`doc-${"b".repeat(32)}/source-000-${DOCX_SHA}.docx`;
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
  const seen={accept:[],apply:[],reads:[],snapshots:[],capture:[],close:[]},intakes=new Map();let nextIntake=0;
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
    async closeIncomingQueueBatch(input){
      seen.close.push(structuredClone(input));
      return {status:'NEEDS_HUMAN',intake_batch_id:input.intake_batch_id};
    },
    async apply_incoming_batch(input){
      seen.apply.push(structuredClone(input));
      if(throwApply)throw throwApply;
      return applyResult;
    }};
  core.source_capture={async ensure_sealed_source(input){
    seen.capture.push(structuredClone(input));
    return {schema:"ai0.pilot_sealed_source.v1",oa_id:input.oa_id,customer_id:input.customer_id,
      conversation_id:input.conversation_id,provider_event_id:input.provider_event_id,
      format:"PDF",artifact_ref:PDF_REF,sha256:PDF_SHA,size_bytes:PDF_BYTES.length};
  }};
  let currentLease;
  const adapter=createCorePilotIntakeAdapter({trusted_shop_id:SHOP,trusted_oa_id:OA,core});
  return {adapter,core,seen,setLease(value){currentLease=value;},get currentLease(){return currentLease;}};
}

test('verified color choice is recorded as human intake before source capture or print order',async()=>{
  for(const choice of ['In màu, A4, 2 bản, hai mặt','Mình chọn màu, A4, 2 bản, hai mặt','Màu']){
    const h=harness();
    const batch=lease('81',[settings('color-choice',choice)]);h.setLease(batch);
    assert.equal(await h.adapter.consume(batch,0),'processed');
    assert.equal(h.seen.close.length,1);
    assert.deepEqual(h.seen.close[0],{intake_batch_id:h.seen.snapshots[0].intake_batch_id,
      queue_batch_id:'81',lease_token:'lease-81',reason:'COLOR_PRINT'});
    assert.deepEqual(h.seen.snapshots[0].events.find(x=>x.event_id==='color-choice').role,'SETTINGS');
    assert.equal(h.seen.capture.length,0);
    assert.equal(h.seen.apply.length,0);
  }
});

test('color in a labelled code event never becomes black-white pilot authority',async()=>{
  const h=harness();
  const batch=lease('82',[code('code-color','Mã cửa hàng: 0123456789; in màu')]);h.setLease(batch);
  assert.equal(await h.adapter.consume(batch,0),'processed');
  assert.equal(h.seen.close[0].reason,'COLOR_PRINT');
  assert.equal(h.seen.apply.length,0);
  assert.equal(h.seen.capture.length,0);
});

test('missing human-close port or unverified settings leaves color lease held',async()=>{
  const h=harness();delete h.core.closeIncomingQueueBatch;
  const batch=lease('83',[settings('color-choice','In màu')]);h.setLease(batch);
  assert.equal(await h.adapter.consume(batch,0),'held');
  assert.equal(h.seen.apply.length,0);
  assert.equal(h.seen.close.length,0);
});

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
  assert.deepEqual(h.seen.capture,[{oa_id:OA,customer_id:CUSTOMER,
    conversation_id:CHAT,provider_event_id:"file-1"}]);
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

test("Core-bound SOURCE bytes are hashed, privately sealed/read back, then applied without artifact fields",async()=>{
  const h=harness(),stored=new Map(),trace=[],mediaInputs=[];
  h.core.source_capture=createPilotSourceCaptureAdapter({
    lookup:{async find_sealed(input){
      trace.push("lookup");
      return stored.get(`${input.oa_id}:${input.provider_event_id}`)??null;
    }},
    media:{async read_verified(input){
      trace.push("media");mediaInputs.push(structuredClone(input));
      return {oa_id:OA,customer_id:CUSTOMER,conversation_id:CHAT,
        provider_event_id:input.provider_event_id,bytes:new Uint8Array(PDF_BYTES)};
    }},
    custody:{async seal(input){
      trace.push("seal");
      assert.equal(input.provider_event_id,"file-1");
      assert.equal(input.sha256,PDF_SHA);
      assert.equal(input.size_bytes,PDF_BYTES.length);
      assert.deepEqual(Buffer.from(input.bytes),PDF_BYTES);
      const sealed={schema:"ai0.pilot_sealed_source.v1",oa_id:input.oa_id,
        customer_id:input.customer_id,conversation_id:input.conversation_id,
        provider_event_id:input.provider_event_id,format:input.format,
        artifact_ref:PDF_REF,sha256:input.sha256,size_bytes:input.size_bytes};
      stored.set(`${input.oa_id}:${input.provider_event_id}`,sealed);
      return sealed;
    },async read_sealed(input){
      trace.push("readback");
      const sealed=stored.get(`${input.oa_id}:${input.provider_event_id}`);
      return sealed?.artifact_ref===input.artifact_ref?new Uint8Array(PDF_BYTES):null;
    }}
  });
  const candidate=lease("12",[file(),settings()]);h.setLease(candidate);
  const apply=h.core.apply_incoming_batch.bind(h.core);
  h.core.apply_incoming_batch=async(input)=>{trace.push("core-apply");return apply(input);};
  assert.equal(await h.adapter.consume(candidate,4),"processed");
  assert.deepEqual(trace,["lookup","media","seal","readback","core-apply"]);
  assert.deepEqual(mediaInputs,[{oa_id:OA,provider_event_id:"file-1"}]);
  assert.equal(h.seen.apply.length,1);
  assert.doesNotMatch(JSON.stringify(h.seen.apply[0]),/artifact_ref|sha256|bytes|path|url/i);
});

test("file captured while settings are missing is reused from custody in the later settings lease",async()=>{
  const h=harness(),stored=new Map();let mediaReads=0,seals=0;
  h.core.source_capture=createPilotSourceCaptureAdapter({
    lookup:{async find_sealed(input){return stored.get(`${input.oa_id}:${input.provider_event_id}`)??null;}},
    media:{async read_verified(input){
      mediaReads++;
      return {oa_id:OA,customer_id:CUSTOMER,conversation_id:CHAT,
        provider_event_id:input.provider_event_id,bytes:new Uint8Array(PDF_BYTES)};
    }},
    custody:{async seal(input){
      seals++;
      const row={schema:"ai0.pilot_sealed_source.v1",oa_id:input.oa_id,
        customer_id:input.customer_id,conversation_id:input.conversation_id,
        provider_event_id:input.provider_event_id,format:input.format,
        artifact_ref:PDF_REF,sha256:input.sha256,size_bytes:input.size_bytes};
      stored.set(`${input.oa_id}:${input.provider_event_id}`,row);return row;
    },async read_sealed(input){
      const row=stored.get(`${input.oa_id}:${input.provider_event_id}`);
      return row?.artifact_ref===input.artifact_ref?new Uint8Array(PDF_BYTES):null;
    }}
  });
  const first=lease("91",[file()],"lease-91");h.setLease(first);
  assert.equal(await h.adapter.consume(first,1),"processed");
  assert.equal(h.seen.apply.length,0);
  assert.equal(h.seen.accept.length,2,"waiting lease is rechecked after source I/O");
  assert.equal(mediaReads,1);assert.equal(seals,1);

  const later=lease("92",[settings()],"lease-92");h.setLease(later);
  assert.equal(await h.adapter.consume(later,1),"processed");
  assert.equal(h.seen.apply.length,1);
  assert.equal(mediaReads,1,"older source is read from private custody, not downloaded again");
  assert.equal(seals,1);
});

test("missing, mismatched, corrupt or oversized media holds before Core apply",async()=>{
  const invalidMedia=[
    async()=>null,
    async(input)=>({oa_id:OA,customer_id:"other",conversation_id:CHAT,
      provider_event_id:input.provider_event_id,bytes:new Uint8Array(PDF_BYTES)}),
    async(input)=>({oa_id:OA,customer_id:CUSTOMER,conversation_id:CHAT,
      provider_event_id:input.provider_event_id,bytes:Buffer.from("not PDF or DOCX")}),
    async(input)=>({oa_id:OA,customer_id:CUSTOMER,conversation_id:CHAT,
      provider_event_id:input.provider_event_id,bytes:new Uint8Array(25*1024*1024+1)})
  ];
  for(const read_verified of invalidMedia){
    const h=harness();
    h.core.source_capture=createPilotSourceCaptureAdapter({
      lookup:{async find_sealed(){return null;}},media:{read_verified},
      custody:{async seal(){assert.fail("invalid media must not be sealed");},
        async read_sealed(){return null;}}
    });
    const candidate=lease("93",[file(),settings()]);h.setLease(candidate);
    assert.equal(await h.adapter.consume(candidate,1),"held");
    assert.equal(h.seen.apply.length,0);
  }
  const noPort=harness();noPort.core.source_capture=undefined;
  const candidate=lease("94",[file(),settings()]);noPort.setLease(candidate);
  assert.equal(await noPort.adapter.consume(candidate,1),"held");
  assert.equal(noPort.seen.apply.length,0);
});

test("capture failure holds the queue lease; it is neither completed nor applied to Core",async()=>{
  const h=harness(),candidate=lease("95",[file(),settings()]),trace=[];h.setLease(candidate);
  h.core.source_capture={async ensure_sealed_source(){throw new Error("provider contract unavailable");}};
  const processor=new ConversationProcessor(
    {async read(){return {mode:"AI",generation:1,conversation_id:CHAT};}},
    {async inspect(){assert.fail("pilot must not enter document processing");}},
    {async suggest_draft(){assert.fail("no legacy draft");},async route_human(){assert.fail("no automatic handoff");}},
    {async enqueue(){assert.fail("no customer reply");}},undefined,undefined,undefined,h.core);
  const queue={async ingest_pending(){return 0;},async claim_due(){return [candidate];},
    async complete(){trace.push("complete");return true;},
    async hold(){trace.push("hold");return true;},
    async fail(_batch,error){throw new Error(`unexpected retry path: ${error}`);}};
  const result=await new DurableConversationWorker(queue,processor).tick();
  assert.equal(result.held,1);assert.deepEqual(trace,["hold"]);
  assert.equal(h.seen.apply.length,0);
});

test("DOCX needs OOXML directory entries; a generic ZIP container is not accepted as DOCX",async()=>{
  async function capture(bytes,expectedFormat,expectedRef,expectedSha){
    let sealedInput;
    const adapter=createPilotSourceCaptureAdapter({
      lookup:{async find_sealed(){return null;}},
      media:{async read_verified(input){return {oa_id:OA,customer_id:CUSTOMER,
        conversation_id:CHAT,provider_event_id:input.provider_event_id,bytes:new Uint8Array(bytes)};}},
      custody:{async seal(input){sealedInput=input;return {schema:"ai0.pilot_sealed_source.v1",
        oa_id:OA,customer_id:CUSTOMER,conversation_id:CHAT,provider_event_id:"file-docx",
        format:input.format,artifact_ref:expectedRef,sha256:input.sha256,size_bytes:input.size_bytes};},
        async read_sealed(){return new Uint8Array(bytes);}}
    });
    const result=await adapter.ensure_sealed_source({oa_id:OA,customer_id:CUSTOMER,
      conversation_id:CHAT,provider_event_id:"file-docx"});
    if(expectedFormat===null){assert.equal(sealedInput,undefined);assert.equal(result,null);}
    else{assert.equal(sealedInput.format,expectedFormat);assert.equal(sealedInput.sha256,expectedSha);
      assert.equal(result.format,expectedFormat);}
  }
  await capture(DOCX_BYTES,"DOCX",DOCX_REF,DOCX_SHA);
  await capture(makeZip([["notes.txt","not an OOXML document"]]),null,null,null);
});

test("split SETTINGS events are combined only within the Core intake batch",async()=>{
  const h=harness();
  const first=lease("25",[settings("partial","A4, in 2 bản, hai mặt")]);h.setLease(first);
  assert.equal(await h.adapter.consume(first,0),"processed");
  const second=lease("26",[file(),settings("final","đen trắng")]);h.setLease(second);
  assert.equal(await h.adapter.consume(second,0),"processed");
  assert.deepEqual(h.seen.reads.at(-1).event_ids,["partial","final"]);
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
    "Không tạo đơn",
    "Không tạo đơn mới",
    "Không tạo đơn nào",
    "Không tạo đơn nữa",
    "Không tạo đơn mới nữa",
    "không tạo đơn mới",
    "Không muốn tạo đơn mới",
    "Không cần lập đơn",
    "Đừng mở đơn mới",
    "Chưa tạo đơn",
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

test("affirmative create-order request opens a fresh intake",async()=>{
  const h=harness(),candidate=lease("361",[file("create-file"),settings("create-settings",
    "Tạo đơn mới, A4, in 2 bản, hai mặt, đen trắng")]);
  h.setLease(candidate);
  assert.equal(await h.adapter.consume(candidate,1),"processed");
  assert.equal(h.seen.accept[0].boundary,"NEW");
  assert.equal(h.seen.snapshots[0].intake_batch_id,"intake-1");
  assert.deepEqual(h.seen.apply[0].event_ids,["create-file","create-settings"]);
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

test("negated new-order phrases hold the lease without Core calls or successful completion",async()=>{
  for(const message of ["Không tạo đơn","Không tạo đơn mới","Không tạo đơn nào",
    "Không tạo đơn nữa"]){
    const h=harness(),candidate=lease("84",[file(),settings(),event("negated-boundary","text",message)]);
    const trace=[];
    const queue={async ingest_pending(){return 0;},async claim_due(){return [candidate];},
      async complete(){trace.push("complete");return true;},
      async hold(){trace.push("hold");return true;},
      async fail(_batch,error){throw new Error(`unexpected queue failure: ${error}`);}};
    const worker=new DurableConversationWorker(queue,{async consume(batch){
      h.setLease(batch);return h.adapter.consume(batch,1);
    }});
    const result=await worker.tick();
    assert.equal(result.held,1,message);
    assert.deepEqual(trace,["hold"],message);
    assert.equal(h.seen.accept.length,0,message);
    assert.equal(h.seen.apply.length,0,message);
  }
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
