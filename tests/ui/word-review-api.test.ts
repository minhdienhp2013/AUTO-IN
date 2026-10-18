import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort } from '../../web/src/api.ts';

// Synthetic transport only. The matching Core preview routes are not on this base SHA.
const orderId='12345678-1234-4234-8234-123456789abc';
const revision=4;
const requestHash='a'.repeat(64);
const route=`/api/v1/orders/${orderId}/revisions/${revision}/word-review-previews`;
const pageRoute=`/api/v1/orders/${orderId}/word-preview/pages/1`;
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,1]);
const sha256=async(bytes:BufferSource)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
  .map(value=>value.toString(16).padStart(2,'0')).join('');
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const projection=(pageHash:string,patch:Record<string,unknown>={})=>({
  schema:'ai0.word_review_preview.v1',shop_id:'shop-01',order_id:orderId,revision,request_hash:requestHash,
  source_sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64),status:'REVIEW_REQUIRED',
  pages:[{index:1,url:pageRoute,content_type:'image/png',sha256:pageHash,bytes:png.byteLength}],
  document_pages:1,printed_faces:1,physical_sheets:1,settings:{copies:1,paper:'A4',duplex:false,orientation:'portrait'},
  ready:false,allowed_to_print:false,requires_staff_review:true,physical_print_verified:false,...patch,
});
const fault=(status:number,code:string)=>(error:unknown)=>error instanceof ApiFault&&error.status===status&&error.code===code;
async function login(port:HttpPrintPort){await port.login('shop-01','staff-01','synthetic-test-password');}

test('synthetic API posts exact Word preview request and fetches bearer-authenticated, hash-checked PNG',async()=>{
  const expectedHash=await sha256(png);
  const calls:Array<{url:string;method:string|undefined;body:BodyInit|null|undefined;auth:string|null;cache:RequestCache|undefined;accept:string|null;redirect:RequestRedirect|undefined}> = [];
  const fetcher=async(url:RequestInfo|URL,options?:RequestInit):Promise<Response>=>{
    const address=String(url),headers=new Headers(options?.headers);
    calls.push({url:address,method:options?.method,body:options?.body,auth:headers.get('Authorization'),cache:options?.cache,
      accept:headers.get('Accept'),redirect:options?.redirect});
    if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address===route)return json(projection(expectedHash));
    if(address===pageRoute)return new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.byteLength)}});
    throw new Error(`Unexpected synthetic request: ${address}`);
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
  const result=await port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash});
  const post=calls.find(call=>call.url===route)!;
  const get=calls.find(call=>call.url===pageRoute)!;
  assert.equal(post.method,'POST');assert.equal(post.body,'{}');assert.equal(post.auth,'Bearer synthetic-bearer');
  assert.equal(post.cache,'no-store');assert.equal(post.redirect,'error');assert.equal(post.url,route);
  assert.equal(get.method,'GET');assert.equal(get.auth,'Bearer synthetic-bearer');assert.equal(get.accept,'image/png');
  assert.equal(get.cache,'no-store');assert.equal(get.redirect,'error');
  assert.equal(result.projection.schema,'ai0.word_review_preview.v1');assert.equal(result.projection.status,'REVIEW_REQUIRED');
  assert.equal(result.pages.length,1);assert.equal(result.pages[0]?.type,'image/png');
  assert.deepEqual(new Uint8Array(await result.pages[0]!.arrayBuffer()),png);
});

test('synthetic API rejects wrong scope, hash, unsafe flags and extra private data before fetching pages',async()=>{
  const expectedHash=await sha256(png);
  for(const patch of [{shop_id:'other-shop'},{order_id:'other-order'},{revision:revision-1},
    {request_hash:'d'.repeat(64)},{source_sha256:'bad'},{manifest_sha256:'bad'},
    {ready:true},{allowed_to_print:true},{requires_staff_review:false},{physical_print_verified:true},
    {private_locator:'private/bundle'},
    {pages:[{index:1,url:'https://outside.invalid/image.png',content_type:'image/png',sha256:expectedHash,bytes:png.byteLength}]},
    {pages:[{index:1,url:`${pageRoute}?token=secret`,content_type:'image/png',sha256:expectedHash,bytes:png.byteLength}]}]){
    let pageRequests=0;
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
      const address=String(url);
      if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address===route)return json(projection(expectedHash,patch));
      if(address===pageRoute){pageRequests++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
      throw new Error(`Unexpected synthetic request: ${address}`);
    };
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      (error:unknown)=>error instanceof ApiFault&&error.status===409);
    assert.equal(pageRequests,0);
  }
});

