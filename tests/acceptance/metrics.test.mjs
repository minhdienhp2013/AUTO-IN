import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {score} from './metrics.mjs';
const d=JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)),'../fixtures/public/recognition_samples.json'),'utf8'));
const all=fn=>({dataset_id:d.dataset_id,samples:d.samples.map(fn)});
test('METRICS SELFTEST: no prediction = 0%, not dropped from denominator',()=>{
 const r=score(d,{dataset_id:d.dataset_id,samples:[]});
 assert.equal(r.missing,20);assert.equal(r.recognized,0);
 assert.equal(r.conversation,0);assert.equal(r.admissible_as_TN037_evidence,false);
});
test('METRICS SELFTEST: wrong dataset/duplicate/unknown predictions rejected',()=>{
 assert.throws(()=>score(d,{dataset_id:'wrong',samples:[]}));
 assert.throws(()=>score(d,{dataset_id:d.dataset_id,samples:[{id:'R001'},{id:'R001'}]}));
 assert.throws(()=>score(d,{dataset_id:d.dataset_id,samples:[{id:'R999'}]}));
});
test('METRICS SELFTEST: required staff approval is separate from automation numerator',()=>{
 const r=score(d,all(s=>({id:s.id,predicted_intent:s.intent,handled_without_human:false})));
 assert.equal(r.recognized,1);assert.equal(r.conversation,0);
});
test('METRICS SELFTEST: synthetic perfect score is not admissible for TN-037',()=>{
 const r=score(d,all(s=>({id:s.id,predicted_intent:s.intent,handled_without_human:true})));
 assert.equal(r.recognized,1);assert.equal(r.conversation,1);
 assert.equal(r.admissible_as_TN037_evidence,false);
});
