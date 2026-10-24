import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiFault,HttpPrintPort} from '../../web/src/api.ts';
import {inboundReviewErrorMessage,inboundReviewItemCopy,parseInboundReviewItems} from '../../web/src/inbound-review.ts';

const id='e950c833-9b4b-49a5-94c8-9f2a72100001';
const item={source:'quarantine',id,kind:'image',status:'NEEDS_HUMAN',media_state:'AWAITING_MEDIA',
  raw_event_sha256:'a'.repeat(64),received_at:'2026-10-18T08:15:00.000Z',mapped_customer:false};
const colorIntake={source:'pilot_intake',id:'e950c833-9b4b-49a5-94c8-9f2a72100002',kind:'pilot_intake',
  status:'NEEDS_HUMAN',received_at:'2026-10-18T08:16:00.000Z',reason_code:'COLOR_PRINT'};
const genericIntake={source:'pilot_intake',id:'e950c833-9b4b-49a5-94c8-9f2a72100003',kind:'pilot_intake',
  status:'NEEDS_HUMAN',received_at:'2026-10-18T08:17:00.000Z'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,
  headers:{'Content-Type':'application/json'}});
const isFault=(status:number,code:string)=>(error:unknown)=>error instanceof ApiFault&&error.status===status&&error.code===code;

test('inbound review response decoder accepts exact quarantine and pilot Core projections',()=>{
 assert.deepEqual(parseInboundReviewItems({items:[item,colorIntake,genericIntake]}),[item,colorIntake,genericIntake]);
 assert.deepEqual(parseInboundReviewItems({items:[]}),[]);
 for(const bad of [
  null,{items:'not-an-array'},{items:[{...item,kind:'pdf'}]},
  {items:[{...item,source:'unknown'}]},
  {items:[{...item,status:'RECEIVED'}]},{items:[{...item,media_state:'SAVED'}]},
  {items:[{...item,raw_event_sha256:'A'.repeat(64)}]},
  {items:[{...item,received_at:'yesterday'}]},{items:[{...item,mapped_customer:0}]},
  {items:[{...item,filename:'customer-secret.docx'}]},
  {items:[{...colorIntake,reason_code:'ORDER_LOCKED'}]},
  {items:[{...genericIntake,reason_code:null}]},
  {items:[item,item]},{items:Array.from({length:101},(_,n)=>({...item,id:`e950c833-9b4b-49a5-94c8-9f2a72${String(n).padStart(6,'0')}`}))},
  {items:[item],shop_id:'client-selected-shop'},
 ])assert.throws(()=>parseInboundReviewItems(bad),/INVALID_INBOUND_REVIEW_ITEMS/);
});

test('UI names COLOR_PRINT only when Core explicitly projects that reason',()=>{
 const colorCopy=inboundReviewItemCopy(colorIntake);
 assert.equal(colorCopy.title,'Yêu cầu in màu cần nhân viên');
 assert.match(colorCopy.message,/Core đã ghi nhận lựa chọn in màu/);
 assert.match(colorCopy.message,/không tạo lệnh in tự động/);
 const genericCopy=inboundReviewItemCopy(genericIntake);
 assert.equal(genericCopy.title,'Yêu cầu cần nhân viên');
 assert.match(genericCopy.message,/chưa có lý do cụ thể được xác minh/);
 assert.doesNotMatch(genericCopy.message,/màu/i);
});

test('AWAITING_MEDIA copy states that source bytes are not available and requires staff',()=>{
 const copy=inboundReviewItemCopy(item);
 assert.equal(copy.title,'Sự kiện gửi ảnh');
 assert.match(copy.message,/Sự kiện đã được ghi nhận/);
 assert.match(copy.message,/tệp gốc chưa được lưu hoặc chưa sẵn sàng/);
 assert.match(copy.message,/Cần nhân viên xử lý/);
 assert.doesNotMatch(copy.message,/preview|đã lưu|đã xử lý/i);
 assert.equal(copy.customer,'Chưa ghép mã khách');
 assert.equal(inboundReviewItemCopy({...item,mapped_customer:true}).customer,'Đã ghép mã khách');
});

test('inbound queue GET is authenticated, tenant-neutral, bodyless and no-store',async()=>{
 const calls:Array<{url:string;method:string|undefined;body:BodyInit|null|undefined;auth:string|null;cache:RequestCache|undefined}> = [];
 const fetcher=async(url:RequestInfo|URL,options?:RequestInit):Promise<Response>=>{
  const headers=new Headers(options?.headers);
  calls.push({url:String(url),method:options?.method,body:options?.body,auth:headers.get('Authorization'),cache:options?.cache});
  if(String(url).endsWith('/api/v1/auth/login'))return json({token:'staff-token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
  if(String(url).endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
  return json({items:[item]});
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await assert.rejects(()=>port.listInboundReviewItems(),isFault(401,'UNAUTHENTICATED'));
 await port.login('shop-01','staff-01','synthetic-password');
 assert.deepEqual(await port.listInboundReviewItems(),[item]);
 const get=calls.at(-1)!;
 assert.equal(get.url,'/api/v1/inbound-review-items');
 assert.equal(get.method,undefined);
 assert.equal(get.body,undefined);
 assert.equal(get.auth,'Bearer staff-token');
 assert.equal(get.cache,'no-store');
 assert.doesNotMatch(get.url,/shop|tenant|\?/i);
});

test('inbound queue authorization, conflict, unavailable and network faults do not create data',async()=>{
 for(const [status,code] of [[401,'HTTP_401'],[403,'HTTP_403'],[409,'HTTP_409'],[503,'HTTP_503']] as const){
  const port=new HttpPrintPort('',(async(url:RequestInfo|URL)=>String(url).endsWith('/login')
    ?json({token:'token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
    :String(url).endsWith('/me')
      ?json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
      :json({error:{code:`HTTP_${status}`}},status)) as typeof fetch);
  await port.login('shop-01','staff-01','synthetic-password');
  await assert.rejects(()=>port.listInboundReviewItems(),isFault(status,code));
  assert.ok(inboundReviewErrorMessage({status}).length>0);
 }
 const offline=new HttpPrintPort('',(async(url:RequestInfo|URL)=>{
  if(String(url).endsWith('/login'))return json({token:'staff-token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
  if(String(url).endsWith('/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
  throw new Error('offline');
 }) as typeof fetch);
 await offline.login('shop-01','staff-01','synthetic-password');
 assert.match(inboundReviewErrorMessage({status:0}),/không dùng dữ liệu cũ/);
 await assert.rejects(()=>offline.listInboundReviewItems(),isFault(0,'NETWORK'));
 const unauthenticated=new HttpPrintPort('',(async()=>{throw new Error('unexpected network');}) as typeof fetch);
 await assert.rejects(()=>unauthenticated.listInboundReviewItems(),isFault(401,'UNAUTHENTICATED'));
});

test('malformed inbound response is rejected as one unavailable snapshot',async()=>{
 const port=new HttpPrintPort('',(async(url:RequestInfo|URL)=>String(url).endsWith('/login')
  ?json({token:'staff-token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
  :String(url).endsWith('/me')
   ?json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
   :json({items:[item,{...item,media_state:'SAVED'}]})) as typeof fetch);
 await port.login('shop-01','staff-01','synthetic-password');
 await assert.rejects(()=>port.listInboundReviewItems(),isFault(503,'INVALID_INBOUND_REVIEW_ITEMS'));
});
