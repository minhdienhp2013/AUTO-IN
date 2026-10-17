import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_FIRST_PAGE_QUESTION,formatBoundFirstPageQuestion,
  formatMissingPrintChoicesQuestion,
  prepareBoundFirstPageQuestion,
} from "../../../backend/conversation/first-page-question.ts";

const hashA="a".repeat(64),hashB="b".repeat(64);
const order="12345678-1234-4123-8123-123456789abc";
const scope={shop_id:"shop-1",order_id:order,revision:3,oa_id:"oa-1",
 customer_id:"customer-1",conversation_id:"chat-1"};
const trusted=()=>({
 current:{...scope,active_revision:3,request_hash:hashA,source_sha256:hashB,
  sealed_source_verified:true},
 advisory:{shop_id:"shop-1",order_id:order,revision:3,
  request_hash:hashA,artifact_sha256:hashB,
  metadata:{schema_version:"tn005.first_page.v1",status:"SUGGESTED",
   category:"EXAM",confidence_label:"high",analyzed_page_count:1,
   method:"pymupdf_page0_text",reason_code:"NONE"}},
});
const fallback=(value,context=scope)=>{
 const out=formatBoundFirstPageQuestion(context,value);
 assert.equal(out.used_suggestion,false);
 assert.equal(out.text,SAFE_FIRST_PAGE_QUESTION);
 assert.ok(!out.text.includes("OCR PRIVATE SOURCE"));
};

test("TN005 partial-choice formatter emits static text for each valid subset",()=>{
 const cases=[
  [["copies"],"Bạn muốn in bao nhiêu bản?"],
  [["paper"],"Bạn muốn chọn khổ giấy nào?"],
  [["duplex"],"Bạn muốn in một mặt hay hai mặt?"],
  [["copies","paper"],"Bạn muốn in bao nhiêu bản? Bạn muốn chọn khổ giấy nào?"],
  [["copies","duplex"],"Bạn muốn in bao nhiêu bản? Bạn muốn in một mặt hay hai mặt?"],
  [["paper","duplex"],"Bạn muốn chọn khổ giấy nào? Bạn muốn in một mặt hay hai mặt?"],
  [["copies","paper","duplex"],"Bạn muốn in bao nhiêu bản? Bạn muốn chọn khổ giấy nào? Bạn muốn in một mặt hay hai mặt?"],
 ];
 for(const [missing,questions] of cases){
  assert.equal(formatMissingPrintChoicesQuestion(missing),
   `${questions} Cửa hàng sẽ kiểm tra bản xem trước để bạn xác nhận.`);
 }
 assert.equal(formatMissingPrintChoicesQuestion(["duplex","copies"]),
  "Bạn muốn in bao nhiêu bản? Bạn muốn in một mặt hay hai mặt? Cửa hàng sẽ kiểm tra bản xem trước để bạn xác nhận.",
  "Output order is deterministic regardless of input order");
});

test("TN005 partial-choice formatter fails closed on invalid or untrusted input",()=>{
 for(const value of [null,undefined,"copies",{},[],["copies","copies"],
   ["copies","unknown"],["copies",1],new Array(1),["copies","paper","duplex","extra"]])
  assert.equal(formatMissingPrintChoicesQuestion(value),null,JSON.stringify(value));
 const withExtraProperty=["copies"];
 withExtraProperty.untrusted="duplex";
 assert.equal(formatMissingPrintChoicesQuestion(withExtraProperty),null);
 class ChoiceList extends Array {}
 assert.equal(formatMissingPrintChoicesQuestion(new ChoiceList("copies")),null);
 let accessorCalls=0;
 const accessorInput=[];
 Object.defineProperty(accessorInput,"0",{enumerable:true,get(){accessorCalls++;return "copies";}});
 assert.equal(formatMissingPrintChoicesQuestion(accessorInput),null);
 assert.equal(accessorCalls,0,"validation must not evaluate accessor input");
});

test("TN005 partial-choice formatter is pure and accepts no Port",()=>{
 const input=Object.freeze(["duplex","copies"]);
 const before=[...input];
 let portReads=0;
 const port=new Proxy({}, {get(){portReads++;throw Error("formatter must not access a Port");}});
 const result=formatMissingPrintChoicesQuestion(input,port);
 assert.equal(result,"Bạn muốn in bao nhiêu bản? Bạn muốn in một mặt hay hai mặt? Cửa hàng sẽ kiểm tra bản xem trước để bạn xác nhận.");
 assert.deepEqual(input,before,"formatter must not mutate caller input");
 assert.equal(portReads,0);
 assert.equal(formatMissingPrintChoicesQuestion.length,1);
});

test("TN005 trusted SUGGESTED uses ONLY static Vietnamese category label",()=>{
 const out=formatBoundFirstPageQuestion(scope,trusted());
 assert.equal(out.used_suggestion,true);
 assert.match(out.text,/Trang đầu có vẻ là đề kiểm tra hoặc đề thi/);
 assert.ok(out.text.endsWith(SAFE_FIRST_PAGE_QUESTION));
 assert.doesNotMatch(out.text,/giá|đã duyệt|đã in|đã xác nhận/i);
});

