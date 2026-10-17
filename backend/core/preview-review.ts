import {DomainError} from './model.js';
import type {SqlConnection} from '../storage/database.js';

export interface PreviewReviewScope {
 shop_id:string;
 order_id:string;
 revision:number;
 request_hash:string;
}
export interface PreviewReviewReceipt extends PreviewReviewScope {
 id:string;
 evidence_sha256:string;
 reviewer_id:string;
 decision:'checked';
 reviewed_at:Date;
}
export type PreviewReviewReadModel = {
 status:'missing'|'matching'|'stale';
 order_id:string;
 revision:number;
 request_hash:string;
 evidence_sha256:string|null;
 reviewer_id?:string;
 reviewed_at?:Date;
 receipt_id?:string;
};

export function previewReviewMatches(
 receipt:PreviewReviewReceipt|null|undefined,
 scope:PreviewReviewScope,
 evidenceSha256:string|null
):receipt is PreviewReviewReceipt {
 return !!receipt&&!!evidenceSha256&&receipt.shop_id===scope.shop_id&&
  receipt.order_id===scope.order_id&&receipt.revision===scope.revision&&
  receipt.request_hash===scope.request_hash&&receipt.evidence_sha256===evidenceSha256;
}

export async function matchingPreviewReview(
 db:SqlConnection,scope:PreviewReviewScope,evidenceSha256:string|null,reviewedBefore?:Date
):Promise<PreviewReviewReceipt|null>{
 if(!evidenceSha256)return null;
 const rows=await db.query<PreviewReviewReceipt>(
  'SELECT id,shop_id,order_id,revision,request_hash,evidence_sha256,reviewer_id,decision,reviewed_at '+
  'FROM core_preview_review_receipts WHERE shop_id=$1 AND order_id=$2 AND revision=$3 '+
  'AND request_hash=$4 AND evidence_sha256=$5 AND ($6::timestamptz IS NULL OR reviewed_at<=$6) '+
  'ORDER BY reviewed_at DESC,id DESC LIMIT 1',
  [scope.shop_id,scope.order_id,scope.revision,scope.request_hash,evidenceSha256,reviewedBefore??null]);
 return rows.rows[0]??null;
}

export async function requirePreviewReview(
 db:SqlConnection,scope:PreviewReviewScope,evidenceSha256:string|null,reviewedBefore?:Date
):Promise<PreviewReviewReceipt>{
 const receipt=await matchingPreviewReview(db,scope,evidenceSha256,reviewedBefore);
 if(!receipt||!previewReviewMatches(receipt,scope,evidenceSha256))
  throw new DomainError('PREVIEW_REVIEW_REQUIRED','Nhân viên cần kiểm tra đúng preview hiện hành trước khi tiếp tục',409);
 return receipt;
}

export async function previewReviewReadModel(
 db:SqlConnection,scope:PreviewReviewScope,evidenceSha256:string|null
):Promise<PreviewReviewReadModel>{
 const current=await matchingPreviewReview(db,scope,evidenceSha256);
 if(current&&previewReviewMatches(current,scope,evidenceSha256))return {
  status:'matching',order_id:scope.order_id,revision:scope.revision,
  request_hash:scope.request_hash,evidence_sha256:evidenceSha256,
  reviewer_id:current.reviewer_id,reviewed_at:current.reviewed_at,receipt_id:current.id
 };
 const latest=(await db.query<PreviewReviewReceipt>(
   'SELECT id,shop_id,order_id,revision,request_hash,evidence_sha256,reviewer_id,decision,reviewed_at '+
  'FROM core_preview_review_receipts WHERE shop_id=$1 AND order_id=$2 '+
  'ORDER BY reviewed_at DESC,id DESC LIMIT 1',[scope.shop_id,scope.order_id])).rows[0];
 return {status:latest?'stale':'missing',order_id:scope.order_id,
  revision:scope.revision,request_hash:scope.request_hash,evidence_sha256:evidenceSha256,
  ...(latest?{reviewer_id:latest.reviewer_id,reviewed_at:latest.reviewed_at,receipt_id:latest.id}:{})};
}

/** The only authority-bearing receipt DTO: returned by authenticated internal
 * print-agent preflight, never by the staff/browser read model. Keep this exact
 * nine-field shape aligned with AI3's review_receipt contract. */
export function internalReviewReceipt(receipt:PreviewReviewReceipt){
 return {
  receipt_id:receipt.id,shop_id:receipt.shop_id,order_id:receipt.order_id,
  revision:receipt.revision,request_hash:receipt.request_hash,
  evidence_sha256:receipt.evidence_sha256,reviewer_id:receipt.reviewer_id,
  reviewed_at:receipt.reviewed_at.toISOString(),decision:receipt.decision
 };
}
