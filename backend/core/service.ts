import { randomBytes } from 'node:crypto';
import { assertAgent, assertOwner, assertPlan, assertProcessor, assertStaff, canAccessShop, canonical, checkRevision, dbSafeInteger, DomainError, newId, nonNegativeVnd, printingAllowed, sha, shortage, type JobRow, type OrderRow, type Principal, type PrintPlan, type QuoteRow, type RevisionRow, type SettingsRow } from './model.js';
import { PgStore, type SqlConnection } from '../storage/database.js';
import { readPendingUpdates } from './pending-updates.js';
import {checkedEvidence,currentEvidence,type PrintEvidenceV1,type TrustedPrintEvidencePort} from './print-evidence.js';
import {internalReviewReceipt,previewReviewReadModel,requirePreviewReview} from './preview-review.js';
import {readWordReviewSnapshot,wordReviewPrincipalScope,type TrustedWordReviewSourceReader,type WordReviewSnapshot} from './word-review-source.js';

export class OrderService {
 constructor(private readonly store:PgStore, private readonly now:()=>Date=()=>new Date(),private readonly evidence?:TrustedPrintEvidencePort,
  private readonly wordSource?:TrustedWordReviewSourceReader){}
 private async order(db:SqlConnection,id:string,p:Principal):Promise<OrderRow>{
  const o=await this.store.one<Omit<OrderRow,'delivered_sheets'> & {delivered_sheets:string}>(db,'SELECT * FROM core_orders WHERE id=$1 FOR UPDATE',[id]);canAccessShop(p,o.shop_id);return {...o,delivered_sheets:dbSafeInteger(o.delivered_sheets,'delivered_sheets')};
 }
 private async revision(db:SqlConnection,o:OrderRow):Promise<RevisionRow>{return this.store.one(db,'SELECT * FROM core_revisions WHERE order_id=$1 AND revision=$2',[o.id,o.active_revision]);}
 private async quote(db:SqlConnection,id:string):Promise<QuoteRow|null>{const q=(await db.query<Omit<QuoteRow,'amount_vnd'|'deposit_required_vnd'> & {amount_vnd:string;deposit_required_vnd:string}>('SELECT * FROM core_quotes WHERE order_id=$1 ORDER BY quote_revision DESC LIMIT 1',[id])).rows[0];return q?{...q,amount_vnd:dbSafeInteger(q.amount_vnd,'quote.amount_vnd'),deposit_required_vnd:dbSafeInteger(q.deposit_required_vnd,'quote.deposit_required_vnd')}:null;}
 // Existing Core wire only. AI0/AI3 supply independent immutable byte/manifest evidence.
 private assertRevisionBinding(rev:RevisionRow):asserts rev is RevisionRow & {plan:PrintPlan} {
  if(sha(canonical(rev.request_data))!==rev.request_hash)
   throw new DomainError('STALE_FILE_BINDING','Nội dung file/thông số không còn đúng hash phiên bản',409);
  if(!rev.plan)throw new DomainError('PRINT_NOT_READY','Chưa có kế hoạch in tin cậy');
  assertPlan(rev.plan,rev.request_hash);
 }
 private async evidenceHash(db:SqlConnection,o:OrderRow,rev:RevisionRow):Promise<string|null>{
  if(!this.evidence)return null;
  this.assertRevisionBinding(rev);
  return currentEvidence(db,this.evidence,{shop_id:o.shop_id,order_id:o.id,revision:rev.revision,
   request_hash:rev.request_hash,plan:rev.plan});
 }
 private async verifiedEvidenceProof(db:SqlConnection,o:OrderRow,rev:RevisionRow):Promise<PrintEvidenceV1>{
  if(!this.evidence)throw new DomainError('PRINT_EVIDENCE_NOT_CONFIGURED','V1 evidence Port chưa cấu hình',503);
  this.assertRevisionBinding(rev);
  const scope={shop_id:o.shop_id,order_id:o.id,revision:rev.revision,
   request_hash:rev.request_hash,plan:rev.plan};
  try{
   const proof=await this.evidence.read_verified(db,Object.freeze(scope));
   checkedEvidence(scope,proof);
   return proof!;
  }catch(e){
   if(e instanceof DomainError)throw e;
   throw new DomainError('PRINT_EVIDENCE_UNAVAILABLE','Lỗi kiểm chứng bằng chứng in',503,true);
  }
 }
 private async assertPreviewReview(db:SqlConnection,o:OrderRow,rev:RevisionRow,evidenceHash:string|null):Promise<void>{
  if(!this.evidence)return;
  await requirePreviewReview(db,{shop_id:o.shop_id,order_id:o.id,revision:rev.revision,
   request_hash:rev.request_hash},evidenceHash);
 }
 private async assertCustomerBinding(db:SqlConnection,o:OrderRow,rev:RevisionRow,q:QuoteRow|null,
  evidenceHash:string|null=null):Promise<void>{
  const rows=await db.query<{id:string;kind:'request'|'quote';quote_revision:number|null;created_at:Date;evidence_sha256:string|null}>(
   'SELECT id,kind,quote_revision,created_at,evidence_sha256 FROM core_confirmations '+
   'WHERE order_id=$1 AND revision=$2 AND request_hash=$3 AND customer_id=$4 ORDER BY created_at,id',
   [o.id,rev.revision,rev.request_hash,o.customer_id]);
  const requests=rows.rows.filter(c=>c.kind==='request');
  if(!requests.length)throw new DomainError('STALE_CUSTOMER_CONFIRMATION','Thiếu xác nhận khách đúng đơn/hash',409);
  // A first quote can follow request confirmation; a repricing invalidates it.
  if(q && q.quote_revision>1) {
   const latest=(await db.query<{created_at:Date}>(
    'SELECT created_at FROM core_quotes WHERE order_id=$1 AND quote_revision=$2',
    [o.id,q.quote_revision])).rows[0];
   if(!latest||!requests.some(r=>new Date(r.created_at)>=new Date(latest.created_at)))
    throw new DomainError('STALE_CUSTOMER_CONFIRMATION','Báo giá đã sửa, cần xác nhận lại yêu cầu',409);
  }
  if(rev.plan && (rev.plan.physical_sheets>150||Boolean(q?.significant_cost)) &&
     (!q||!rows.rows.some(c=>c.kind==='quote'&&c.quote_revision===q.quote_revision)))
   throw new DomainError('STALE_PRICE_CONFIRMATION','Giá chưa được xác nhận đúng phiên bản',409);
  if(evidenceHash){
   const effective=[requests[requests.length-1],...(rev.plan&&
    (rev.plan.physical_sheets>150||Boolean(q?.significant_cost))?
    rows.rows.filter(c=>c.kind==='quote'&&c.quote_revision===q?.quote_revision).slice(-1):[])];
   for(const confirmation of effective){
    if(!confirmation||confirmation.evidence_sha256!==evidenceHash)
     throw new DomainError('STALE_PRINT_EVIDENCE','Cột evidence SHA ở xác nhận khách đã cũ/NULL',409);
    await requirePreviewReview(db,{shop_id:o.shop_id,order_id:o.id,revision:rev.revision,
     request_hash:rev.request_hash},evidenceHash,new Date(confirmation.created_at));
    const audit=(await db.query<{details:{evidence_sha256?:string}}>(
     "SELECT details FROM core_audit WHERE shop_id=$1 AND order_id=$2 "+
     "AND action IN ('customer.confirmed','customer.confirmed_verified_event') "+
     "AND details->>'confirmation_id'=$3 ORDER BY created_at DESC LIMIT 1",
     [o.shop_id,o.id,confirmation.id])).rows[0];
    if(audit?.details?.evidence_sha256!==evidenceHash)
     throw new DomainError('STALE_PRINT_EVIDENCE','Bằng chứng khách xác nhận đã cũ',409);
   }
  }
 }
 private quoteFingerprint(q:QuoteRow):string {
  return sha(canonical({quote_revision:q.quote_revision,amount_vnd:q.amount_vnd,
   deposit_required_vnd:q.deposit_required_vnd,significant_cost:q.significant_cost}));
 }
 private async assertJobBinding(db:SqlConnection,o:OrderRow,j:JobRow,rev:RevisionRow):Promise<void>{
  this.assertRevisionBinding(rev);
  if(j.order_id!==o.id||j.revision!==o.active_revision||j.request_hash!==rev.request_hash||
     j.printer_id!==rev.plan!.printer_id||j.cancelled_at)
   throw new DomainError('STALE_APPROVAL','Job không còn khớp file/thông số in',409);
  const a=(await db.query<{quote_revision:number|null;request_hash:string;evidence_sha256:string|null}>(
   'SELECT quote_revision,request_hash,evidence_sha256 FROM core_approvals WHERE id=$1 AND order_id=$2 AND revision=$3 AND request_hash=$4',
   [j.approval_id,o.id,o.active_revision,rev.request_hash])).rows[0];
  const q=await this.quote(db,o.id);
  if(!a||a.request_hash!==rev.request_hash||(a.quote_revision??null)!==(q?.quote_revision??null))
   throw new DomainError('STALE_APPROVAL','Duyệt không còn khớp báo giá hiện hành',409);
  const evidenceHash=await this.evidenceHash(db,o,rev);
  await this.assertPreviewReview(db,o,rev,evidenceHash);
  const binding=(await db.query<{details:{plan_sha256?:string;quote_sha256?:string|null;evidence_sha256?:string}}>(
   "SELECT details FROM core_audit WHERE shop_id=$1 AND order_id=$2 "+
   "AND action IN ('print.approved','job.reprint_owner_approved') AND details->>'approval_id'=$3 "+
   "AND details->>'job_id'=$4 ORDER BY created_at DESC LIMIT 1",
   [o.shop_id,o.id,j.approval_id,j.id])).rows[0]?.details;
  if(!binding || binding.plan_sha256!==sha(canonical(rev.plan)) ||
     (binding.quote_sha256??null)!==(q?this.quoteFingerprint(q):null))
   throw new DomainError('STALE_PRINT_BINDING','File, báo giá hoặc thông số in đã thay đổi',409);
  if(evidenceHash!==null&&(binding.evidence_sha256!==evidenceHash||
     a.evidence_sha256!==evidenceHash||j.evidence_sha256!==evidenceHash))
   throw new DomainError('STALE_PRINT_EVIDENCE','SHA nguồn/manifest/preview/settings đã đổi',409);
  await this.assertCustomerBinding(db,o,rev,q,evidenceHash);
 }
 private async received(db:SqlConnection,id:string):Promise<number>{const x=await this.store.one<{amount:string}>(db,"SELECT COALESCE(SUM(CASE WHEN direction='received' THEN amount_vnd WHEN direction='refunded' THEN -amount_vnd ELSE 0 END),0)::text AS amount FROM core_payments WHERE order_id=$1",[id]);return dbSafeInteger(x.amount,'payment.received_vnd');}
 private async requireUnsent(db:SqlConnection,o:OrderRow):Promise<void>{
  const jobs=await db.query<JobRow>('SELECT * FROM core_print_jobs WHERE order_id=$1 AND cancelled_at IS NULL FOR UPDATE',[o.id]);
  if(jobs.rows.some(j=>j.state!=='NOT_SENT')) throw new DomainError('PRINT_ALREADY_ATTEMPTED','Lệnh đã gửi hoặc không rõ, phải đối soát trước khi sửa',409);
  await db.query("UPDATE core_print_jobs SET cancelled_at=now(), claimed_by=NULL,lease_secret_hash=NULL,lease_until=NULL WHERE order_id=$1 AND state='NOT_SENT' AND cancelled_at IS NULL",[o.id]);
 }
 private async audit(db:SqlConnection,p:Principal,action:string,order_id:string,details:unknown={}):Promise<void>{await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',[newId(),p.shop_id,p.id,action,order_id,JSON.stringify(details)]);}
 async createDraft(p:Principal,input:{customer_id:string;conversation_id?:string;request_data:unknown;idempotency_key:string}){
  assertStaff(p);
  if(!input.customer_id||!input.request_data)throw new DomainError('INVALID_ORDER','Thiếu khách hoặc nội dung yêu cầu');
  return this.store.tx(db=>this.store.once(db,p,'orders.create',input.idempotency_key,input,async()=>{
   const id=newId(),hash=sha(canonical(input.request_data));
   await db.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',[id,p.shop_id,input.customer_id,input.conversation_id??null]);
   if(input.conversation_id){
    await db.query("INSERT INTO core_conversation_controls(shop_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[p.shop_id,input.conversation_id]);
   }
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',[id,hash,JSON.stringify(input.request_data)]);
   await this.audit(db,p,'order.created',id,{revision:1,request_hash:hash});
   return {order_id:id,revision:1,request_hash:hash,print_ready:false};
  }));
 }
 async revise(p:Principal,id:string,input:{expected_revision:number;request_data:unknown;idempotency_key:string}){
  assertStaff(p);
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.revise`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.print_closed||o.manual_lock) throw new DomainError('ORDER_LOCKED','Đơn đã khóa hoặc đóng xử lý in',409);
   await this.requireUnsent(db,o);
   const next=o.active_revision+1,hash=sha(canonical(input.request_data));
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,$2,$3,$4::jsonb)',[id,next,hash,JSON.stringify(input.request_data)]);
   await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1',[id,next]);
   await this.audit(db,p,'order.revised',id,{old_revision:o.active_revision,revision:next,request_hash:hash});
   return {order_id:id,revision:next,request_hash:hash,requires_reconfirmation:true};
  }));
 }
 // Trusted only: never mount this on a public staff/customer route. Processor must resolve metadata itself.
 async publishVerifiedPlan(p:Principal,id:string,input:{expected_revision:number;plan:PrintPlan;idempotency_key:string}){
  assertProcessor(p);
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.plan`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.print_closed||o.manual_lock)throw new DomainError('ORDER_LOCKED','Đơn đã bị khóa',409);
   await this.requireUnsent(db,o);
   const old=await this.revision(db,o);assertPlan(input.plan,old.request_hash);
   const next=o.active_revision+1;
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',[id,next,old.request_hash,JSON.stringify(old.request_data),JSON.stringify(input.plan)]);
   await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1',[id,next]);
   await this.audit(db,p,'plan.verified',id,{revision:next,physical_sheets:input.plan.physical_sheets});
   return {order_id:id,revision:next,requires_reconfirmation:true};
  }));
 }
 async reviewPreview(p:Principal,id:string,input:{expected_revision:number;expected_request_hash:string;
  expected_evidence_sha256:string;decision:'checked';idempotency_key:string}){
  assertStaff(p);
  if(!this.evidence)throw new DomainError('PRINT_EVIDENCE_NOT_CONFIGURED','V1 preview review cần byte verifier',503);
  if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1||
     typeof input.expected_request_hash!=='string'||!/^[0-9a-f]{64}$/.test(input.expected_request_hash)||
     typeof input.expected_evidence_sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.expected_evidence_sha256)||
     input.decision!=='checked'||typeof input.idempotency_key!=='string'||
     !input.idempotency_key.trim()||input.idempotency_key.length>128)
   throw new DomainError('INVALID_PREVIEW_REVIEW','Thiếu điều kiện phiên bản/preview hợp lệ',422);
  return this.store.tx(async db=>{
   // Keep the shared order-first lock order used by revision, approval and send gates.
   const o=await this.order(db,id,p);
   return this.store.once(db,p,`orders.${id}.preview-review`,input.idempotency_key,input,async()=>{
    checkRevision(input.expected_revision,o.active_revision);
    if(o.manual_lock||o.print_closed)throw new DomainError('ORDER_LOCKED','Đơn bị khóa/đóng',409);
    const rev=await this.revision(db,o);
    if(rev.request_hash!==input.expected_request_hash)
     throw new DomainError('STALE_REQUEST_HASH','Nội dung đơn đã đổi, cần tải lại preview',409);
    const evidenceHash=await this.evidenceHash(db,o,rev);
    if(evidenceHash!==input.expected_evidence_sha256)
     throw new DomainError('STALE_PRINT_EVIDENCE','Preview đã đổi, cần tải lại trước khi kiểm tra',409);
    const receipt_id=newId();
    const saved=await db.query<{reviewed_at:Date}>(
     `INSERT INTO core_preview_review_receipts
      (id,shop_id,order_id,revision,request_hash,evidence_sha256,reviewer_id,decision,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,'checked',$8) RETURNING reviewed_at`,
     [receipt_id,o.shop_id,o.id,rev.revision,rev.request_hash,evidenceHash,p.id,input.idempotency_key]);
    const reviewed_at=saved.rows[0]?.reviewed_at;
    if(!reviewed_at)throw new DomainError('PREVIEW_REVIEW_NOT_STORED','Không lưu được receipt kiểm preview',500);
    await this.audit(db,p,'preview.reviewed',id,{receipt_id,revision:rev.revision,
     request_hash:rev.request_hash,evidence_sha256:evidenceHash,decision:'checked'});
    return {receipt_id,order_id:id,revision:rev.revision,request_hash:rev.request_hash,
     evidence_sha256:evidenceHash,reviewer_id:p.id,reviewed_at};
   });
  });
 }
 async setQuote(p:Principal,id:string,input:{expected_revision:number;amount_vnd:number;deposit_required_vnd:number;significant_cost:boolean;idempotency_key:string}){
  assertStaff(p);nonNegativeVnd(input.amount_vnd);nonNegativeVnd(input.deposit_required_vnd);
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.quote`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.print_closed||o.manual_lock)throw new DomainError('ORDER_LOCKED','Đơn đã khóa',409);
   await this.requireUnsent(db,o);
   const old=await this.quote(db,id),next=(old?.quote_revision??0)+1;
   await db.query('INSERT INTO core_quotes(order_id,quote_revision,amount_vnd,deposit_required_vnd,significant_cost,entered_by) VALUES($1,$2,$3,$4,$5,$6)',[id,next,input.amount_vnd,input.deposit_required_vnd,input.significant_cost,p.id]);
   await this.audit(db,p,'quote.created',id,{quote_revision:next,amount_vnd:input.amount_vnd});
   return {order_id:id,quote_revision:next,requires_price_reconfirmation:true};
  }));
 }
 async confirm(p:Principal,id:string,input:{expected_revision:number;kind:'request'|'quote';quote_revision?:number;idempotency_key:string}){
  if(!p.verified||p.role!=='customer'||!p.customer_id)throw new DomainError('CUSTOMER_VERIFICATION_REQUIRED','Phải xác minh khách qua kênh/credential',403);
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.confirm.${input.kind}`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.customer_id!==p.customer_id)throw new DomainError('WRONG_CUSTOMER','Không phải khách của đơn',403);
   if(o.manual_lock||o.print_closed)throw new DomainError('ORDER_LOCKED','Đơn bị khóa',409);
   const rev=await this.revision(db,o);const q=await this.quote(db,id);
   let quote_revision:number|null=null;
   if(input.kind==='quote'){
    if(!q||q.quote_revision!==input.quote_revision)throw new DomainError('STALE_QUOTE','Giá đã thay đổi',409);
    quote_revision=q.quote_revision;
   }
   const evidenceHash=await this.evidenceHash(db,o,rev);
   await this.assertPreviewReview(db,o,rev,evidenceHash);
   const confirmation_id=newId();
   await db.query('INSERT INTO core_confirmations(id,order_id,revision,request_hash,kind,quote_revision,customer_id,channel,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[confirmation_id,id,rev.revision,rev.request_hash,input.kind,quote_revision,p.customer_id,'verified_credential',evidenceHash]);
   await this.audit(db,p,'customer.confirmed',id,{confirmation_id,revision:rev.revision,kind:input.kind,quote_revision,
    ...(evidenceHash?{evidence_sha256:evidenceHash}:{})});
   return {order_id:id,revision:rev.revision,kind:input.kind,quote_revision};
  }));
 }
 async recordPayment(p:Principal,id:string,input:{direction:'received'|'refund_approved'|'refunded';method:'cash'|'bank_transfer';amount_vnd:number;reference?:string;idempotency_key:string}){
  assertStaff(p);nonNegativeVnd(input.amount_vnd);if(input.amount_vnd===0)throw new DomainError('INVALID_MONEY','Số tiền phải lớn hơn 0');
  if(input.direction!=='received')assertOwner(p);
  // Staff-observed actual receipt; no image recognition/payment webhooks are trusted here.
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.payment`,input.idempotency_key,input,async()=>{
   // The order lock serializes concurrent payment/refund actions for this order.
   await this.order(db,id,p);
   if(input.direction!=='received'){
    const remainingCash=await this.received(db,id);
    if(input.direction==='refund_approved'){
     // Prevent approving multiple pending refunds against the same receipt.
     const pending=await this.store.one<{total:string}>(db,"SELECT COALESCE(SUM(CASE WHEN direction='refund_approved' THEN amount_vnd WHEN direction='refunded' THEN -amount_vnd ELSE 0 END),0)::text AS total FROM core_payments WHERE order_id=$1",[id]);
     const pendingAmount=dbSafeInteger(pending.total,'payment.pending_refunds');
     if(pendingAmount<0||input.amount_vnd>remainingCash-pendingAmount)
      throw new DomainError('REFUND_EXCEEDS_RECEIPTS','Số tiền duyệt hoàn vượt khoản thực nhận chưa phân bổ',422);
    }else{
     const approved=await this.store.one<{total:string}>(db,"SELECT COALESCE(SUM(CASE WHEN direction='refund_approved' THEN amount_vnd WHEN direction='refunded' THEN -amount_vnd ELSE 0 END),0)::text AS total FROM core_payments WHERE order_id=$1",[id]);
     if(dbSafeInteger(approved.total,'payment.pending_refunds')<input.amount_vnd)
      throw new DomainError('REFUND_NOT_APPROVED','Chưa duyệt đủ số tiền hoàn');
     if(input.amount_vnd>remainingCash)
      throw new DomainError('REFUND_EXCEEDS_RECEIPTS','Không thể hoàn nhiều hơn khoản tiền thực nhận còn lại',422);
    }
   }
   const pid=newId();await db.query('INSERT INTO core_payments(id,order_id,direction,method,amount_vnd,reference,verified_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[pid,id,input.direction,input.method,input.amount_vnd,input.reference??null,p.id]);
   await this.audit(db,p,'payment.'+input.direction,id,{payment_id:pid,amount_vnd:input.amount_vnd});
   return {payment_id:pid,received_vnd:await this.received(db,id)};
  }));
 }
 async approve(p:Principal,id:string,input:{expected_revision:number;quote_revision?:number;acknowledge_deposit_shortage:boolean;idempotency_key:string}){
  assertStaff(p);
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.approve`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.manual_lock||o.print_closed)throw new DomainError('ORDER_LOCKED','Đơn bị khóa/đóng',409);
   // CODE-008: inbound receipt and staff approval serialize on this order row.
   // Initial event_ids and explicitly appended reviews alone can close the gap.
   // AI2 batch DONE or an AI0 artifact draft is NOT evidence of inclusion in this revision.
   const pendingTables=await db.query<{reviews:string|null;events:string|null;proposals:string|null}>(
    "SELECT to_regclass('public.core_order_inbound_reviews')::text AS reviews,to_regclass('public.zalo_inbound_events')::text AS events,to_regclass('public.core_ai_draft_proposals')::text AS proposals")
    .catch(()=>{throw new DomainError('PENDING_INBOUND_REVIEW','Không đọc được các bảng đối soát inbound',409);});
   const tables=pendingTables.rows[0];
   // AI0 migration 005: trusted, non-secret shop↔OA/app registry.
   // Lock the Core order first, then a deterministic set of registered OA
   // scope rows. No browser-supplied OA and no customer identity inference.
   const pendingReview=(detail:string):never=>{
    throw new DomainError('PENDING_INBOUND_REVIEW',detail,409);
   };
   let registeredOas:string[]=[];
   let source:{oa_id:string;shop_id:string}[]=[];
   try{
    const relations=await db.query<{registry:string|null;quarantine:string|null;scopes:string|null}>(
     "SELECT to_regclass('public.core_shop_zalo_oa_registry')::text AS registry,"+
     "to_regclass('public.zalo_official_quarantine')::text AS quarantine,"+
     "to_regclass('public.zalo_official_quarantine_scopes')::text AS scopes");
    const installed=relations.rows[0];
    if(!installed)throw new DomainError('PENDING_INBOUND_REVIEW',
     'Không xác minh được các bảng đối soát OA',409);
    if(tables?.proposals){
     source=(await db.query<{oa_id:string;shop_id:string}>(
      'SELECT oa_id,shop_id FROM core_ai_draft_proposals WHERE order_id=$1',[id])).rows;
     if(source.length>1||source.some(x=>x.shop_id!==o.shop_id||!x.oa_id))
      pendingReview('Không xác định duy nhất OA của đơn');
    }
    // A partially installed registry/quarantine is not a usable gate.
    if(Boolean(installed.quarantine)!==Boolean(installed.scopes)||
       (!installed.registry && (installed.quarantine||source.length)))
     pendingReview('Thiếu registry hoặc bảng lưu/quản lý quarantine OA');
    if(installed.registry){
     // Stable registry snapshot: concurrent registry INSERT/DELETE/UPDATE
     // cannot change the OA set while this approval is being committed.
     await db.query('LOCK TABLE public.core_shop_zalo_oa_registry IN SHARE MODE');
     const bindings=await db.query<{oa_id:string;app_id:string}>(
      'SELECT oa_id,app_id FROM public.core_shop_zalo_oa_registry '+
      'WHERE shop_id=$1 ORDER BY oa_id,app_id',[o.shop_id]);
     if(bindings.rows.some(x=>!x.oa_id||!x.app_id)||
        new Set(bindings.rows.map(x=>x.oa_id)).size!==bindings.rows.length)
      pendingReview('Registry OA của cửa hàng không duy nhất');
     registeredOas=bindings.rows.map(x=>x.oa_id);
     if(source.length && registeredOas.filter(oa=>oa===source[0]!.oa_id).length!==1)
      pendingReview('OA của proposal không có binding duy nhất trong registry');
     if(registeredOas.length && (!installed.quarantine||!installed.scopes))
      pendingReview('OA đã đăng ký nhưng thiếu bảng quarantine hoặc scope');
     // Every shop OA is locked, including orders created manually without a proposal.
     // INSERT is required to match AI2 ingress on a previously unseen scope.
     for(const oa of registeredOas){
      await db.query(
       'INSERT INTO public.zalo_official_quarantine_scopes(oa_id) VALUES($1) '+
       'ON CONFLICT (oa_id) DO NOTHING',[oa]);
      const scope=await db.query<{oa_id:string}>(
       'SELECT oa_id FROM public.zalo_official_quarantine_scopes '+
       'WHERE oa_id=$1 FOR UPDATE',[oa]);
      if(scope.rows.length!==1||scope.rows[0]?.oa_id!==oa)
       pendingReview('Không xác minh được khóa phạm vi OA');
     }
     // Review all registered OA receipts before entering the approval/job writes.
     // Unknown/unmapped receipts hold the whole shop. Mapped receipts hold
     // a manual order for its matching customer/conversation (null chat:
     // conservatively hold any mapped receipt for the same customer).
     // Proposal orders retain the original stricter OA-wide pending guard.
     for(const oa of registeredOas){
      const pending=await db.query(
       "SELECT 1 FROM public.zalo_official_quarantine "+
       "WHERE oa_id=$1 AND status='NEEDS_HUMAN' AND ("+
       "$4::boolean OR customer_id IS NULL OR conversation_id IS NULL OR "+
       "(customer_id=$2 AND ($3::text IS NULL OR conversation_id=$3))) LIMIT 1",
       [oa,o.customer_id,o.conversation_id,source.length>0]);
      if(pending.rows.length)
       pendingReview('Còn receipt OA của khách hoặc chưa map đang chờ đối soát');
     }
    }
   }catch(error){
    // PostgreSQL failures in a scope/registry lookup MUST NOT become a 500
    // or a bypass. The enclosing transaction will roll back on this 409.
    if(error instanceof DomainError && error.code==='PENDING_INBOUND_REVIEW')throw error;
    pendingReview('Không xác minh được registry/khóa/quarantine OA');
   }
   if(tables?.proposals){
    if(source.length && (!tables.events||!tables.reviews))
     throw new DomainError('PENDING_INBOUND_REVIEW','Không đủ bảng đối soát tin/file, cấm chốt in',409);
    if(source.length){
     const pending=await db.query<{event_id:string}>(
      "SELECT e.event_id FROM core_ai_draft_proposals p "+
      "JOIN core_revisions initial ON initial.order_id=p.order_id AND initial.revision=1 "+
      "JOIN zalo_inbound_events e ON e.oa_id=p.oa_id AND e.customer_id=p.customer_id AND e.conversation_id=p.conversation_id "+
      "WHERE p.order_id=$1 AND e.payload_json->>'kind' IN ('text','image','file') "+
      "AND NOT COALESCE((initial.request_data->'event_ids') ? e.event_id,false) "+
      "AND NOT EXISTS (SELECT 1 FROM core_order_inbound_reviews r JOIN core_revisions recorded "+
      "ON recorded.order_id=r.order_id AND recorded.revision=r.revision "+
      "WHERE r.shop_id=p.shop_id AND r.oa_id=e.oa_id AND r.event_id=e.event_id "+
      "AND r.order_id=p.order_id AND r.revision<=$2 "+
      "AND COALESCE((recorded.request_data->'event_ids') ? e.event_id,false)) LIMIT 1",
      [id,o.active_revision]).catch(()=>{
       throw new DomainError('PENDING_INBOUND_REVIEW','Không đọc được event inbound của đơn',409);
      });
     if(pending.rows.length)
      throw new DomainError('PENDING_INBOUND_REVIEW','Còn tin/file khách gửi chưa đối soát vào phiên bản hiện tại',409);
    }
   }
   const rev=await this.revision(db,o);this.assertRevisionBinding(rev);
   const evidenceHash=await this.evidenceHash(db,o,rev);
   await this.assertPreviewReview(db,o,rev,evidenceHash);
   // Keep the FIRST valid customer confirmation: retries/duplicate messages must not delay queue position.
   const q=await this.quote(db,id);
   // The first confirmation counts only until a later quote revision changes.
   const confirmation=await db.query<{confirmed_at:Date|null}>(
    "SELECT MIN(c.created_at) AS confirmed_at FROM core_confirmations c "+
    "WHERE c.order_id=$1 AND c.revision=$2 AND c.request_hash=$3 AND c.kind='request' "+
    "AND c.customer_id=$4 AND ($5::int IS NULL OR c.created_at >= "+
    "(SELECT created_at FROM core_quotes WHERE order_id=$1 AND quote_revision=$5))",
    [id,rev.revision,rev.request_hash,o.customer_id,q&&q.quote_revision>1?q.quote_revision:null]);
   const requestConfirmedAt=confirmation.rows[0]?.confirmed_at;
   if(!requestConfirmedAt)throw new DomainError('CUSTOMER_NOT_CONFIRMED','Khách chưa xác nhận phiên bản hiện tại');
   let queueConfirmedAt=new Date(requestConfirmedAt);
   const needsPrice=rev.plan.physical_sheets>150||Boolean(q?.significant_cost);
   if(needsPrice){
    if(!q||q.quote_revision!==input.quote_revision)throw new DomainError('QUOTE_REQUIRED','Phải có báo giá nhân viên nhập và đúng phiên bản giá');
    const approvedQuote=await db.query<{confirmed_at:Date|null}>("SELECT MIN(created_at) AS confirmed_at FROM core_confirmations WHERE order_id=$1 AND revision=$2 AND request_hash=$3 AND kind='quote' AND quote_revision=$4",[id,rev.revision,rev.request_hash,q.quote_revision]);
    if(!approvedQuote.rows[0]?.confirmed_at)throw new DomainError('PRICE_CONFIRMATION_REQUIRED','Khách chưa xác nhận mức giá');
    queueConfirmedAt=new Date(Math.max(queueConfirmedAt.getTime(),new Date(approvedQuote.rows[0].confirmed_at).getTime()));
   }
   await this.assertCustomerBinding(db,o,rev,q,evidenceHash);
   const missing=shortage(q?.deposit_required_vnd??0,await this.received(db,id));
   if(missing>0&&!input.acknowledge_deposit_shortage)throw new DomainError('DEPOSIT_WARNING_REQUIRED','Cần xác nhận đã xem cảnh báo thiếu cọc');
   const existing=await db.query('SELECT id FROM core_print_jobs WHERE order_id=$1 AND revision=$2 AND cancelled_at IS NULL LIMIT 1',[id,rev.revision]);
   if(existing.rows.length)throw new DomainError('ALREADY_APPROVED','Phiên bản đã có lệnh, không được duyệt kép',409);
   const approval_id=newId(),job_id=newId();
   await db.query('INSERT INTO core_approvals(id,order_id,revision,request_hash,quote_revision,actor_id,deposit_short_vnd,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[approval_id,id,rev.revision,rev.request_hash,q?.quote_revision??null,p.id,missing,evidenceHash]);
   await db.query('INSERT INTO core_print_jobs(id,order_id,revision,request_hash,approval_id,printer_id,confirmed_at,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[job_id,id,rev.revision,rev.request_hash,approval_id,rev.plan.printer_id,queueConfirmedAt,evidenceHash]);
   await this.audit(db,p,'print.approved',id,{revision:rev.revision,approval_id,job_id,
    deposit_short_vnd:missing,plan_sha256:sha(canonical(rev.plan)),
    quote_sha256:q?this.quoteFingerprint(q):null,...(evidenceHash?{evidence_sha256:evidenceHash}:{})});
   return {order_id:id,revision:rev.revision,approval_id,job_id,deposit_short_vnd:missing};
  }));
 }
 private async validateJob(db:SqlConnection,p:Principal,job_id:string,lease_token:string,expected_revision:number){
  const row=await this.store.one<{order_id:string}>(db,'SELECT order_id FROM core_print_jobs WHERE id=$1',[job_id]);
  const o=await this.order(db,row.order_id,p);const j=await this.store.one<JobRow>(db,'SELECT * FROM core_print_jobs WHERE id=$1 FOR UPDATE',[job_id]);
  checkRevision(expected_revision,o.active_revision);
  const rev=await this.revision(db,o);await this.assertJobBinding(db,o,j,rev);
  if(!p.printer_ids?.includes(j.printer_id))throw new DomainError('PRINTER_SCOPE_DENIED','Agent không có quyền máy in này',403);
  if(!lease_token||sha(lease_token)!==j.lease_secret_hash||j.claimed_by!==p.id)throw new DomainError('BAD_LEASE','Lease không hợp lệ',403);
  return {o,j,rev};
 }
 private async checkGates(db:SqlConnection,o:OrderRow,j:JobRow,rev:RevisionRow):Promise<SettingsRow>{
  if(o.manual_lock||o.print_closed)throw new DomainError('MANUAL_LOCK','Đơn bị khóa xử lý in',409);
  await this.assertJobBinding(db,o,j,rev);
  const s=await this.store.one<SettingsRow>(db,'SELECT * FROM core_shop_settings WHERE shop_id=$1 FOR UPDATE',[o.shop_id]);
  if(!printingAllowed(s,this.now()))throw new DomainError('PRINT_CLOSED','Đang ngoài lịch/ngày nghỉ/khóa vận hành',409,true);
  return s;
 }
 async claim(p:Principal,input:{printer_id:string;idempotency_key:string}){
  assertAgent(p);if(!input.printer_id)throw new DomainError('PRINTER_REQUIRED','Thiếu máy in');
  if(!p.printer_ids?.includes(input.printer_id))throw new DomainError('PRINTER_SCOPE_DENIED','Agent không có quyền máy in này',403);
  return this.store.tx(db=>this.store.once(db,p,'jobs.claim',input.idempotency_key,input,async()=>{
   // Lock order first for consistent lock ordering with revise/approve/manual/mark-sending.
   const candidates=await db.query<{id:string}>(`SELECT o.id FROM core_orders o JOIN core_print_jobs j ON j.order_id=o.id
    WHERE o.shop_id=$1 AND o.active_revision=j.revision AND NOT o.manual_lock AND NOT o.print_closed
    AND j.printer_id=$2 AND j.state='NOT_SENT' AND j.cancelled_at IS NULL
    AND j.confirmed_at IS NOT NULL
    AND (j.lease_until IS NULL OR j.lease_until<now())
    ORDER BY j.confirmed_at,j.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`,[p.shop_id,input.printer_id]);
   if(!candidates.rows[0])return {job:null};
   const o=await this.order(db,candidates.rows[0].id,p);
   const jobs=await db.query<JobRow>("SELECT * FROM core_print_jobs WHERE order_id=$1 AND printer_id=$2 AND revision=$3 AND state='NOT_SENT' AND confirmed_at IS NOT NULL AND cancelled_at IS NULL AND (lease_until IS NULL OR lease_until<now()) ORDER BY confirmed_at,id FOR UPDATE SKIP LOCKED LIMIT 1",[o.id,input.printer_id,o.active_revision]);
   const job=jobs.rows[0];if(!job)return {job:null};
   const rev=await this.revision(db,o);await this.checkGates(db,o,job,rev);
   const secret=randomBytes(32).toString('base64url');
   await db.query("UPDATE core_print_jobs SET claimed_by=$2,lease_secret_hash=$3,lease_until=now()+interval '90 seconds' WHERE id=$1",[job.id,p.id,sha(secret)]);
   await this.audit(db,p,'job.claim',o.id,{job_id:job.id});
   return {job:{job_id:job.id,order_id:o.id,revision:o.active_revision,request_hash:job.request_hash,approval_id:job.approval_id,printer_id:job.printer_id,lease_token:secret,lease_seconds:90,mode:(await this.store.one<SettingsRow>(db,'SELECT * FROM core_shop_settings WHERE shop_id=$1',[o.shop_id])).mode}};
  }));
 }
 async preflight(p:Principal,job_id:string,input:{expected_revision:number;lease_token:string}){
  assertAgent(p);return this.store.tx(async db=>{
   const {o,j,rev}=await this.validateJob(db,p,job_id,input.lease_token,input.expected_revision);
   if(j.state!=='NOT_SENT'||!j.lease_until||j.lease_until<this.now())throw new DomainError('LEASE_EXPIRED','Job đã gửi hoặc lease hết hạn',409);
   const settings=await this.checkGates(db,o,j,rev);
   const base={allowed:true as const,job_id,revision:j.revision,mode:settings.mode,approval_id:j.approval_id};
   if(!this.evidence)return base;
   // Internal-only provenance envelope. Receipt authority is the exact DB row;
   // evidence fields are re-read and validated from the trusted server Port.
   const proof=await this.verifiedEvidenceProof(db,o,rev);
   const scope={shop_id:o.shop_id,order_id:o.id,revision:rev.revision,request_hash:rev.request_hash};
   const receipt=await requirePreviewReview(db,scope,proof.evidence_sha256);
   if(j.evidence_sha256!==proof.evidence_sha256)
    throw new DomainError('STALE_PRINT_EVIDENCE','Bằng chứng job không còn khớp nguồn hiện hành',409);
   return {...base,
    review_receipt:internalReviewReceipt(receipt),
    trusted_evidence:{schema:proof.schema,shop_id:proof.shop_id,order_id:proof.order_id,
     revision:proof.revision,request_hash:proof.request_hash,evidence_sha256:proof.evidence_sha256,
     settings_sha256:proof.settings_sha256,renderer_sha256:proof.renderer_sha256,
     printer_capability_sha256:proof.printer_capability_sha256,
     preview_sha256:proof.previews.map(preview=>preview.sha256),printer_id:proof.printer_id},
    trusted_job:{job_id:j.id,shop_id:o.shop_id,order_id:o.id,revision:j.revision,
     request_hash:j.request_hash,approval_id:j.approval_id,printer_id:j.printer_id,
     evidence_sha256:j.evidence_sha256,mode:settings.mode,state:j.state}
   };
  });
 }
 async markSending(p:Principal,job_id:string,input:{expected_revision:number;lease_token:string;idempotency_key:string}){
  assertAgent(p);return this.store.tx(db=>this.store.once(db,p,`jobs.${job_id}.sending`,input.idempotency_key,input,async()=>{
   const {o,j,rev}=await this.validateJob(db,p,job_id,input.lease_token,input.expected_revision);
   if(j.state!=='NOT_SENT'||!j.lease_until||j.lease_until<this.now())throw new DomainError('NOT_SENDABLE','Lệnh không còn chắc chắn chưa gửi',409);
   const settings=await this.checkGates(db,o,j,rev);
   await db.query("UPDATE core_print_jobs SET state='SENDING',mode_at_send=$2,sent_at=now(),lease_until=NULL WHERE id=$1 AND state='NOT_SENT'",[job_id,settings.mode]);
   await this.audit(db,p,'job.mark_sending',o.id,{job_id,mode:settings.mode});
   return {job_id,state:'SENDING' as const,mode:settings.mode};
  }));
 }
 async report(p:Principal,job_id:string,input:{expected_revision:number;lease_token:string;result:'sent_unverified'|'unknown'|'simulated_done';evidence_kind:'spooler'|'agent_uncertain'|'simulated';idempotency_key:string}){
  assertAgent(p);return this.store.tx(db=>this.store.once(db,p,`jobs.${job_id}.report`,input.idempotency_key,input,async()=>{
   const {o,j}=await this.validateJob(db,p,job_id,input.lease_token,input.expected_revision);
   if(j.state!=='SENDING')throw new DomainError('INVALID_JOB_STATE','Chỉ có thể report SENDING',409);
   // Evidence must match the immutable send-time mode, not a mutable shop setting.
   const sendMode=j.mode_at_send;
   const map={sent_unverified:'SENT_UNVERIFIED',unknown:'UNKNOWN',simulated_done:'SIMULATED_DONE'} as const;
   if((!sendMode && input.result!=='unknown')||(sendMode==='simulation' && input.result==='sent_unverified')||(sendMode!=='simulation' && input.result==='simulated_done')||(input.result==='sent_unverified'&&input.evidence_kind!=='spooler')||(input.result==='unknown'&&input.evidence_kind!=='agent_uncertain')||(input.result==='simulated_done'&&input.evidence_kind!=='simulated'))throw new DomainError('INVALID_EVIDENCE','Bằng chứng/trạng thái không phù hợp');
   await db.query('UPDATE core_print_jobs SET state=$2,evidence_kind=$3,reported_at=now() WHERE id=$1',[job_id,map[input.result],input.evidence_kind]);
   await this.audit(db,p,'job.report',o.id,{job_id,state:map[input.result],evidence_kind:input.evidence_kind});
   return {job_id,state:map[input.result]};
  }));
 }
 async markUnknownForReconciliation(p:Principal,job_id:string,input:{reason:string;idempotency_key:string}){
  assertStaff(p);if(!input.reason?.trim())throw new DomainError('REASON_REQUIRED','Phải ghi lý do mất kết quả gửi');
  return this.store.tx(db=>this.store.once(db,p,`jobs.${job_id}.unknown`,input.idempotency_key,input,async()=>{
   const x=await this.store.one<{order_id:string}>(db,'SELECT order_id FROM core_print_jobs WHERE id=$1',[job_id]);
   const o=await this.order(db,x.order_id,p);const j=await this.store.one<JobRow>(db,'SELECT * FROM core_print_jobs WHERE id=$1 FOR UPDATE',[job_id]);
   if(j.state!=='SENDING')throw new DomainError('INVALID_JOB_STATE','Chỉ đánh UNKNOWN khi gửi đang dở',409);
   await db.query("UPDATE core_print_jobs SET state='UNKNOWN',evidence_kind='manual_uncertain',reported_at=now() WHERE id=$1",[job_id]);
   await this.audit(db,p,'job.unknown_reconciliation',o.id,{job_id,reason:input.reason});
   return {job_id,state:'UNKNOWN' as const,requires_manual_reconciliation:true};
  }));
 }
 async verifyPaper(p:Principal,job_id:string,input:{evidence_kind:'staff_inspected'|'device_verified';physical_sheets:number;note:string;idempotency_key:string}){
  assertStaff(p);if(!Number.isSafeInteger(input.physical_sheets)||input.physical_sheets<1||typeof input.note!=='string'||!input.note.trim())throw new DomainError('INVALID_EVIDENCE','Cần số giấy và ghi chú kiểm chứng');
  // A browser/staff request cannot attest device telemetry. AI3 must wire a trusted proof Port first.
  if(input.evidence_kind==='device_verified')throw new DomainError('DEVICE_PROOF_NOT_CONNECTED','Chưa có adapter xác minh thiết bị tin cậy',503);
  return this.store.tx(db=>this.store.once(db,p,`jobs.${job_id}.verify`,input.idempotency_key,input,async()=>{
   const ref=await this.store.one<{order_id:string}>(db,'SELECT order_id FROM core_print_jobs WHERE id=$1',[job_id]);
   const o=await this.order(db,ref.order_id,p);const j=await this.store.one<JobRow>(db,'SELECT * FROM core_print_jobs WHERE id=$1 FOR UPDATE',[job_id]);
   if(j.state!=='SENT_UNVERIFIED'&&j.state!=='UNKNOWN')throw new DomainError('VERIFY_STATE','Chỉ kiểm chứng lệnh thực đã gửi/chưa rõ',409);
   if(j.mode_at_send!=='controlled_test'&&j.mode_at_send!=='production')throw new DomainError('SIMULATION_NOT_PAPER','Lệnh mô phỏng/không rõ chế độ không được xác nhận giấy thật',409);
   const rev=await this.revision(db,o);if(!rev.plan||input.physical_sheets>rev.plan.physical_sheets)throw new DomainError('PAPER_COUNT_EXCEEDS_PLAN','Số tờ kiểm chứng vượt kế hoạch in',422);
   // Partial paper is real and deliverable, but must NOT become VERIFIED_DONE.
   // UNKNOWN prevents auto-retry; missing sheets require manual reconciliation/owner reprint.
   if(dbSafeInteger((j as JobRow & {verified_sheets?:string|number}).verified_sheets??0,'job.verified_sheets')>0)
    throw new DomainError('ALREADY_VERIFIED','Giấy đã được kiểm chứng trước đó; cần đối soát',409);
   const complete=input.physical_sheets===rev.plan.physical_sheets;
   const state=complete?'VERIFIED_DONE':'UNKNOWN';
   await db.query("UPDATE core_print_jobs SET state=$2,evidence_kind=$3,verified_sheets=$4,verified_by=$5,reported_at=now() WHERE id=$1",[job_id,state,input.evidence_kind,input.physical_sheets,p.id]);
   const missing=rev.plan.physical_sheets-input.physical_sheets;
   await this.audit(db,p,'job.paper_verified',o.id,{job_id,physical_sheets:input.physical_sheets,planned_sheets:rev.plan.physical_sheets,missing_sheets:missing,evidence_kind:input.evidence_kind});
   return {job_id,state,verified_sheets:input.physical_sheets,planned_sheets:rev.plan.physical_sheets,missing_sheets:missing,requires_manual_reconciliation:!complete};
  }));
 }
 async manual(p:Principal,id:string,input:{expected_revision:number;reason:string;idempotency_key:string}){
  assertStaff(p);if(!input.reason?.trim())throw new DomainError('REASON_REQUIRED','Cần ghi lý do xử lý thủ công');
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.manual`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   await db.query('UPDATE core_orders SET manual_lock=true WHERE id=$1',[id]);
   await db.query("UPDATE core_print_jobs SET claimed_by=NULL,lease_secret_hash=NULL,lease_until=NULL WHERE order_id=$1 AND state='NOT_SENT'",[id]);
   const uncertain=await db.query("SELECT id FROM core_print_jobs WHERE order_id=$1 AND state IN ('SENDING','SENT_UNVERIFIED','UNKNOWN')",[id]);
   await this.audit(db,p,'order.manual_lock',id,{reason:input.reason,in_flight:uncertain.rows.length});
   return {order_id:id,manual_lock:true,must_reconcile_in_flight:uncertain.rows.length>0};
  }));
 }
 async deliver(p:Principal,id:string,input:{physical_sheets:number;expected_revision:number;note?:string;idempotency_key:string}){
  assertStaff(p);if(!Number.isSafeInteger(input.physical_sheets)||input.physical_sheets<1)throw new DomainError('INVALID_DELIVERY','Số tờ giao phải lớn hơn 0');
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.deliver`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   const rev=await this.revision(db,o);
   if(!rev.plan)throw new DomainError('NO_PRINT_PLAN','Thiếu kế hoạch in');
   const printed=await this.store.one<{sum:string}>(db,"SELECT COALESCE(SUM(verified_sheets),0)::text AS sum FROM core_print_jobs WHERE order_id=$1 AND (state='VERIFIED_DONE' OR (state='UNKNOWN' AND evidence_kind='staff_inspected' AND verified_sheets>0))",[id]);
   const printedSheets=dbSafeInteger(printed.sum,'printed.verified_sheets');
   const available=printedSheets-dbSafeInteger(o.delivered_sheets,'delivered_sheets');
   if(input.physical_sheets>available)throw new DomainError('PAPER_NOT_VERIFIED','Không thể ghi giao giấy chưa kiểm chứng');
   await db.query('INSERT INTO core_deliveries(id,order_id,physical_sheets,actor_id,note) VALUES($1,$2,$3,$4,$5)',[newId(),id,input.physical_sheets,p.id,input.note??null]);
   const total=dbSafeInteger(o.delivered_sheets,'delivered_sheets')+input.physical_sheets;
   if(!Number.isSafeInteger(total))throw new DomainError('DB_INTEGER_OVERFLOW','Tổng số tờ giao vượt giới hạn an toàn',500);
   await db.query('UPDATE core_orders SET delivered_sheets=$2 WHERE id=$1',[id,total]);
   await this.audit(db,p,'order.delivered',id,{delivered_sheets:input.physical_sheets,total_delivered:total});
   return {order_id:id,delivered_sheets:total,remaining_sheets:Math.max(0,printedSheets-total)};
  }));
 }
 async closePrintException(p:Principal,id:string,input:{expected_revision:number;reason:string;idempotency_key:string}){
  assertStaff(p);if(!input.reason?.trim())throw new DomainError('REASON_REQUIRED','Cần lý do đóng ngoại lệ');
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.close_exception`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   const received=await this.received(db,id);
   const paymentHistory=await db.query('SELECT id FROM core_payments WHERE order_id=$1 LIMIT 1',[id]);
   const jobs=await db.query<JobRow>('SELECT * FROM core_print_jobs WHERE order_id=$1 FOR UPDATE',[id]);
   if(jobs.rows.some(j=>j.state==='SENDING'))throw new DomainError('JOB_IN_FLIGHT','Không được giả đóng khi đang gửi lệnh',409);
   // Net balance == 0 does NOT prove there has never been a deposit or refund.
   // TN-036 reserves all orders with any payment history for the owner.
   if(p.role!=='owner'&&(paymentHistory.rows.length>0||jobs.rows.some(j=>j.state!=='NOT_SENT')))
    throw new DomainError('OWNER_REQUIRED','Đơn từng có thu/hoàn tiền hoặc đã in: chỉ chủ đóng phần in',403);
   await db.query('UPDATE core_orders SET print_closed=true,manual_lock=true,closed_reason=$2 WHERE id=$1',[id,input.reason]);
   await db.query("UPDATE core_print_jobs SET cancelled_at=now(),claimed_by=NULL,lease_secret_hash=NULL,lease_until=NULL WHERE order_id=$1 AND state='NOT_SENT' AND cancelled_at IS NULL",[id]);
   const quote=await this.quote(db,id);const rev=await this.revision(db,o);
   const owed=(quote?.amount_vnd??0)-received;const undelivered=Math.max(0,(rev.plan?.physical_sheets??0)-o.delivered_sheets);
   await this.audit(db,p,'order.print_exception_closed',id,{reason:input.reason,owed_vnd:owed,undelivered_sheets:undelivered});
   return {order_id:id,print_closed:true,delivered_sheets:o.delivered_sheets,undelivered_sheets:undelivered,receivable_vnd:Math.max(0,owed),refundable_vnd:Math.max(0,-owed)};
  }));
 }
 async approveReprint(p:Principal,id:string,input:{expected_revision:number;original_job_id:string;reason:string;idempotency_key:string}){
  assertOwner(p);if(!input.reason?.trim())throw new DomainError('REASON_REQUIRED','Cần lý do in lại');
  return this.store.tx(db=>this.store.once(db,p,`orders.${id}.reprint`,input.idempotency_key,input,async()=>{
   const o=await this.order(db,id,p);checkRevision(input.expected_revision,o.active_revision);
   if(o.print_closed||o.manual_lock)throw new DomainError('ORDER_LOCKED','Đơn đang khóa',409);
   const original=await this.store.one<JobRow>(db,'SELECT * FROM core_print_jobs WHERE id=$1 AND order_id=$2 FOR UPDATE',[input.original_job_id,id]);
   if(original.state==='NOT_SENT'||original.state==='SENDING'||original.state==='SIMULATED_DONE')throw new DomainError('NOT_REPRINTABLE','Không được in lại lệnh chưa gửi/mô phỏng',409);
   const rev=await this.revision(db,o);if(original.revision!==o.active_revision||original.request_hash!==rev.request_hash)throw new DomainError('STALE_REVISION','In lại bản cũ cần đối soát thủ công',409);
    await this.assertJobBinding(db,o,original,rev);
   if(!original.confirmed_at)throw new DomainError('QUEUE_CONFIRMATION_MISSING','Lệnh cũ thiếu xác nhận khách để xếp hàng; phải đối soát',409);
   const replayEvidence=await this.evidenceHash(db,o,rev);
   await this.assertPreviewReview(db,o,rev,replayEvidence);
   const job_id=newId();await db.query('INSERT INTO core_print_jobs(id,order_id,revision,request_hash,approval_id,printer_id,original_job_id,authorized_reprint_by,confirmed_at,evidence_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[job_id,id,rev.revision,rev.request_hash,original.approval_id,original.printer_id,original.id,p.id,original.confirmed_at??null,replayEvidence]);
   const currentQuote=await this.quote(db,id);
   await this.audit(db,p,'job.reprint_owner_approved',id,{job_id,original_job_id:original.id,
    approval_id:original.approval_id,reason:input.reason,
    plan_sha256:sha(canonical(rev.plan)),
    quote_sha256:currentQuote?this.quoteFingerprint(currentQuote):null,
    ...(this.evidence?{evidence_sha256:await this.evidenceHash(db,o,rev)}:{})});
   return {job_id,order_id:id,requires_agent_claim:true};
  }));
 }

 private async conversation(db:SqlConnection,p:Principal,conversation_id:string){
  if(typeof conversation_id!=='string'||!conversation_id.trim()||conversation_id.length>256)
   throw new DomainError('INVALID_CONVERSATION','Mã hội thoại không hợp lệ',422);
  const r=await db.query<{shop_id:string;conversation_id:string;generation:string|number;status:'AI'|'HUMAN';claimed_by:string|null}>(
   'SELECT shop_id,conversation_id,generation,status,claimed_by FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',[p.shop_id,conversation_id]);
  if(!r.rows[0])throw new DomainError('CONVERSATION_NOT_LINKED','Hội thoại chưa được backend xác minh và liên kết cửa hàng',404);
  return {...r.rows[0],generation:dbSafeInteger(r.rows[0].generation,'conversation.generation')};
 }
 /** TN-027: server-authorized handover; any concurrent worker must recheck generation. */
 async handover(p:Principal,conversation_id:string,input:{expected_generation:number;idempotency_key:string}){
  assertStaff(p);
  return this.store.tx(db=>this.store.once(db,p,`conversations.${conversation_id}.handover`,input.idempotency_key,input,async()=>{
   const c=await this.conversation(db,p,conversation_id);
   checkRevision(input.expected_generation,c.generation);
   if(c.status==='HUMAN'){
    // An AI route leaves HUMAN unclaimed; the first real staff member may accept it.
    // Never manufacture a staff actor to mark an AI-initiated handover.
    if(c.claimed_by!==null&&c.claimed_by!==p.id&&p.role!=='owner')throw new DomainError('CONVERSATION_TAKEN','Nhân viên khác đang tiếp quản',409);
    if(c.claimed_by===p.id)return {conversation_id,generation:c.generation,status:'HUMAN' as const,claimed_by:p.id};
   }
   const generation=c.generation+1;
   if(!Number.isSafeInteger(generation))throw new DomainError('GENERATION_OVERFLOW','Vượt giới hạn phiên hội thoại',500);
   await db.query("UPDATE core_conversation_controls SET generation=$3,status='HUMAN',claimed_by=$4,updated_at=now() WHERE shop_id=$1 AND conversation_id=$2",[p.shop_id,conversation_id,generation,p.id]);
   return {conversation_id,generation,status:'HUMAN' as const,claimed_by:p.id};
  }));
 }
 /** Returning control to AI is ALWAYS an explicit staff/owner action; never a timer. */
 async returnToAi(p:Principal,conversation_id:string,input:{expected_generation:number;idempotency_key:string}){
  assertStaff(p);
  return this.store.tx(db=>this.store.once(db,p,`conversations.${conversation_id}.return_to_ai`,input.idempotency_key,input,async()=>{
   const c=await this.conversation(db,p,conversation_id);
   checkRevision(input.expected_generation,c.generation);
   if(c.status!=='HUMAN')throw new DomainError('NOT_HUMAN_CONTROLLED','Hội thoại không ở chế độ nhân viên',409);
   if(c.claimed_by!==p.id&&p.role!=='owner')throw new DomainError('CONVERSATION_TAKEN','Chỉ nhân viên tiếp quản hoặc chủ được trả AI',403);
   const generation=c.generation+1;
   if(!Number.isSafeInteger(generation))throw new DomainError('GENERATION_OVERFLOW','Vượt giới hạn phiên hội thoại',500);
   await db.query("UPDATE core_conversation_controls SET generation=$3,status='AI',claimed_by=NULL,updated_at=now() WHERE shop_id=$1 AND conversation_id=$2",[p.shop_id,conversation_id,generation]);
   return {conversation_id,generation,status:'AI' as const,claimed_by:null};
  }));
 }
 /** AI2 must use this verified server-side gate for outbound reservation/send.
  * It holds the PostgreSQL row lock through the callback; no timer can enable AI.
  * AI2 must keep its durable outbound journal and provider acknowledgments separate.
  */
 async withAiSendGate<T>(trusted_scope:{shop_id:string;conversation_id:string;generation:number},send:()=>Promise<T>):Promise<T>{
  if(!trusted_scope?.shop_id||!trusted_scope.conversation_id||!Number.isSafeInteger(trusted_scope.generation))
   throw new DomainError('INVALID_CONVERSATION_GATE','Thiếu scope/generation tin cậy',403);
  return this.store.tx(async db=>{
   const r=await db.query<{generation:string|number;status:string}>(
    'SELECT generation,status FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',
    [trusted_scope.shop_id,trusted_scope.conversation_id]);
   const c=r.rows[0];
   if(!c||c.status!=='AI'||dbSafeInteger(c.generation,'conversation.generation')!==trusted_scope.generation)
    throw new DomainError('AI_REPLY_BLOCKED','Hội thoại đã thay đổi quyền/generation',409);
   return send();
  });
 }
 async getOrder(p:Principal,id:string){
  assertStaff(p);return this.store.tx(async db=>{
   const o=await this.order(db,id,p);
   const revisions=await db.query<RevisionRow>('SELECT * FROM core_revisions WHERE order_id=$1 ORDER BY revision',[id]);
   const current=revisions.rows.find(r=>r.revision===o.active_revision);
   if(!current)throw new DomainError('REVISION_NOT_FOUND','Không có phiên bản hiện hành',500);
   const jobs=await db.query<JobRow & {created_at:Date;evidence_kind:string|null;verified_sheets:number|string;cancelled_at:Date|null}>(
    'SELECT id,order_id,revision,request_hash,approval_id,state,printer_id,confirmed_at,created_at,mode_at_send,evidence_kind,verified_sheets,cancelled_at,evidence_sha256 FROM core_print_jobs WHERE order_id=$1 ORDER BY created_at',[id]);
   const quote=await this.quote(db,id),received=await this.received(db,id);
   const confirmations=await db.query<{id:string;revision:number;request_hash:string;quote_revision:number|null;kind:'request'|'quote';created_at:Date;customer_id:string;evidence_sha256:string|null}>(
    'SELECT id,revision,request_hash,quote_revision,kind,created_at,customer_id,evidence_sha256 FROM core_confirmations WHERE order_id=$1 AND revision=$2 AND request_hash=$3 ORDER BY created_at,id',[id,current.revision,current.request_hash]);
   const approvals=await db.query<{id:string;revision:number;request_hash:string;quote_revision:number|null;actor_id:string;created_at:Date;deposit_short_vnd:string|number;evidence_sha256:string|null}>(
    'SELECT id,revision,request_hash,quote_revision,actor_id,created_at,deposit_short_vnd,evidence_sha256 FROM core_approvals WHERE order_id=$1 AND revision=$2 AND request_hash=$3 ORDER BY created_at DESC',[id,current.revision,current.request_hash]);
   let verifiedPlan:PrintPlan|null=null;
   if(current.plan){try{
    if(sha(canonical(current.request_data))!==current.request_hash)
     throw new DomainError('STALE_FILE_BINDING','Request/hash mismatch',409);
    assertPlan(current.plan,current.request_hash);verifiedPlan=current.plan;
   }catch{verifiedPlan=null;}}
   const needsPrice=Boolean(verifiedPlan && (verifiedPlan.physical_sheets>150 || quote?.significant_cost));
   // V1 evidence-gated read model: an old approval/confirmation must not look
   // current to staff after source bytes, manifest, settings or preview change.
   let visibleEvidence:string|null=null;
   let printEvidence:{schema:'ai0.print_evidence.v1';order_id:string;revision:number;request_hash:string;evidence_sha256:string}|null=null;
   let currentEvidenceConfirmIds:Set<string>|null=null;
   if(this.evidence){
    try{
     const evidenceSha256=await this.evidenceHash(db,o,current);
     if(!evidenceSha256)throw new DomainError('PRINT_EVIDENCE_NOT_CONFIGURED','Không đọc được evidence hiện hành',503);
     visibleEvidence=evidenceSha256;
     printEvidence={schema:'ai0.print_evidence.v1',order_id:id,revision:current.revision,
      request_hash:current.request_hash,evidence_sha256:evidenceSha256};
     const bound=await db.query<{confirmation_id:string}>(
      "SELECT details->>'confirmation_id' AS confirmation_id FROM core_audit "+
      "WHERE shop_id=$1 AND order_id=$2 AND details->>'evidence_sha256'=$3 "+
      "AND action IN ('customer.confirmed','customer.confirmed_verified_event')",
      [o.shop_id,id,visibleEvidence]);
     currentEvidenceConfirmIds=new Set(bound.rows.map(c=>c.confirmation_id));
    }catch{
     visibleEvidence=null;
     printEvidence=null;
     currentEvidenceConfirmIds=new Set();
    }
   }
   const previewReview=this.evidence?await previewReviewReadModel(db,{shop_id:o.shop_id,
    order_id:id,revision:current.revision,request_hash:current.request_hash},visibleEvidence):null;
   const quoteCutoff=quote&&quote.quote_revision>1
    ? (await db.query<{created_at:Date}>('SELECT created_at FROM core_quotes WHERE order_id=$1 AND quote_revision=$2',
      [id,quote.quote_revision])).rows[0]?.created_at : null;
   const requestConfirmation=(sha(canonical(current.request_data))===current.request_hash?
    confirmations.rows.find(c=>c.kind==='request' && c.customer_id===o.customer_id &&
     (!currentEvidenceConfirmIds||(currentEvidenceConfirmIds.has(c.id)&&c.evidence_sha256===visibleEvidence)) &&
    (!quote||quote.quote_revision<=1||(quoteCutoff && new Date(c.created_at)>=new Date(quoteCutoff)))):null)??null;
   const priceConfirmation=quote?confirmations.rows.find(c=>c.kind==='quote'&&
    c.customer_id===o.customer_id&&c.quote_revision===quote.quote_revision&&
    (!currentEvidenceConfirmIds||(currentEvidenceConfirmIds.has(c.id)&&c.evidence_sha256===visibleEvidence)))??null:null;
   // Readiness facts are backend-derived for THIS revision, not any earlier request/quote.
   const existingActiveJob=jobs.rows.find(j=>j.revision===current.revision&&j.request_hash===current.request_hash&&!j.cancelled_at);
   const matchedApproval=existingActiveJob?approvals.rows.find(a=>a.id===existingActiveJob.approval_id&&( !needsPrice||a.quote_revision===quote?.quote_revision)&&
    (!this.evidence||(visibleEvidence!==null&&a.evidence_sha256===visibleEvidence&&existingActiveJob.evidence_sha256===visibleEvidence)))??null:null;
   const quoteMatches=(matchedApproval?.quote_revision??null)===(quote?.quote_revision??null);
   const auditFingerprint=matchedApproval&&existingActiveJob?(
    await db.query<{details:{plan_sha256?:string;quote_sha256?:string|null;evidence_sha256?:string}}>(
     "SELECT details FROM core_audit WHERE shop_id=$1 AND order_id=$2 AND action IN ('print.approved','job.reprint_owner_approved') "+
     "AND details->>'approval_id'=$3 AND details->>'job_id'=$4 ORDER BY created_at DESC LIMIT 1",
     [o.shop_id,id,matchedApproval.id,existingActiveJob.id])).rows[0]?.details:null;
   const fingerprintMatches=Boolean(verifiedPlan&&auditFingerprint &&
    auditFingerprint.plan_sha256===sha(canonical(verifiedPlan)) &&
    (auditFingerprint.quote_sha256??null)===(quote?this.quoteFingerprint(quote):null) &&
    (!this.evidence||(visibleEvidence!==null&&auditFingerprint.evidence_sha256===visibleEvidence)));
   const approval=verifiedPlan&&requestConfirmation&&(!needsPrice||priceConfirmation)&&
    quoteMatches&&fingerprintMatches&&existingActiveJob?.printer_id===verifiedPlan.printer_id?matchedApproval:null;
   const jobRows=jobs.rows.map(j=>{
    const rev=revisions.rows.find(x=>x.revision===j.revision);
    const planned=rev?.plan && rev.plan.ready && rev.plan.request_hash===j.request_hash ? rev.plan.physical_sheets : null;
    const sheets=dbSafeInteger(j.verified_sheets,'job.verified_sheets');
    return {...j,verified_sheets:sheets,planned_sheets:planned,
     missing_sheets:planned===null?null:Math.max(0,planned-sheets),
     paper_complete:planned!==null&&j.state==='VERIFIED_DONE'&&
     (j.mode_at_send==='controlled_test'||j.mode_at_send==='production')&&sheets===planned};
   });
   const realVerified=jobRows.filter(j=>(j.mode_at_send==='controlled_test'||j.mode_at_send==='production')&&
      (j.state==='VERIFIED_DONE'||(j.state==='UNKNOWN'&&j.evidence_kind==='staff_inspected'&&j.verified_sheets>0)))
    .reduce((sum,j)=>sum+j.verified_sheets,0);
   if(!Number.isSafeInteger(realVerified))throw new DomainError('DB_INTEGER_OVERFLOW','Số giấy vượt giới hạn',500);
   const planned=verifiedPlan?.physical_sheets??null;
   const safelyVerified=planned!==null?Math.min(planned,realVerified):realVerified;
   const previewRef=verifiedPlan?.preview_verified===true && typeof verifiedPlan.preview_ref==='string' && verifiedPlan.preview_ref.trim()
    ?verifiedPlan.preview_ref:null;
   const conversation=o.conversation_id
    ? (await db.query<{status:'AI'|'HUMAN';generation:string|number;claimed_by:string|null}>(
      'SELECT status,generation,claimed_by FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[p.shop_id,o.conversation_id])).rows[0]??null
    :null;
   const pendingUpdates=await readPendingUpdates(db,{
    order_id:id,shop_id:o.shop_id,customer_id:o.customer_id,
    conversation_id:o.conversation_id,revision:current.revision,
    request_hash:current.request_hash,verified_plan_ready:verifiedPlan!==null
   });
   return {order:o,revisions:revisions.rows,jobs:jobRows,quote,received_vnd:received,
    receivable_vnd:Math.max(0,(quote?.amount_vnd??0)-received),
    refundable_vnd:Math.max(0,received-(quote?.amount_vnd??0)),
    current:{
     revision:current.revision,request_hash:current.request_hash,
     print_evidence:printEvidence,preview_review:previewReview,
     pending_updates:pendingUpdates,verified_plan:verifiedPlan,preview_ref:previewRef,
     request_confirmation:requestConfirmation,price_confirmation:priceConfirmation,
     requires_price_confirmation:needsPrice,approval:approval?{...approval,deposit_short_vnd:dbSafeInteger(approval.deposit_short_vnd,'approval.deposit_short_vnd')}:null,
     queue_confirmed_at:existingActiveJob?.confirmed_at??null,
     request_confirmed:Boolean(requestConfirmation),price_confirmed:verifiedPlan!==null&&(!needsPrice||Boolean(priceConfirmation)),
     staff_approved:Boolean(approval)
    },
    print_progress:{
     planned_sheets:planned,verified_sheets:safelyVerified,
     missing_sheets:planned===null?null:Math.max(0,planned-safelyVerified),
     delivered_sheets:o.delivered_sheets,
     fully_verified:planned!==null&&planned>0&&safelyVerified>=planned&&!jobRows.some(j=>j.state==='UNKNOWN'||j.state==='SENT_UNVERIFIED'),
     requires_manual_reconciliation:jobRows.some(j=>j.state==='UNKNOWN'||j.state==='SENT_UNVERIFIED'||(j.verified_sheets>0&&j.paper_complete===false))
    },
    conversation_control:conversation?{...conversation,generation:dbSafeInteger(conversation.generation,'conversation.generation')}:null
   };
  });
 }
 async listOrders(p:Principal){assertStaff(p);const res=await this.store.pool.query('SELECT id,customer_id,active_revision,manual_lock,print_closed,delivered_sheets,created_at FROM core_orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 100',[p.shop_id]);return res.rows;}

 /** Read-only server-to-worker handoff. No public route serializes these bytes. */
 async readWordReviewSource(p:Principal,id:string):Promise<WordReviewSnapshot>{
  assertStaff(p);const tenantOrder=wordReviewPrincipalScope(p,id);
  if(!this.wordSource)throw new DomainError('WORD_SOURCE_NOT_CONFIGURED','Word source registry chưa được nối',503);
  return this.store.tx(async db=>{
   await db.query('SET TRANSACTION READ ONLY');
   const load=async()=>{
    const order=(await db.query<{id:string;shop_id:string;active_revision:number}>(
     'SELECT id,shop_id,active_revision FROM core_orders WHERE id=$1 AND shop_id=$2',[tenantOrder.order_id,tenantOrder.shop_id])).rows[0];
    if(!order)throw new DomainError('NOT_FOUND','Không tìm thấy đơn trong cửa hàng',404);
    const revision=(await db.query<{revision:number;request_hash:string;request_data:unknown}>(
     'SELECT revision,request_hash,request_data FROM core_revisions WHERE order_id=$1 AND revision=$2',[order.id,order.active_revision])).rows[0];
    if(!revision||revision.revision!==order.active_revision||! /^[0-9a-f]{64}$/.test(revision.request_hash)||
       sha(canonical(revision.request_data))!==revision.request_hash)
     throw new DomainError('STALE_FILE_BINDING','Revision/request hash hiện hành không hợp lệ',409);
    return {order,revision};
   };
   const before=await load();
   const scope={shop_id:before.order.shop_id,order_id:before.order.id,active_revision:before.order.active_revision,
    request_hash:before.revision.request_hash,request_data:before.revision.request_data};
   const snapshot=await readWordReviewSnapshot(db,this.wordSource!,scope);
   const after=await load();
   if(after.order.active_revision!==scope.active_revision||after.revision.request_hash!==scope.request_hash||
      canonical(after.revision.request_data)!==canonical(scope.request_data))
    throw new DomainError('STALE_WORD_SOURCE','Đơn đã đổi phiên bản trong lúc đọc file Word',409);
   return snapshot;
  });
 }
}
