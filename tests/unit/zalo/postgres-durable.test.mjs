import test from "node:test";
import assert from "node:assert/strict";
import {PostgresOutboundRepository,gateMatches} from "../../../backend/integrations/zalo/postgres-durable.ts";

function fakeOutbox() {
  const rows=new Map(),history=[];
  let gate={conversation_id:"conv",generation:2,mode:"AI"};
  const db={async transaction(fn) {
    return fn({async query(sql,params=[]) {
      history.push(sql);
      if(sql.includes("INSERT INTO zalo_outbound")) {
        const [id,conversation_id,generation,body_text]=params;
        if(rows.has(id))return {rows:[],rowCount:0};
        rows.set(id,{conversation_id,generation,body_text,status:"QUEUED"});
        return {rows:[],rowCount:1};
      }
      if(sql.includes("SELECT conversation_id,generation,body_text")) {
        const row=rows.get(params[0]);return {rows:row?[row]:[],rowCount:row?1:0};
      }
      if(sql.includes("SET status='RESERVED'")) {
        const [id,cid,gen]=params,row=rows.get(id);
        if(!row||row.status!=="QUEUED"||row.conversation_id!==cid||row.generation!==gen)
          return {rows:[],rowCount:0};
        row.status="RESERVED";return {rows:[],rowCount:1};
      }
      if(sql.includes("SET status=$2")) {
        const [id,status]=params,row=rows.get(id);
        if(!row||(status==="CANCELLED"? !["QUEUED","RESERVED"].includes(row.status)
          : row.status!=="RESERVED"))return {rows:[],rowCount:0};
        row.status=status;return {rows:[],rowCount:1};
      }
      if(sql.includes("SET status='UNKNOWN'")) {
        let count=0;
        for(const row of rows.values())if(row.status==="RESERVED"){row.status="UNKNOWN";count++;}
        return {rows:[],rowCount:count};
      }
      throw new Error("UNKNOWN_SQL "+sql);
    }});
  }};
  const lock={async lock_if_current(_tx,cid,gen) {
    return gateMatches(gate,cid,gen);
  }};
  return {repo:new PostgresOutboundRepository(db,lock),rows,history,
    takeover(){gate={conversation_id:"conv",generation:3,mode:"HUMAN"};}};
}

const outbound={outbound_id:"r1",conversation_id:"conv",generation:2,text:"Xin xác nhận in A4"};
test("outbound unique id stays terminal and cannot be replayed",async()=>{
  const x=fakeOutbox();
  await x.repo.enqueue(outbound);
  await x.repo.enqueue(outbound);
  assert.equal(x.rows.size,1);
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),true);
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),false);
  await x.repo.mark("r1","UNKNOWN");
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),false);
  await x.repo.enqueue(outbound);
  assert.equal(x.rows.get("r1").status,"UNKNOWN");
  await assert.rejects(x.repo.mark("r1","SENT"),/INVALID_TRANSITION/);
  await assert.rejects(x.repo.enqueue({...outbound,text:"different"}),/IDEMPOTENCY_CONFLICT/);
});

test("handover generation must be locked in same reservation transaction",async()=>{
  const x=fakeOutbox();
  await x.repo.enqueue(outbound);x.takeover();
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),false);
  assert.equal(x.rows.get("r1").status,"QUEUED");
  assert.ok(x.history.some(sql=>sql.includes("status='RESERVED'"))===false);
});

test("reconcile stale reserved only marks UNKNOWN, never QUEUED",async()=>{
  const x=fakeOutbox();await x.repo.enqueue(outbound);
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),true);
  assert.equal(await x.repo.reconcile_stale_reserved(),1);
  assert.equal(x.rows.get("r1").status,"UNKNOWN");
  assert.equal(await x.repo.reserve_if_current("r1","conv",2),false);
});

test("invalid input fails closed before DB and cannot mark nonexistent status",async()=>{
  const x=fakeOutbox();
  await assert.rejects(x.repo.enqueue({...outbound,generation:-1}),/INVALID_OUTBOUND/);
  await assert.rejects(x.repo.mark("missing","SENT"),/INVALID_TRANSITION/);
  assert.equal(x.rows.size,0);
});
