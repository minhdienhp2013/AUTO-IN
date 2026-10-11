import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export function score(d,p){
 if(p.dataset_id!==d.dataset_id)throw Error('Dataset mismatch');
 const expected=new Map(d.samples.map(x=>[x.id,x]));
 const results=new Map();
 for(const x of p.samples??[]){
  if(results.has(x.id)||!expected.has(x.id))throw Error('Duplicate/unknown prediction: '+x.id);
  results.set(x.id,x);
 }
 let correct=0,automated=0,missing=0;
 const common=d.samples.filter(x=>x.common).length;
 for(const s of d.samples){
  const p=results.get(s.id);
  if(!p){missing++;continue;}
  if(p.predicted_intent===s.intent)correct++;
  if(s.common&&p.predicted_intent===s.intent&&p.handled_without_human===true)automated++;
 }
 const recognized=correct/d.samples.length,conversation=automated/common;
 return {dataset_id:d.dataset_id,sample_count:d.samples.length,common_count:common,
  missing,recognized,conversation,recognition_target_met:missing===0&&recognized>=.9,
  conversation_target_met:missing===0&&conversation>=.8,admissible_as_TN037_evidence:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Pass predictions JSON (no fabricated predictions)');
 const d=JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)),'../fixtures/public/recognition_samples.json'),'utf8'));
 const p=JSON.parse(await readFile(resolve(process.argv[2]),'utf8'));const r=score(d,p);
 console.log(JSON.stringify(r,null,2));
 if(r.missing||!r.recognition_target_met||!r.conversation_target_met)process.exitCode=1;
}