test("TN005 all eight whitelisted categories have bounded static text",()=>{
 for(const category of ["WORKSHEET","EXAM","APPLICATION_FORM",
   "CONTRACT_MINUTES","LESSON_PLAN","CV_PROFILE","ADMINISTRATIVE","GENERAL_DOCUMENT"]){
  const value=trusted();value.advisory.metadata.category=category;
  const out=formatBoundFirstPageQuestion(scope,value);
  assert.equal(out.used_suggestion,true,category);
  assert.ok(out.text.endsWith(SAFE_FIRST_PAGE_QUESTION));
  assert.ok(out.text.length<280);
 }
});

for(const [name,mutate] of [
 ["shop is foreign",v=>{v.advisory.shop_id="other-shop"}],
 ["Core current shop is foreign",v=>{v.current.shop_id="other-shop"}],
 ["Core active revision advanced",v=>{v.current.active_revision=4}],
 ["advisory has old revision",v=>{v.advisory.revision=2}],
 ["current order mismatched",v=>{v.current.order_id="other-order"}],
 ["advisory order mismatched",v=>{v.advisory.order_id="other-order"}],
 ["request hash changed in current revision",v=>{v.current.request_hash=hashB}],
 ["advisory request hash mismatched",v=>{v.advisory.request_hash=hashB}],
 ["current source SHA changed",v=>{v.current.source_sha256=hashA}],
 ["advisory source SHA changed",v=>{v.advisory.artifact_sha256=hashA}],
 ["source SHA malformed",v=>{v.current.source_sha256="NOT_A_SHA"}],
 ["current source no longer verified",v=>{v.current.sealed_source_verified=false}],
 ["current OA mismatch",v=>{v.current.oa_id="other-oa"}],
 ["current customer mismatch",v=>{v.current.customer_id="other-customer"}],
 ["current conversation mismatch",v=>{v.current.conversation_id="other-chat"}],
 ["advisory UNKNOWN",v=>{v.advisory.metadata.status="UNKNOWN"}],
 ["advisory NEEDS_HUMAN",v=>{v.advisory.metadata.status="NEEDS_HUMAN"}],
 ["untrusted confidence",v=>{v.advisory.metadata.confidence_label="none"}],
 ["untrusted analyzed page count",v=>{v.advisory.metadata.analyzed_page_count=0}],
 ["metadata reason is not NONE",v=>{v.advisory.metadata.reason_code="AMBIGUOUS_CONTENT"}],
 ["unknown category attempts OCR injection",v=>{v.advisory.metadata.category="OCR PRIVATE SOURCE"}],
 ["extra raw OCR field",v=>{v.advisory.metadata.raw_ocr="OCR PRIVATE SOURCE"}],
 ["invalid schema version",v=>{v.advisory.metadata.schema_version="tn005.other"}],
 ["invalid method",v=>{v.advisory.metadata.method="OCR PRIVATE SOURCE"}],
 ["not_run method cannot produce trusted suggestion",v=>{v.advisory.metadata.method="not_run"}],
])test("TN005 safe fallback: "+name,()=>{
 const value=trusted();mutate(value);fallback(value);
});

test("TN005 missing advisory, metadata, context, snapshot or unsafe scope fall back",()=>{
 fallback({...trusted(),advisory:null});
 const value=trusted();value.advisory.metadata=null;fallback(value);
 fallback(null);fallback(undefined);
 fallback({current:trusted().current});
 fallback(trusted(),{...scope,shop_id:"other-shop"});
 fallback(trusted(),{...scope,revision:4});
 fallback(trusted(),{...scope,customer_id:"other-customer"});
 fallback(trusted(),{...scope,order_id:"not-a-uuid"});
});

test("TN005 no print mutation, no OA send, read-only Port and safe failure",async()=>{
 let reads=0,writes=0;
 const port={
  async read_bound(input){reads++;assert.deepEqual(input,scope);return trusted()},
  async create_print_job(){writes++;assert.fail("read port must not write")},
  async approve(){writes++;assert.fail("no print approval")},
  async send_oa(){writes++;assert.fail("no OA send")},
 };
 const result=await prepareBoundFirstPageQuestion(scope,port);
 assert.equal(result.used_suggestion,true);
 assert.equal(reads,1);
 assert.equal(writes,0);
 assert.deepEqual(Object.keys(result).sort(),["text","used_suggestion"]);
 const missing=await prepareBoundFirstPageQuestion(scope,{async read_bound(){return null}});
 assert.equal(missing.text,SAFE_FIRST_PAGE_QUESTION);
 const broken=await prepareBoundFirstPageQuestion(scope,{
  async read_bound(){throw Error("OCR PRIVATE SOURCE leaked from storage")}
 });
 assert.equal(broken.text,SAFE_FIRST_PAGE_QUESTION);
 assert.equal(broken.used_suggestion,false);
});
