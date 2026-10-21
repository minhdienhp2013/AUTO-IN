import { DomainError, type Principal } from '../core/model.js';
import type { ShopScheduleService } from '../core/shop-schedule.js';
import type { OrderService } from '../core/service.js';
import type { AuthService } from '../core/auth.js';
import type { InboundReviewItem } from '../core/inbound-review-items.js';

type HttpRequest={headers:Record<string,string|undefined>;body?:unknown;params?:Record<string,string>;query?:Record<string,string>};
type HttpReply={code(status:number):HttpReply;send(value:unknown):unknown;header?(name:string,value:string):HttpReply};
type Handler=(request:HttpRequest,reply:HttpReply)=>Promise<unknown>;
// Fastify-compatible structural port: AI0 owns Fastify instance, app registration and request schema.
export interface RouteRegistrar { get(path:string,handler:Handler):void; post(path:string,handler:Handler):void; patch?(path:string,handler:Handler):void; }
export interface CoreRouteDependencies {
 service:OrderService;auth:AuthService;schedule:ShopScheduleService;
 inboundReviewReader?:{list_for_staff:(actor:Principal)=>Promise<InboundReviewItem[]>};
 // MUST validate Zalo OA signature/server credential, never accept customer role from browser request.
 resolveVerifiedCustomer:(r:HttpRequest)=>Promise<Principal>;
 // MUST authenticate scoped service/agent credentials, not a client-provided role header.
 resolvePrintAgent:(r:HttpRequest)=>Promise<Principal>;
 // AI2 ingress adapters must verify the OA signature/service identity and derive these values
 // from the verified webhook/event store; never trust identity fields from an arbitrary body.
 resolvePilotCandidate?:(r:HttpRequest)=>Promise<unknown>;
 resolvePilotCodeSubmission?:(r:HttpRequest)=>Promise<unknown>;
}
const token=(r:HttpRequest)=>r.headers.authorization?.startsWith('Bearer ')?r.headers.authorization.slice(7):'';
/** Only parsed JSON objects are allowed; do not hide untrusted request bodies behind any. */
function bodyOf<T extends object>(r:HttpRequest):T {
 const value=r.body;
 if (value===null||typeof value!=='object'||Array.isArray(value))
  throw new DomainError('INVALID_INPUT','Cần JSON object hợp lệ',422);
 return value as T;
}
function loginCredentials(r:HttpRequest){
 const value=bodyOf<{shop_id?:unknown;username?:unknown;password?:unknown}>(r);
 if(typeof value.shop_id!=='string'||!value.shop_id.trim()||
    typeof value.username!=='string'||!value.username.trim()||
    typeof value.password!=='string'||!value.password)
  throw new DomainError('INVALID_INPUT','Thiếu thông tin đăng nhập hợp lệ',422);
 return {shop_id:value.shop_id,username:value.username,password:value.password};
}
export function registerCoreRoutes(app:RouteRegistrar,d:CoreRouteDependencies):void {
 const wrap=(fn:Handler):Handler=>async(req,reply)=>{try{return await fn(req,reply);}catch(e){
  if(e instanceof DomainError)return reply.code(e.status).send({error:{code:e.code,message:e.message,retryable:e.retryable,...(e.current_revision===undefined?{}:{current_revision:e.current_revision})}});
  // Unexpected exceptions are not exposed to clients; observability belongs to AI0.
  return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'Lỗi hệ thống',retryable:false}});
 }};
 const staff=async(r:HttpRequest)=>d.auth.principal(token(r));
 const agent=async(r:HttpRequest)=>d.resolvePrintAgent(r);
 const customer=async(r:HttpRequest)=>d.resolveVerifiedCustomer(r);
 const pilotCandidate=async(r:HttpRequest)=>{
  if(!d.resolvePilotCandidate)throw new DomainError('PILOT_INGRESS_UNAVAILABLE','OA pilot ingress chưa được cấu hình',503);
  return d.resolvePilotCandidate(r);
 };
 const pilotSubmission=async(r:HttpRequest)=>{
  if(!d.resolvePilotCodeSubmission)throw new DomainError('PILOT_INGRESS_UNAVAILABLE','OA pilot ingress chưa được cấu hình',503);
  return d.resolvePilotCodeSubmission(r);
 };
 const id=(r:HttpRequest)=>r.params?.order_id??'';
 const job=(r:HttpRequest)=>r.params?.job_id??'';
 const conversation=(r:HttpRequest)=>r.params?.conversation_id??'';
 app.post('/api/v1/auth/login',wrap(async(r)=>{const c=loginCredentials(r);return d.auth.login(c.shop_id,c.username,c.password);}));
 app.post('/api/v1/auth/logout',wrap(async(r)=>{await d.auth.logout(token(r));return {ok:true};}));
 app.get('/api/v1/auth/me',wrap(async(r)=>({principal:await staff(r)})));
 app.get('/api/v1/pilot/shop-code',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.getPilotShopCode(await staff(r));
 }));
 // These internal service endpoints never accept browser bearer roles. The resolver is
 // responsible for authenticating AI2 and the OA signature. AI0 must redact request.body.code.
 app.post('/internal/v1/pilot/candidates',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.registerPilotCandidate(await pilotCandidate(r));
 }));
 app.post('/internal/v1/pilot/code-submissions',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.authorizePilotPrint(await pilotSubmission(r));
 }));
 app.get('/api/v1/inbound-review-items',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  if(!d.inboundReviewReader)throw new DomainError('INBOUND_REVIEW_UNAVAILABLE','Hàng chờ nhân viên chưa được cấu hình',503,true);
  return {items:await d.inboundReviewReader.list_for_staff(await staff(r))};
 }));
 app.get('/api/v1/settings/schedule',wrap(async(r,reply)=>{ const value=await d.schedule.get(await staff(r)); reply.header?.('Cache-Control','no-store'); return value; }));
 // Composition adapter on AI0 side must register PATCH. Existing GET/POST-only callers still compile.
 app.patch?.('/api/v1/settings/schedule',wrap(async(r,reply)=>{ const value=await d.schedule.patch(await staff(r),bodyOf<Record<string,unknown>>(r)); reply.header?.('Cache-Control','no-store'); return value; }));
 app.get('/api/v1/orders',wrap(async(r)=>({orders:await d.service.listOrders(await staff(r))})));
 app.post('/api/v1/orders',wrap(async(r)=>d.service.createDraft(await staff(r),bodyOf<Parameters<OrderService['createDraft']>[1]>(r))));
 app.get('/api/v1/orders/:order_id',wrap(async(r)=>d.service.getOrder(await staff(r),id(r))));
 app.post('/api/v1/orders/:order_id/preview-reviews',wrap(async(r)=>
  d.service.reviewPreview(await staff(r),id(r),bodyOf<Parameters<OrderService['reviewPreview']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/revisions',wrap(async(r)=>d.service.revise(await staff(r),id(r),bodyOf<Parameters<OrderService['revise']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/confirmations',wrap(async(r)=>d.service.confirm(await customer(r),id(r),bodyOf<Parameters<OrderService['confirm']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/quote',wrap(async(r)=>d.service.setQuote(await staff(r),id(r),bodyOf<Parameters<OrderService['setQuote']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/payments',wrap(async(r)=>d.service.recordPayment(await staff(r),id(r),bodyOf<Parameters<OrderService['recordPayment']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/approvals',wrap(async(r)=>d.service.approve(await staff(r),id(r),bodyOf<Parameters<OrderService['approve']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/deliveries',wrap(async(r)=>d.service.deliver(await staff(r),id(r),bodyOf<Parameters<OrderService['deliver']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/manual',wrap(async(r)=>d.service.manual(await staff(r),id(r),bodyOf<Parameters<OrderService['manual']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/close-exception',wrap(async(r)=>d.service.closePrintException(await staff(r),id(r),bodyOf<Parameters<OrderService['closePrintException']>[2]>(r))));
 app.post('/api/v1/orders/:order_id/reprint',wrap(async(r)=>d.service.approveReprint(await staff(r),id(r),bodyOf<Parameters<OrderService['approveReprint']>[2]>(r))));
 app.post('/internal/v1/print-jobs/claim',wrap(async(r)=>d.service.claim(await agent(r),bodyOf<Parameters<OrderService['claim']>[1]>(r))));
 app.post('/internal/v1/print-jobs/:job_id/preflight',wrap(async(r)=>d.service.preflight(await agent(r),job(r),bodyOf<Parameters<OrderService['preflight']>[2]>(r))));
 app.post('/internal/v1/print-jobs/:job_id/mark-sending',wrap(async(r)=>d.service.markSending(await agent(r),job(r),bodyOf<Parameters<OrderService['markSending']>[2]>(r))));
 app.post('/internal/v1/print-jobs/:job_id/reports',wrap(async(r)=>d.service.report(await agent(r),job(r),bodyOf<Parameters<OrderService['report']>[2]>(r))));
 app.post('/internal/v1/pilot/print-jobs/claim',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.claimPilot(await agent(r),bodyOf<Record<string,unknown>>(r));
 }));
 app.get('/internal/v1/pilot/print-jobs/:job_id/source',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  const source=await d.service.getPilotJobSource(await agent(r),job(r),r.headers['x-auto-in-pilot-lease']??'');
  reply.header?.('Content-Type',source.format==='DOCX'
   ?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf');
  reply.header?.('Content-Length',String(source.size_bytes));
  reply.header?.('X-AUTO-IN-Source-SHA256',source.sha256);
  reply.header?.('X-AUTO-IN-Source-Size',String(source.size_bytes));
  return reply.send(Buffer.from(source.bytes));
 }));
 app.post('/internal/v1/pilot/print-jobs/:job_id/preflight',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.preflightPilot(await agent(r),job(r),bodyOf<Record<string,unknown>>(r));
 }));
 app.post('/internal/v1/pilot/print-jobs/:job_id/mark-sending',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.markPilotSending(await agent(r),job(r),bodyOf<Record<string,unknown>>(r));
 }));
 app.post('/internal/v1/pilot/print-jobs/:job_id/reports',wrap(async(r,reply)=>{
  reply.header?.('Cache-Control','no-store');
  return d.service.reportPilot(await agent(r),job(r),bodyOf<Record<string,unknown>>(r));
 }));
 app.post('/api/v1/print-jobs/:job_id/mark-unknown',wrap(async(r)=>d.service.markUnknownForReconciliation(await staff(r),job(r),bodyOf<Parameters<OrderService['markUnknownForReconciliation']>[2]>(r))));
 app.post('/api/v1/print-jobs/:job_id/verify-paper',wrap(async(r)=>d.service.verifyPaper(await staff(r),job(r),bodyOf<Parameters<OrderService['verifyPaper']>[2]>(r))));
 app.post('/api/v1/conversations/:conversation_id/handover',wrap(async(r)=>d.service.handover(await staff(r),conversation(r),bodyOf<Parameters<OrderService['handover']>[2]>(r))));
 app.post('/api/v1/conversations/:conversation_id/return-to-ai',wrap(async(r)=>d.service.returnToAi(await staff(r),conversation(r),bodyOf<Parameters<OrderService['returnToAi']>[2]>(r))));
}
