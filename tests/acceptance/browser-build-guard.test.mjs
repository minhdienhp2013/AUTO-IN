import test from 'node:test';
import assert from 'node:assert/strict';
import {requireAi4Build} from './browser-build-guard.mjs';
test('browser gate rejects missing lockfile',()=>assert.throws(()=>requireAi4Build('/tmp/synthetic',()=>false),/package-lock/));
test('browser gate rejects missing compiled web',()=>assert.throws(()=>requireAi4Build('/tmp/synthetic',p=>p.endsWith('package-lock.json')),/dist\\/index.html/));
test('browser gate accepts both declared build prerequisites',()=>{
 const r=requireAi4Build('/tmp/synthetic',()=>true);
 assert.ok(r.lock.endsWith('web/package-lock.json'));
 assert.ok(r.html.endsWith('web/dist/index.html'));
});
