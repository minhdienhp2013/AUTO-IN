import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {passwordHash} from '../../../backend/core/auth.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';

const url=process.env.TEST_DATABASE_URL;
test('AI0 real Fastify composition schedule GET/PATCH: scope, replay, audit and print lock',{
  skip:!url?'TEST_DATABASE_URL missing: product HTTP/PG NOT RUN':false,timeout:60000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const poolA=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
  const poolB=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
  let app;
  try{
    const core=createCoreModule({pool:asSqlPool(poolA)});
    const shop='autoin-test-schedule-http-'+randomUUID();
    const other='autoin-test-schedule-http-'+randomUUID();
    const pwd='synthetic-schedule-'+randomUUID();
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password:pwd,bootstrap_enabled:true});
    await core.auth.bootstrapOwner({shop_id:other,username:'owner',password:pwd,bootstrap_enabled:true});
    const owner=await core.auth.login(shop,'owner',pwd);
    const foreign=await core.auth.login(other,'owner',pwd);
    const staffId=randomUUID();
    await poolA.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",
      [staffId,shop,await passwordHash(pwd)]);
    const staff=await core.auth.login(shop,'staff',pwd);
    app=buildIntegratedApp({pool:asSqlPool(poolB)});
    await app.ready();
    const path='/api/v1/settings/schedule';
    const request=(method,token,payload)=>app.inject({method,url:path,
      ...(token?{headers:{authorization:'Bearer '+token}}:{}),
      ...(payload===undefined?{}:{payload})});
    const count=async()=>Number((await poolA.query(
      'SELECT count(*)::int AS n FROM core_shop_schedule_audit WHERE shop_id=$1',[shop])).rows[0].n);
    assert.equal((await request('GET')).statusCode,401);
    assert.equal((await request('PATCH',staff.token,{expected_version:1,idempotency_key:'staff',manual_lock:true})).statusCode,403);
    const get=await request('GET',staff.token);
    assert.equal(get.statusCode,200,get.body);
    assert.equal(get.headers['cache-control'],'no-store');
    assert.equal(get.json().shop_id,shop);
    assert.equal(get.json().version,1);
    assert.equal((await request('GET',foreign.token)).json().shop_id,other);
    const body={expected_version:1,idempotency_key:'schedule-'+randomUUID(),manual_lock:true};
    const changed=await request('PATCH',owner.token,body);
    assert.equal(changed.statusCode,200,changed.body);
    assert.equal(changed.headers['cache-control'],'no-store');
    assert.equal(changed.json().version,2);
    assert.equal(changed.json().manual_lock,true);
    assert.deepEqual(changed.json().operational_guard,{mode:'simulation',printing_enabled:false});
    assert.deepEqual((await request('PATCH',owner.token,body)).json(),changed.json(),
      'lost-success replay must use stored response without another version');
    assert.equal((await request('PATCH',owner.token,{...body,manual_lock:false})).statusCode,409);
    const stale=await request('PATCH',owner.token,{expected_version:1,idempotency_key:'stale-'+randomUUID(),manual_lock:false});
    assert.equal(stale.statusCode,409);
    assert.equal(stale.json().error.code,'STALE_SETTINGS_VERSION');
    assert.equal((await request('PATCH',owner.token,{...body,idempotency_key:'spoof-'+randomUUID(),shop_id:other})).statusCode,422);
    assert.equal((await request('PATCH',owner.token,null)).statusCode,422);
    assert.equal(await count(),1);
    const settings=(await poolA.query('SELECT mode,printing_enabled,manual_lock,schedule_version FROM core_shop_settings WHERE shop_id=$1',[shop])).rows[0];
    assert.equal(settings.mode,'simulation');
    assert.equal(settings.printing_enabled,false);
    assert.equal(settings.manual_lock,true);
    assert.equal(Number(settings.schedule_version),2);
    assert.equal(Number((await poolA.query('SELECT count(*)::int AS n FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id WHERE o.shop_id=$1',[shop])).rows[0].n),0);
  }finally{if(app)await app.close();await Promise.all([poolA.end(),poolB.end()]);}
});
