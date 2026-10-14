import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort } from '../../web/src/api.ts';

const uuid='12345678-1234-1234-1234-123456789abc';
const hash='a'.repeat(64);
const root=`/api/v1/orders/${uuid}/revisions/2/previews`;
const order={order_id:uuid,revision:2,request_hash:hash};
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const json=(value:unknown,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const catalog=()=>({order_id:uuid,revision:2,request_hash:hash,preview_verified:true,preview_count:1,
 previews:[{index:0,url:`${root}/0`,content_type:'image/png'}],
 files:[{index:0,label:'Tài liệu 1',format:'PNG',document_pages:1,printed_faces:2,
  physical_sheets:2,copies:2,paper:'A4',duplex:false,orientation:'portrait',warnings:[]}]});
const login=(port:HttpPrintPort) => port.login('shop','staff','password');
const fault=(code:string)=>(e:unknown)=>e instanceof ApiFault&&e.code===code;

test('CODE-404: authenticated catalog and PNG use Bearer, filename/hash not invented',async()=>{
 const urls:string[]=[];const credentials:string[]=[];
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const uri=String(url);urls.push(uri);credentials.push(new Headers(init?.headers).get('Authorization')??'');
  if(uri.endsWith('/login'))return json({token:'session-1',principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri.endsWith('/me'))return json({principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri===root)return json(catalog());
  if(uri===`${root}/0`)return new Response(png,{headers:{'Content-Type':'image/png'}});
  throw Error('unexpected request');
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await login(port);const view=await port.loadVerifiedPreviewPages(order);
 assert.equal(view.pages.length,1);assert.equal(view.pages[0].type,'image/png');
 assert.equal(view.files.length,1);assert.equal(view.files[0].physical_sheets,2);
 assert.equal(credentials[2],'Bearer session-1');assert.equal(credentials[3],'Bearer session-1');
 assert.equal(urls.includes(`${root}/0`),true);
});

test('CODE-404: mismatched revision/hash and missing facts never fetch PNG',async()=>{
 let images=0;
 const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
  const uri=String(url);
  if(uri.endsWith('/login'))return json({token:'session-1',principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri.endsWith('/me'))return json({principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri===root)return json({...catalog(),request_hash:'previous'});
  if(uri.includes('/previews/0')){images++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
  throw Error('unexpected');
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
 await assert.rejects(()=>port.loadVerifiedPreviewPages(order),fault('PREVIEW_UNVERIFIED'));
 assert.equal(images,0);
});

test('CODE-404: logout while catalog is in flight rejects previous session',async()=>{
 let release:((value:Response)=>void)|null=null;let imageCalls=0;
 const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
  const uri=String(url);
  if(uri.endsWith('/login'))return json({token:'session-1',principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri.endsWith('/me'))return json({principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri.endsWith('/logout'))return json({ok:true});
  if(uri===root)return new Promise<Response>(resolve=>{release=resolve;});
  if(uri===`${root}/0`){imageCalls++;return new Response(png,{headers:{'Content-Type':'image/png'}});}
  throw Error('unexpected');
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
 const pending=port.loadVerifiedPreviewPages(order);await port.logout();
 if(!release)throw Error('catalog callback missing');
 (release as (value:Response)=>void)(json(catalog()));
 await assert.rejects(()=>pending,fault('PREVIEW_SESSION_CHANGED'));
 assert.equal(imageCalls,0);
});

test('CODE-404: 401 PNG clears bearer session and prevents success',async()=>{
 const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
  const uri=String(url);
  if(uri.endsWith('/login'))return json({token:'session-1',principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri.endsWith('/me'))return json({principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
  if(uri===root)return json(catalog());
  if(uri===`${root}/0`)return json({error:{code:'UNAUTHORIZED'}},401);
  throw Error('unexpected');
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
 await assert.rejects(()=>port.loadVerifiedPreviewPages(order),fault('PREVIEW_UNAVAILABLE'));
 await assert.rejects(()=>port.me(),fault('UNAUTHENTICATED'));
});

test('CODE-404: network loss or invalid PNG never returns partially verified pages',async()=>{
 for(const mode of ['offline','wrong-png'] as const){
  const fetcher=async(url:RequestInfo|URL):Promise<Response>=>{
   const uri=String(url);
   if(uri.endsWith('/login'))return json({token:'session-1',principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
   if(uri.endsWith('/me'))return json({principal:{id:'staff-1',shop_id:'shop',role:'staff',verified:true}});
   if(uri===root)return json(catalog());
   if(mode==='offline')throw Error('network disconnected');
   return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);await login(port);
  await assert.rejects(()=>port.loadVerifiedPreviewPages(order),fault(mode==='offline'?'PREVIEW_NETWORK':'PREVIEW_INVALID_PNG'));
 }
});