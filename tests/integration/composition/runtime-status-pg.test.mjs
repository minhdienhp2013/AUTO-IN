import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('REAL PostgreSQL: authenticated mode truth is shop-scoped, simulation-only and never enables live print',{
  skip:!databaseUrl?'TEST_DATABASE_URL missing; staff mode API NOT VERIFIED':false,
  timeout:60000
},async()=>{
  assertIsolatedSimulationDatabase(databaseUrl);
  const pool=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  let app;
  try{
    const core=createCoreModule({pool:asSqlPool(pool)});
    const shop='autoin-test-runtime-'+randomUUID();
    const foreignShop='autoin-test-runtime-'+randomUUID();
    const password='synthetic-mode-'+randomUUID();
    const otherPassword='synthetic-other-'+randomUUID();
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password,bootstrap_enabled:true});
    await core.auth.bootstrapOwner({shop_id:foreignShop,username:'owner',
      password:otherPassword,bootstrap_enabled:true});
    const owner=await core.auth.login(shop,'owner',password);
    const foreignOwner=await core.auth.login(foreignShop,'owner',otherPassword);
    app=buildIntegratedApp({pool:asSqlPool(pool)});
    await app.ready();
    const path='/api/v1/runtime-status';
    const auth=token=>({authorization:'Bearer '+token});
    assert.equal((await app.inject({method:'GET',url:path})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:path,
      headers:auth('forged')})).statusCode,401);
    const initial=await app.inject({method:'GET',url:path,headers:auth(owner.token)});
    assert.equal(initial.statusCode,200,initial.body);
    assert.equal(initial.headers['cache-control'],'no-store');
    assert.deepEqual(initial.json(),{
      server_verified:true,mode:'simulation',live_enabled:false,
      physical_print_enabled:false,manual_lock:false,preview_configured:false,
      pdf_review_preview_configured:false,word_review_preview_configured:false,
      word_review_source_configured:false,synthetic_artifact_ingest_configured:false,
      trusted_print_evidence_v1_configured:false
    });
    await pool.query('UPDATE core_shop_settings SET manual_lock=true, printing_enabled=true WHERE shop_id=$1',
      [shop]);
    const locked=(await app.inject({method:'GET',url:path,headers:auth(owner.token)})).json();
    assert.equal(locked.manual_lock,true);
    assert.equal(locked.physical_print_enabled,false);
    assert.equal(locked.live_enabled,false);
    assert.ok(!JSON.stringify(locked).includes(owner.token),'Bearer must not be exposed');
    await pool.query("UPDATE core_shop_settings SET mode='production' WHERE shop_id=$1",
      [foreignShop]);
    const other=await app.inject({method:'GET',url:path,headers:auth(foreignOwner.token)});
    assert.equal(other.statusCode,409);
    assert.equal(other.json().error.code,'SIMULATION_REQUIRED');
    const same=await app.inject({method:'GET',url:path,headers:auth(owner.token)});
    assert.equal(same.statusCode,200,'A different shop must not affect current staff');
    await pool.query("UPDATE core_shop_settings SET mode='safe' WHERE shop_id=$1",[shop]);
    const stopped=await app.inject({method:'GET',url:path,headers:auth(owner.token)});
    assert.equal(stopped.statusCode,409);
    assert.equal(stopped.json().error.code,'SIMULATION_REQUIRED');
  }finally{
    if(app)await app.close();
    await pool.end();
  }
});
