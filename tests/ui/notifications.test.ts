import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationCapability,orderFromNavigation,requestLocalNotifications} from '../../web/src/notifications.ts';

test('push navigation never uses arbitrary URLs or malformed order ids',()=>{
 assert.deepEqual(orderFromNavigation('?order_id=MD-001&revision=5'),{id:'MD-001',revision:5});
 assert.equal(orderFromNavigation('?order_id=../../etc/passwd').id,null);
 assert.equal(orderFromNavigation('?order_id=https://evil.example').id,null);
 assert.equal(orderFromNavigation('?order_id=MD-001&revision=-1').revision,null);
});

/** Isolated synthetic browser globals only; does NOT test actual Safari/Web Push. */
async function withBrowser(options:{
  secure?:boolean;sw?:boolean;missing?:boolean;state?:string;
  request?:()=>Promise<string>|string;
},run:(fake:{permission:string;requestPermission?:()=>Promise<string>|string})=>Promise<void>){
  const keys=['navigator','Notification','isSecureContext'] as const;
  const old=keys.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
  const fake={permission:options.state??'default',requestPermission:options.request};
  try{
    Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:options.secure??true});
    Object.defineProperty(globalThis,'navigator',{configurable:true,value:options.sw===false?{}:{serviceWorker:{}}});
    if(options.missing)delete (globalThis as {Notification?:unknown}).Notification;
    else Object.defineProperty(globalThis,'Notification',{configurable:true,value:fake});
    await run(fake);
  }finally{
    for(let i=0;i<keys.length;i++){
      if(old[i])Object.defineProperty(globalThis,keys[i],old[i]!);
      else delete (globalThis as unknown as Record<string,unknown>)[keys[i]];
    }
  }
}

test('unsupported without Notification, service worker, secure context or prompt API',async()=>{
  for(const spec of [{missing:true},{sw:false},{secure:false},{state:'default'},{state:'other'}]){
    let prompts=0;
    await withBrowser({
      ...spec,request:'state' in spec&&spec.state==='default'?undefined:()=>{prompts++;return 'granted';}
    },async()=>{
      assert.equal(notificationCapability(),'unsupported');
      assert.equal(await requestLocalNotifications(),'unsupported');
      assert.equal(prompts,0);
    });
  }
});

test('denied never requests again',async()=>{
  let prompts=0;
  await withBrowser({state:'denied',request:()=>{prompts++;return 'granted';}},async()=>{
    assert.equal(notificationCapability(),'permission-denied');
    assert.equal(await requestLocalNotifications(),'permission-denied');
    assert.equal(prompts,0);
  });
});

test('default prompts only on explicit invocation; unchanged permission is still default',async()=>{
  let prompts=0;
  await withBrowser({state:'default',request:async()=>{prompts++;return 'default';}},async()=>{
    assert.equal(notificationCapability(),'needs-permission');
    assert.equal(prompts,0);
    assert.equal(await requestLocalNotifications(),'needs-permission');
    assert.equal(prompts,1);
  });
});

test('granted permission never means subscribed to Web Push',async()=>{
  let prompts=0;
  await withBrowser({state:'granted',request:async()=>{prompts++;return 'granted';}},async()=>{
    assert.equal(notificationCapability(),'granted-no-subscription');
    assert.equal(await requestLocalNotifications(),'granted-no-subscription');
    assert.equal(prompts,0);
  });
});

test('default to granted then no second permission request',async()=>{
  let prompts=0;
  await withBrowser({state:'default'},async fake=>{
    fake.requestPermission=async()=>{prompts++;fake.permission='granted';return 'granted';};
    assert.equal(await requestLocalNotifications(),'granted-no-subscription');
    assert.equal(await requestLocalNotifications(),'granted-no-subscription');
    assert.equal(prompts,1);
  });
});

test('rejected permission becomes an error and explicitly retrying can recover',async()=>{
  let prompts=0;
  await withBrowser({state:'default'},async fake=>{
    fake.requestPermission=async()=>{
      prompts++;
      if(prompts===1)throw Error('synthetic permission failure');
      fake.permission='granted';
      return 'granted';
    };
    assert.equal(await requestLocalNotifications(),'permission-error');
    assert.equal(notificationCapability(),'needs-permission');
    assert.equal(await requestLocalNotifications(),'granted-no-subscription');
    assert.equal(prompts,2);
  });
});

test('synchronous throw is handled and permission denied during failure cannot retry',async()=>{
  await withBrowser({state:'default'},async fake=>{
    fake.requestPermission=()=>{throw Error('synthetic synchronous failure');};
    assert.equal(await requestLocalNotifications(),'permission-error');
    fake.requestPermission=async()=>{fake.permission='denied';throw Error('denied by browser');};
    assert.equal(await requestLocalNotifications(),'permission-denied');
    assert.equal(await requestLocalNotifications(),'permission-denied');
  });
});
