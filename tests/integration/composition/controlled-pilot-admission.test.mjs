import test from 'node:test';
import assert from 'node:assert/strict';
import {admitAgentRoute} from '../../../dist/backend/composition/controlled-pilot-admission.js';

const scope={shop_id:'shop-public',order_id:'order-public',printer_id:'RMP7000'};
const agent={id:'agent-public',role:'print_agent',verified:true,shop_id:scope.shop_id,
  printer_ids:[scope.printer_id]};
function pool(mode='controlled_test',jobs=[{order_id:scope.order_id,printer_id:scope.printer_id}]) {
  const calls=[];
  return {calls,async query(sql,args){
    calls.push({sql,args});
    return {rows:sql.includes('core_shop_settings')?[{mode}]:jobs,rowCount:1};
  }};
}
const blocked=async(input,code)=>assert.rejects(admitAgentRoute(input),error=>error.code===code);

test('controlled pilot admits only server scope while Core owns the grant',async()=>{
  const db=pool();
  await admitAgentRoute({pool:db,agent,pilotRoute:true,scope,
    requestedPrinterId:'RMP7000'});
  await admitAgentRoute({pool:db,agent,pilotRoute:true,scope,jobId:'job-public'});
  assert.deepEqual(db.calls.at(-1).args,['job-public','shop-public']);
  assert.match(db.calls.at(-1).sql,/pilot_authorization_id IS NOT NULL/);
  // Reports remain possible after grant expiry; no re-send is implied.
  assert.equal(db.calls.length,3);
});

test('wrong shop, order, printer, job kind and missing opt-in fail closed',async()=>{
  await blocked({pool:pool(),agent:{...agent,shop_id:'other'},pilotRoute:true,scope,
    requestedPrinterId:'RMP7000'},'CONTROLLED_PILOT_SCOPE');
  await blocked({pool:pool(),agent,pilotRoute:true,scope,
    requestedPrinterId:'OTHER'},'CONTROLLED_PILOT_SCOPE');
  for(const jobs of [[{order_id:'other',printer_id:'RMP7000'}],
    [{order_id:scope.order_id,printer_id:'OTHER'}],[]])
    await blocked({pool:pool('controlled_test',jobs),agent,pilotRoute:true,scope,
      jobId:'job-public'},'CONTROLLED_PILOT_SCOPE');
  await blocked({pool:pool(),agent,pilotRoute:true,
    requestedPrinterId:'RMP7000'},'SIMULATION_REQUIRED');
});

test('legacy Agent routes stay closed and simulation remains separate',async()=>{
  await blocked({pool:pool(),agent,pilotRoute:false,scope,jobId:'job-public'},
    'SIMULATION_REQUIRED');
  await blocked({pool:pool('simulation'),agent,pilotRoute:true,scope,
    requestedPrinterId:'RMP7000'},'SIMULATION_REQUIRED');
  await admitAgentRoute({pool:pool('simulation'),agent,pilotRoute:false});
  await blocked({pool:pool('production'),agent,pilotRoute:true,scope,
    requestedPrinterId:'RMP7000'},'SIMULATION_REQUIRED');
  await blocked({pool:pool('safe'),agent,pilotRoute:true,scope,
    requestedPrinterId:'RMP7000'},'SIMULATION_REQUIRED');
});