test('NEEDS_HUMAN response keeps the order held and does not request page bytes',async()=>{
  let pageRequests=0;
  const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
    const address=String(url);
    if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address===route)return json(projection('d'.repeat(64),{status:'NEEDS_HUMAN',reason_code:'FONT_UNCERTAIN',pages:[]}));
    if(address===pageRoute){pageRequests++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
    throw new Error(`Unexpected synthetic request: ${address}`);
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
  const result=await port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash});
  assert.equal(result.projection.status,'NEEDS_HUMAN');assert.equal(result.pages.length,0);assert.equal(pageRequests,0);
});

test('missing route, auth, conflict, service and network failures are surfaced without fallback data',async()=>{
  for(const status of [401,403,404,409,503]){
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>String(url).endsWith('/api/v1/auth/login')
      ?json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
      :String(url).endsWith('/api/v1/auth/me')
        ?json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}})
        :json({error:{code:`SYNTHETIC_${status}`}},status);
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      fault(status,`SYNTHETIC_${status}`));
    if(status===401)assert.equal(port.authenticatedShopId(),null);
  }
  const offline=new HttpPrintPort('',(async(url:RequestInfo|URL)=>{
    if(String(url).endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(String(url).endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    throw new Error('synthetic network failure');
  }) as typeof fetch);await login(offline);
  await assert.rejects(()=>offline.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash}),fault(0,'NETWORK'));
});

test('page authorization/errors and a logout race never return a stale preview result',async()=>{
  const expectedHash=await sha256(png);
  for(const status of [401,403,404,409,503]){
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
      const address=String(url);
      if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address===route)return json(projection(expectedHash));
      if(address===pageRoute)return json({error:{code:`PAGE_${status}`}},status);
      throw new Error(`Unexpected synthetic request: ${address}`);
    };
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      (error:unknown)=>error instanceof ApiFault&&error.status===status);
    if(status===401)assert.equal(port.authenticatedShopId(),null);
  }

  let releasePage:(response:Response)=>void=()=>{};
  let pageStarted:()=>void=()=>{};
  const pageWaiting=new Promise<Response>(resolve=>{releasePage=resolve;});
  const started=new Promise<void>(resolve=>{pageStarted=resolve;});
  const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
    const address=String(url);
    if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
    if(address.endsWith('/api/v1/auth/logout'))return json({ok:true});
    if(address===route)return json(projection(expectedHash));
    if(address===pageRoute){pageStarted();return pageWaiting;}
    throw new Error(`Unexpected synthetic request: ${address}`);
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
  const pending=port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash});
  await started;
  await port.logout();
  releasePage(new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.byteLength)}}));
  await assert.rejects(()=>pending,fault(401,'WORD_PREVIEW_SESSION_CHANGED'));
});

test('page payload must be a bounded matching PNG with the exact receipt hash',async()=>{
  const expectedHash=await sha256(png);
  const cases:Array<{response:(hash:string)=>Response;expected:RegExp}>=[
    {response:()=>new Response(png,{headers:{'Content-Type':'text/html'}}),expected:/PAGE_CONTENT_TYPE/},
    {response:()=>new Response(new Uint8Array([...png,1]),{headers:{'Content-Type':'image/png'}}),expected:/PAGE_SIZE_MISMATCH/},
    {response:()=>new Response(new Uint8Array(png.length).fill(1),{headers:{'Content-Type':'image/png'}}),expected:/PNG_INVALID/},
    {response:()=>new Response(png,{headers:{'Content-Type':'image/png','Content-Length':String(png.byteLength+1)}}),expected:/PAGE_SIZE_MISMATCH/},
    {response:()=>new Response(png,{headers:{'Content-Type':'image/png'}}),expected:/HASH_MISMATCH/},
  ];
  for(const [index,item] of cases.entries()){
    const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
      const address=String(url);
      if(address.endsWith('/api/v1/auth/login'))return json({token:'synthetic-bearer',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address.endsWith('/api/v1/auth/me'))return json({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}});
      if(address===route)return json(projection(index===4?'e'.repeat(64):expectedHash));
      if(address===pageRoute)return item.response(expectedHash);
      throw new Error(`Unexpected synthetic request: ${address}`);
    };
    const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
    await assert.rejects(()=>port.loadWordReviewPreview({order_id:orderId,revision,request_hash:requestHash}),
      (error:unknown)=>error instanceof ApiFault&&item.expected.test(error.code));
  }
});
