import test from 'node:test';
import assert from 'node:assert/strict';
import {requireIntegratedSha,requireIsolatedPgEnv} from './integration-preflight.mjs';
const valid='0123456789abcdef0123456789abcdef01234567';
test('CODE305 provenance rejects unknown/short or module SHA',()=>{
 for(const sha of [undefined,'short','7066849be67dabd992cda08209584e7c861b47ca','5707b81128e7e84180db57865896d52d256dac33']){
  assert.throws(()=>requireIntegratedSha({AUTOIN_INTEGRATION_SHA:sha,AUTOIN_OPERATION_MODE:'simulation'}));
 }
});
test('CODE305 provenance rejects any live or missing operation mode',()=>{
 assert.throws(()=>requireIntegratedSha({AUTOIN_INTEGRATION_SHA:valid,AUTOIN_OPERATION_MODE:'production'}));
 assert.throws(()=>requireIntegratedSha({AUTOIN_INTEGRATION_SHA:valid}));
});
test('CODE305 provenance permits explicit distinct SHA and simulation',()=>{
 assert.equal(requireIntegratedSha({AUTOIN_INTEGRATION_SHA:valid,AUTOIN_OPERATION_MODE:'simulation'}),valid);
});
test('CODE305 PG guard requires database URL and test-only opt-in',()=>{
 const env={AUTOIN_INTEGRATION_SHA:valid,AUTOIN_OPERATION_MODE:'simulation'};
 assert.throws(()=>requireIsolatedPgEnv(env));
 assert.throws(()=>requireIsolatedPgEnv({...env,AUTOIN_TEST_DATABASE_URL:'postgres://localhost/autoin_test'}));
 assert.doesNotThrow(()=>requireIsolatedPgEnv({...env,AUTOIN_TEST_DATABASE_URL:'postgres://localhost/autoin_test',AUTOIN_ALLOW_PG_ACCEPTANCE:'YES_ISOLATED_TEST_DB'}));
});
