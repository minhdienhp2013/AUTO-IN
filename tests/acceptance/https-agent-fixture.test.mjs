import test from 'node:test';import assert from 'node:assert/strict';
import {HTTPS_AGENT_SCENARIOS,validateHttpsAgentFixture as v} from './https-agent-fixture.mjs';
const sha='d3e53461a5cc71d0b96b24b069b5240ca9dcd71e';
const f={scenario:'cli',job_id:'12345678-1234-1234-1234-123456789abc',order_id:'87654321-1234-1234-1234-abcdef123456',shop_id:'autoin-test-305',printer_id:'RMP7000',integration_sha:sha};
const s={integrationSha:sha,operationMode:'simulation',httpsUrl:'https://127.0.0.1:3443/',agentToken:'test-local-only-token-32-characters-abc',tlsCertificatePresent:true};
test('HTTPS fixture: 8 scenarios and exact SHA',()=>{assert.equal(HTTPS_AGENT_SCENARIOS.length,8);assert.equal(v(f,s).scenario,'cli');assert.throws(()=>v({...f,integration_sha:'a'.repeat(40)},s));assert.throws(()=>v({...f,scenario:'live_print'},s))});
test('HTTPS fixture: reject HTTP, remote, credentials and bad URL',()=>{for(const httpsUrl of ['http://127.0.0.1:3443/','https://example.com:3443/','https://192.168.1.2:3443/','https://u:p@127.0.0.1:3443/','https://127.0.0.1:3443/foo','https://127.0.0.1/'])assert.throws(()=>v(f,{...s,httpsUrl}),httpsUrl)});
test('HTTPS fixture: reject live mode, short token, missing certificate, wrong shop/printer',()=>{assert.throws(()=>v(f,{...s,operationMode:'production'}));assert.throws(()=>v(f,{...s,agentToken:'short'}));assert.throws(()=>v(f,{...s,tlsCertificatePresent:false}));assert.throws(()=>v({...f,shop_id:'live-shop'},s));assert.throws(()=>v({...f,printer_id:'REAL_RICOH'},s))});
