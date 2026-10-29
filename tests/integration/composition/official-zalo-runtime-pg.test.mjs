import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import pg from "pg";
import {asSqlPool,assertIsolatedSimulationDatabase} from "../../../backend/composition/postgres.ts";
import {buildIntegratedApp} from "../../../backend/composition/runtime.ts";
import {createCoreModule} from "../../../backend/core/factory.ts";
import {createAiOrderPort} from "../../../backend/core/ai-order-port.ts";

const url=process.env.TEST_DATABASE_URL??process.env.AUTOIN_TEST_DATABASE_URL;

test("AI0 CODE-402 runtime: default OFF, signed synthetic quarantine blocks proposal approval in real PostgreSQL",{
  skip:!url?"TEST_DATABASE_URL missing: official Zalo runtime composition NOT RUN":false,
  timeout:120000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const pool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
  const sql=asSqlPool(pool),core=createCoreModule({pool:sql});
  const suffix=randomUUID().replaceAll("-","");
  const shop="autoin-test-oa-compose-"+suffix;
  const oa="oa-"+suffix,appId="app-"+suffix,secret="synthetic-only-"+randomUUID()+"-"+randomUUID();
  const sender="sender-"+suffix,customer="customer-"+suffix,conversation="conversation-"+suffix;
  const password="isolated-"+randomUUID();
  let disabled,app,bootstrapped=false,orderId;
  const config={
    app_id:appId,oa_id:oa,oa_secret_key:secret,
    resolve_verified_user(userIdByApp){
      return userIdByApp===sender?{customer_id:customer,conversation_id:conversation}:null;
    }
  };
  const signRaw=(raw,timestamp)=>"mac="+createHash("sha256").update(appId,"utf8").update(raw)
    .update(String(timestamp),"utf8").update(secret,"utf8").digest("hex");
  const signed=(eventName,eventId,text)=>{
    const timestamp=Date.now();
    const value={app_id:appId,timestamp,event_id:eventId,event_name:eventName,
      user_id_by_app:sender,sender:{id:"untrusted-"+sender},recipient:{id:oa},
      message:{msg_id:"message-"+eventId,...(text===undefined?{}:{text})}};
    const raw=Buffer.from(JSON.stringify(value),"utf8");
    return {raw,signature:signRaw(raw,timestamp)};
  };
  const send=(fixture,signature=fixture.signature)=>app.inject({
    method:"POST",url:"/webhooks/zalo",
    headers:{"content-type":"application/json","x-zevent-signature":signature},
    payload:fixture.raw
  });
  try{
    await core.auth.bootstrapOwner({shop_id:shop,username:"owner",password,bootstrap_enabled:true});
    bootstrapped=true;
    const ownerId=(await pool.query(
      "SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[shop])).rows[0].id;
    const owner={id:ownerId,shop_id:shop,role:"owner",verified:true};

    disabled=buildIntegratedApp({pool:sql});
    await disabled.ready();
    const off=await disabled.inject({method:"POST",url:"/webhooks/zalo",
      headers:{"content-type":"application/json"},payload:"{}"});
    assert.equal(off.statusCode,503,"official route remains OFF unless explicit simulation injection is supplied");
    assert.equal(off.json().error.code,"FEATURE_UNAVAILABLE");
    await disabled.close();disabled=undefined;

    app=buildIntegratedApp({pool:sql,officialZaloSimulation:{shop_id:shop,webhook:config}});
    await app.ready();
    const initialEvent="event-"+suffix;
    const initial=signed("user_send_text",initialEvent,"In A4");
    const unregistered=await send(initial);
    assert.equal(unregistered.statusCode,503);
    assert.equal(unregistered.json().error.code,"OFFICIAL_ZALO_SCOPE_NOT_REGISTERED");
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1",[oa])).rows[0].n,0);
    await pool.query("INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)",
      [shop,oa,appId]);
    const health=(await app.inject({method:"GET",url:"/health"})).json();
    assert.equal(health.mode,"simulation");
    assert.equal(health.live_enabled,false);
    assert.equal(health.official_zalo_simulation_configured,true);
    assert.equal((await send(initial)).statusCode,200);
    assert.equal((await send(initial)).statusCode,200,"event replay remains acknowledged only after durable insert");
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2",
      [oa,initialEvent])).rows[0].n,1);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2",
      [oa,initialEvent])).rows[0].n,1);
    const reformattedInitial=Buffer.from(JSON.stringify(JSON.parse(initial.raw.toString("utf8")),null,2),"utf8");
    assert.notEqual(createHash("sha256").update(initial.raw).digest("hex"),
      createHash("sha256").update(reformattedInitial).digest("hex"));
    assert.equal((await send({raw:reformattedInitial,
      signature:signRaw(reformattedInitial,JSON.parse(initial.raw.toString("utf8")).timestamp)})).statusCode,200,
      "the same provider event ID remains idempotent across different raw JSON formatting");
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2",
      [oa,initialEvent])).rows[0].n,1);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM core_inbound_review_items WHERE shop_id=$1",[shop])).rows[0].n,0,
      "ordinary text events do not enter the image/file review queue");

    const aiOrders=createAiOrderPort({store:core.store,trusted:{shop_id:shop,oa_id:oa}});
    const proposal=await aiOrders.suggest_draft({
      conversation_id:conversation,customer_id:customer,event_ids:[initialEvent],
      text:"In A4",idempotency_key:"proposal-"+suffix,expected_generation:0
    });
    assert.equal(proposal.status,"created");
    orderId=proposal.order_id;
    const revision=(await pool.query(
      "SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1",[orderId]
    )).rows[0].request_hash;
    const processor={id:"fixture-processor",shop_id:shop,role:"processor",verified:true};
    await core.service.publishVerifiedPlan(processor,orderId,{
      expected_revision:1,plan:{ready:true,request_hash:revision,verified_by:"synthetic-test-only",
        artifact_ref:"synthetic/no-real-document",printer_id:"NO_REAL_PRINTER",
        document_pages:1,printed_faces:1,physical_sheets:1},
      idempotency_key:"plan-"+suffix
    });
    await core.service.confirm({id:"fixture-customer",shop_id:shop,customer_id:customer,
      role:"customer",verified:true},orderId,{
        expected_revision:2,kind:"request",idempotency_key:"confirm-"+suffix
      });
    const session=await core.auth.login(shop,"owner",password);

    const imageEvent="image-"+suffix;
    const image=signed("user_send_image",imageEvent);
    assert.equal((await send(image)).statusCode,200);
    assert.equal((await send(image)).statusCode,200,"identical quarantine replay is idempotent");
    const quarantine=await pool.query(
      "SELECT kind,status,customer_id,conversation_id FROM zalo_official_quarantine WHERE oa_id=$1",
      [oa]);
    assert.equal(quarantine.rows.length,1);
    assert.equal(quarantine.rows[0].kind,"image");
    assert.equal(quarantine.rows[0].status,"NEEDS_HUMAN");
    assert.equal(quarantine.rows[0].customer_id,customer);
    assert.equal(quarantine.rows[0].conversation_id,conversation);
    const imageReceipt=(await pool.query(
      "SELECT id::text FROM zalo_official_quarantine WHERE oa_id=$1 AND raw_sha256=$2",
      [oa,createHash("sha256").update(image.raw).digest("hex")])).rows[0].id;
    const imageReview=(await pool.query(
      "SELECT shop_id,oa_id,quarantine_id::text,kind,status,media_state FROM core_inbound_review_items WHERE shop_id=$1",
      [shop])).rows;
    assert.equal(imageReview.length,1,"a held image creates exactly one staff review item");
    assert.deepEqual(imageReview[0],{shop_id:shop,oa_id:oa,quarantine_id:imageReceipt,
      kind:"image",status:"NEEDS_HUMAN",media_state:"AWAITING_MEDIA"});
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2",
      [oa,imageEvent])).rows[0].n,0,"unsupported image must not enter the text queue");

    // Model a process crash after the quarantine commit but before Core's
    // queue write. The provider retry sees duplicate quarantine and repairs it.
    const fileEvent="file-replay-gap-"+suffix;
    const file=signed("user_send_file",fileEvent);
    const fileReceipt=randomUUID();
    await pool.query(
      "INSERT INTO zalo_official_quarantine(id,oa_id,raw_sha256,kind,customer_id,conversation_id,provider_claimed_event_id,status) "+
      "VALUES($1,$2,$3,'file',$4,$5,$6,'NEEDS_HUMAN')",
      [fileReceipt,oa,createHash("sha256").update(file.raw).digest("hex"),customer,conversation,fileEvent]);
    assert.equal((await send(file)).statusCode,200,"duplicate quarantine replay repairs the queue gap");
    assert.equal((await send(file)).statusCode,200,"repaired file replay remains acknowledged");
    const reviewRows=await pool.query(
      "SELECT quarantine_id::text,kind,status,media_state FROM core_inbound_review_items WHERE shop_id=$1 ORDER BY kind",
      [shop]);
    assert.equal(reviewRows.rows.length,2,"image and replayed file each have one queue item");
    assert.deepEqual(reviewRows.rows.map(r=>r.kind),["file","image"]);
    assert.equal(reviewRows.rows[0].quarantine_id,fileReceipt);
    assert.ok(reviewRows.rows.every(r=>r.status==="NEEDS_HUMAN"&&r.media_state==="AWAITING_MEDIA"));

    const visibleQueue=await app.inject({method:"GET",url:"/api/v1/inbound-review-items",
      headers:{authorization:"Bearer "+session.token}});
    assert.equal(visibleQueue.statusCode,200,visibleQueue.body);
    const visibleItems=visibleQueue.json().items;
    assert.equal(visibleItems.length,2);
    assert.ok(visibleItems.every(item=>item.status==="NEEDS_HUMAN"&&item.media_state==="AWAITING_MEDIA"));
    assert.ok(visibleItems.every(item=>Object.keys(item).sort().join(",")===
      ["id","kind","mapped_customer","media_state","raw_event_sha256","received_at","status"].sort().join(",")),
      "staff queue returns safe metadata without raw payload, URL, filename, or media bytes");

    const rejected=await app.inject({method:"POST",url:"/webhooks/zalo",
      headers:{"content-type":"application/json","x-zevent-signature":"mac="+"0".repeat(64)},
      payload:Buffer.from(JSON.stringify({app_id:appId,event_id:"bad-"+suffix,user_id_by_app:sender,
        timestamp:Date.now(),event_name:"user_send_image",sender:{id:sender},recipient:{id:oa},
        message:{msg_id:"message-bad-"+suffix}}))});
    assert.equal(rejected.statusCode,403);
    const rejectedSignatureCount=(await pool.query(
      "SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1",[oa])).rows[0].n;
    assert.equal(rejectedSignatureCount,2,
      "the synthetic image and file receipts remain quarantined; invalid signature adds no row");

    const approval=await app.inject({method:"POST",
      url:"/api/v1/orders/"+orderId+"/approvals",
      headers:{authorization:"Bearer "+session.token},
      payload:{expected_revision:2,acknowledge_deposit_shortage:false,
        idempotency_key:"approval-"+suffix}
    });
    assert.equal(approval.statusCode,409,approval.body);
    assert.equal(approval.json().error.code,"PENDING_INBOUND_REVIEW",approval.body);
    assert.equal(approval.json().error.retryable,false);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1",[orderId])).rows[0].n,0);
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1",[orderId])).rows[0].n,0);
  }finally{
    if(disabled)await disabled.close();
    if(app)await app.close();
    if(bootstrapped){
      await pool.query("DELETE FROM zalo_process_queue WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM zalo_batch_items WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM zalo_batches WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM zalo_inbound_events WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM zalo_official_quarantine WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM zalo_official_quarantine_scopes WHERE oa_id=$1",[oa]);
      await pool.query("DELETE FROM core_inbound_review_audit_events WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_inbound_review_items WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop]);
      await pool.query("DELETE FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop]);
      await pool.query("DELETE FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop]);
      await pool.query("DELETE FROM core_ai_draft_proposals WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_audit WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_idempotency WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop]);
      await pool.query("DELETE FROM core_orders WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_conversation_controls WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)",[shop]);
      await pool.query("DELETE FROM core_users WHERE shop_id=$1",[shop]);
      await pool.query("DELETE FROM core_shop_settings WHERE shop_id=$1",[shop]);
    }
    await pool.end();
  }
});
