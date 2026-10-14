import test from 'node:test';import assert from 'node:assert/strict';
import {requireExactCode405Checkout as verify} from './code405-exact-sha.mjs';
const a='a'.repeat(40),b='b'.repeat(40);
test('CODE405 provenance accepts exact SHA',()=>assert.equal(verify(a,()=>a),a));
test('CODE405 provenance rejects prior passing SHA',()=>assert.throws(()=>verify(a,()=>b),/differs/));
test('CODE405 provenance rejects malformed/unavailable git HEAD',()=>{
 assert.throws(()=>verify('short',()=>a),/40-character/);
 assert.throws(()=>verify(a,()=>{throw Error('not a checkout')}),/cannot prove/);
});
