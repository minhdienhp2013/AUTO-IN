import test from "node:test";
import assert from "node:assert/strict";
import {CoreConversationGate} from "../../../backend/integrations/zalo/core-gate.ts";
function fixture(row={generation:"3",status:"AI"}) {
  const queries=[];
  const db={async transaction(fn){return fn({async query(sql,params){
    queries.push({sql,params});return {rows:row?[row]:[],rowCount:row?1:0};
  }})}};
  return {db,queries};
}
test("AI1 authoritative control is shop-scoped and locked during reservation",async()=>{
  const {db,queries}=fixture();
  const gate=new CoreConversationGate(db,"trusted-shop");
  assert.deepEqual(await gate.read("c1"),{conversation_id:"c1",generation:3,mode:"AI"});
  assert.equal(await db.transaction(tx=>gate.lock_if_current(tx,"c1",3)),true);
  assert.equal(queries.length,2);
  assert.ok(!queries[0].sql.includes("FOR UPDATE"));
  assert.ok(queries[1].sql.includes("FOR UPDATE"));
  assert.deepEqual(queries[1].params,["trusted-shop","c1"]);
  assert.equal(await db.transaction(tx=>gate.lock_if_current(tx,"c1",2)),false);
});
test("missing / HUMAN / overflowing AI1 control fails closed",async()=>{
  for(const row of [null,{generation:"8",status:"HUMAN"}]) {
    const {db}=fixture(row),gate=new CoreConversationGate(db,"trusted-shop");
    assert.equal(await db.transaction(tx=>gate.lock_if_current(tx,"c1",8)),false);
  }
  const {db}=fixture({generation:"9007199254740993",status:"AI"});
  await assert.rejects(new CoreConversationGate(db,"trusted-shop").read("c1"),/INVALID_CONTROL_ROW/);
});
test("reject untrusted empty shop and invalid conversation",async()=>{
  const {db}=fixture();
  assert.throws(()=>new CoreConversationGate(db,""),/INVALID_TRUSTED_SHOP/);
  await assert.rejects(new CoreConversationGate(db,"s").read(""),/INVALID_CONVERSATION/);
});
