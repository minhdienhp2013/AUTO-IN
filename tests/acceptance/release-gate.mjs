import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
// A fixture PASS never enables real printing or production.
export function releaseGate(r){
 const blockers=[];
 if(r?.mode!=='controlled_test')blockers.push('Not a controlled real test');
 if(r?.critical_failures!==0)blockers.push('Nonzero/unknown critical failures');
 if(!Number.isInteger(r?.passing_orders)||r.passing_orders<210)blockers.push('Missing 210 passing orders');
 if(!Number.isInteger(r?.clean_test_days)||r.clean_test_days<7)blockers.push('Missing 7 clean days');
 if(!Number.isInteger(r?.load_orders_per_day)||r.load_orders_per_day<100)blockers.push('Missing simulation at 100 orders/day');
 if(typeof r?.recognition_rate!=='number'||r.recognition_rate<.90)blockers.push('Recognition <90%');
 if(typeof r?.conversation_rate!=='number'||r.conversation_rate<.80)blockers.push('Conversation success <80%');
 for(const name of ['postgres_concurrency','oa_verified','ricoh_verified','iphone_verified','all_p0_rechecked','reviewed_by_owner']){
  if(r?.evidence?.[name]!==true)blockers.push('Missing evidence: '+name);
 }
 if(r?.synthetic_dataset!==false)blockers.push('Synthetic or unidentified test dataset');
 return {allowed:blockers.length===0,blockers};
}
if(process.argv[1]&&resolve(process.argv[1])===new URL(import.meta.url).pathname){
 if(!process.argv[2])throw Error('Pass full evidence report JSON path');
 const result=releaseGate(JSON.parse(await readFile(resolve(process.argv[2]),'utf8')));
 console.log(JSON.stringify(result,null,2));process.exitCode=result.allowed?0:1;
}
