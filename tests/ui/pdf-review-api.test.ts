import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort } from '../../web/src/api.ts';

// Synthetic fetcher tests only. The backend preview routes are not implemented or verified here.
const orderId='12345678-1234-4234-8234-123456789abc';
const revision=4;
const requestHash='a'.repeat(64);
const route=`/api/v1/orders/${orderId}/revisions/${revision}/pdf-review-previews`;
const pageRoute=`/api/v1/orders/${orderId}/revisions/${revision}/previews/0`;
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,1]);
const sha256=async(bytes:BufferSource)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
  .map(value=>value.toString(16).padStart(2,'0')).join('');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const projection=(pageHash:string,patch:Record<string,unknown>={})=>({
  schema:'ai0.pdf_review_preview.v1',shop_id:'shop-01',order_id:orderId,revision,request_hash:requestHash,
  source_sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64),source_format:'PDF',status:'REVIEW_REQUIRED',
  pages:[{index:0,url:pageRoute,content_type:'image/png',sha256:pageHash,bytes:png.byteLength}],
  document_pages:1,printed_faces:1,physical_sheets:1,settings:{copies:1,paper:'A4',duplex:false,orientation:'portrait'},
  ready:false,allowed_to_print:false,requires_staff_review:true,physical_print_verified:false,...patch,
});
const fault=(status:number,code:string)=>(error:unknown)=>error instanceof ApiFault&&error.status===status&&error.code===code;
async function login(port:HttpPrintPort){await port.login('shop-01','staff-01','synthetic-test-password');}

test('synthetic API loads exact staff-scoped PDF DTO and bearer-authenticated hash-checked PNG',async()=>{
  const expectedHash=await sha256(png);
  const calls:Array<{url:string;method:string|undefined;body:BodyInit|null|undefined;auth:string|null;cache:RequestCache|undefined;accept:string|null}> = [];
  const fetcher=async(url:RequestInfo|URL,options?:RequestInit):Promise<Response>=>{
    const address=String(url),headers=new Headers(options?.headers);
    calls.push({url:address,method:options?.method,body:options?.body,auth:headers.get('Authorization'),cache:options?.cache,accept:headers.get('Accept')});
    if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address===route)return json(projection(expectedHash));
    if(address===pageRoute)return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.byteLength)}});
    throw new Error(`Unexpected synthetic request: ${address}`);
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
  const result=await port.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash});
  const post=calls.find(call=>call.url===route)!;
  const get=calls.find(call=>call.url===pageRoute)!;
  assert.equal(post.method,'POST');assert.equal(post.body,undefined);assert.equal(post.auth,'Bearer synthetic-bearer');
  assert.equal(post.cache,'no-store');assert.equal(post.url,route);
  assert.equal(get.method,'GET');assert.equal(get.auth,'Bearer synthetic-bearer');assert.equal(get.accept,'image/png');
  assert.equal(get.cache,'no-store');assert.equal(result.projection.status,'REVIEW_REQUIRED');
  assert.equal(result.pages.length,1);assert.equal(result.pages[0]?.type,'image/png');
  assert.deepEqual(new Uint8Array(await result.pages[0]!.arrayBuffer()),png);
});

test('synthetic API rejects wrong scope or unsafe flags before requesting page bytes',async()=>{
  for(const patch of [{shop_id:'other-shop'},{order_id:'other-order'},{revision:revision-1},
    {request_hash:'d'.repeat(64)},{ready:true},{allowed_to_print:true},{requires_staff_review:false},
    {physical_print_verified:true},{private_locator:'private/bucket/file.pdf'}]){
    let pageRequests=0;
    const expectedHash=await sha256(png);
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
      const address=String(url);
      if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address===route)return json(projection(expectedHash,patch));
      if(address===pageRoute){pageRequests++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
      throw new Error(`Unexpected synthetic request: ${address}`);
    };
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      (error:unknown)=>error instanceof ApiFault&&error.status===409);
    assert.equal(pageRequests,0);
  }
});

test('synthetic API fails closed on status errors, missing endpoint, network, and bad page bytes',async()=>{
  for(const status of [401,403,404,409,503]){
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>String(url).endsWith('/api/v1/auth/login')
      ?json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
      :String(url).endsWith('/api/v1/auth/me')
        ?json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
        :json({error:{code:`SYNTHETIC_${status}`}},status);
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash}),fault(status,`SYNTHETIC_${status}`));
  }
  const offline=new HttpPrintPort('',(async(url:RequestInfo|URL)=>{
    if(String(url).endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(String(url).endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    throw new Error('synthetic network failure');
  }) as typeof fetch);await login(offline);
  await assert.rejects(()=>offline.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash}),fault(0,'NETWORK'));

  for(const pageResponse of [
    new Response(png,{headers:{'Content-Type':'text/html'}}),
    new Response(new Uint8Array([...png,1]),{headers:{'Content-Type':'image/png'}}),
    new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.byteLength+1)}}),
  ]){
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
      const address=String(url),expectedHash=await sha256(png);
      if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address===route)return json(projection(expectedHash));
      if(address===pageRoute)return pageResponse;
      throw new Error(`Unexpected synthetic request: ${address}`);
    };
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      (error:unknown)=>error instanceof ApiFault&&(error.status===409||error.status===503));
  }
  const expectedHash=await sha256(png);
  const hashMismatch=new HttpPrintPort('',(async(url:RequestInfo|URL)=>{
    const address=String(url);
    if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address===route)return json(projection('e'.repeat(64)));
    if(address===pageRoute)return new Response(png,{headers:{'Content-Type':'image/png'}});
    throw new Error(`Unexpected synthetic request: ${address}`);
  }) as typeof fetch);await login(hashMismatch);
  await assert.rejects(()=>hashMismatch.loadPdfReviewPreview({order_id:orderId,revision,request_hash:requestHash}),fault(409,'PDF_PREVIEW_HASH_MISMATCH'));
  assert.ok(expectedHash.length===64);
});
