import {assertStaff,type Principal} from '../core/model.js';
import type {SqlPool,SqlConnection} from '../storage/database.js';
import {prepareBoundFirstPageQuestion,SAFE_FIRST_PAGE_QUESTION,
  type FirstPageQuestionReadPort,type FirstPageQuestionScope,
  type FirstPageQuestionSnapshot} from '../conversation/first-page-question.js';
import {verifiedSyntheticSource} from './inbound-draft.js';
import type {SyntheticArtifactScope} from './synthetic-ingest.js';

type Bound={shop_id:string;order_id:string;active_revision:number;customer_id:string;
  conversation_id:string;oa_id:string;event_id:string;request_hash:string;
  request_data:unknown;source_sha256:string;artifact_ref:string;
  advisory_request_hash:string|null;advisory_sha256:string|null;metadata:unknown};
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const generic=()=>({text:SAFE_FIRST_PAGE_QUESTION,used_suggestion:false});

/** Only an authenticated server context may create a question scope. A request
 * supplies an order and revision selector, never OA/customer/conversation/SHA. */
export async function previewBoundFirstPageQuestion(pool:SqlPool,root:string,
  configured:SyntheticArtifactScope,actor:Principal,orderId:string,revision:number){
  assertStaff(actor);
  if(actor.shop_id!==configured.shop_id||!uuid.test(orderId)||
     !Number.isSafeInteger(revision)||revision<1)return generic();
  const trusted=(await pool.query<Pick<Bound,'oa_id'|'customer_id'|'conversation_id'>>(
    'SELECT d.oa_id,o.customer_id,o.conversation_id FROM core_orders o '+
    "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
    "JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation' "+
    'WHERE o.shop_id=$1 AND o.id=$2::uuid AND o.active_revision=$3 AND d.oa_id=$4',
    [actor.shop_id,orderId,revision,configured.oa_id])).rows;
  if(trusted.length!==1||!trusted[0]?.customer_id||!trusted[0].conversation_id)return generic();
  const scope:FirstPageQuestionScope={shop_id:actor.shop_id,order_id:orderId,revision,
    oa_id:trusted[0].oa_id,customer_id:trusted[0].customer_id,
    conversation_id:trusted[0].conversation_id};
  return prepareBoundFirstPageQuestion(scope,firstPageQuestionReadPort(pool,root,configured));
}

/** A single repeatable-read snapshot binds Core, inbound registration, and the
 * advisory. The same connection verifies the sealed manifest and bytes. The
 * fresh check after it rejects revisions committed while verification ran. */
export function firstPageQuestionReadPort(pool:SqlPool,root:string,
  configured:SyntheticArtifactScope):FirstPageQuestionReadPort {
  return {async read_bound(scope:Readonly<FirstPageQuestionScope>):Promise<FirstPageQuestionSnapshot|null>{
    if(scope.shop_id!==configured.shop_id||scope.oa_id!==configured.oa_id||
       !uuid.test(scope.order_id)||!Number.isSafeInteger(scope.revision)||scope.revision<1)
      return null;
    const conn=await pool.connect();
    let row:Bound|undefined;
    try{
      await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows=(await conn.query<Bound>(
        'SELECT o.shop_id,o.id::text AS order_id,o.active_revision,o.customer_id,o.conversation_id,'+
        'd.oa_id,d.event_id,r.request_hash,r.request_data,a.sha256 AS source_sha256,'+
        'a.artifact_ref,f.request_hash AS advisory_request_hash,'+
        'f.artifact_sha256 AS advisory_sha256,f.metadata '+
        'FROM core_orders o JOIN core_revisions r ON r.order_id=o.id AND r.revision=$3 '+
        "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
        'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id '+
        "JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation' "+
        'LEFT JOIN ai0_first_page_suggestions f ON f.shop_id=o.shop_id AND f.order_id=o.id AND f.revision=r.revision '+
        'WHERE o.shop_id=$1 AND o.id=$2::uuid AND o.active_revision=$3 AND d.oa_id=$4',
        [scope.shop_id,scope.order_id,scope.revision,scope.oa_id])).rows;
      if(rows.length!==1)return null;
      row=rows[0];
      if(!row||row.customer_id!==scope.customer_id||
         row.conversation_id!==scope.conversation_id||!row.advisory_request_hash||
         !row.advisory_sha256)return null;
      const documents=(row.request_data as {documents?:unknown})?.documents;
      if(!Array.isArray(documents)||documents.length!==1||
         (documents[0] as {artifact_name?:unknown})?.artifact_name!==row.artifact_ref)
        return null;
      // verifiedSyntheticSource uses this transaction's query, so the source
      // index, event linkage, and manifest proof see one database snapshot.
      const txPool:SqlPool={query:<T=Record<string,unknown>>(sql:string,args?:unknown[])=>
        conn.query<T>(sql,args),connect:async():Promise<SqlConnection>=>conn};
      const verified=await verifiedSyntheticSource(txPool,root,configured,row.event_id);
      if(verified.customer_id!==row.customer_id||
         verified.conversation_id!==row.conversation_id||
         verified.artifact_ref!==row.artifact_ref||verified.sha256!==row.source_sha256)
        return null;
    }finally{
      try{await conn.query('ROLLBACK')}finally{conn.release()}
    }
    if(!row)return null;
    const fresh=(await pool.query<Pick<Bound,'active_revision'|'request_hash'|'source_sha256'>>(
      'SELECT o.active_revision,r.request_hash,a.sha256 AS source_sha256 FROM core_orders o '+
      'JOIN core_revisions r ON r.order_id=o.id AND r.revision=$3 '+
      "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
      'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id '+
      'WHERE o.shop_id=$1 AND o.id=$2::uuid AND o.active_revision=$3 AND d.oa_id=$4',
      [scope.shop_id,scope.order_id,scope.revision,scope.oa_id])).rows;
    if(fresh.length!==1||fresh[0]?.request_hash!==row.request_hash||
       fresh[0]?.source_sha256!==row.source_sha256)return null;
    return {current:{shop_id:row.shop_id,order_id:row.order_id,
        active_revision:row.active_revision,oa_id:row.oa_id,customer_id:row.customer_id,
        conversation_id:row.conversation_id,request_hash:row.request_hash,
        source_sha256:row.source_sha256,sealed_source_verified:true},
      advisory:{shop_id:row.shop_id,order_id:row.order_id,revision:scope.revision,
        request_hash:row.advisory_request_hash!,artifact_sha256:row.advisory_sha256!,
        metadata:row.metadata}};
  }};
}
