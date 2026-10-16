/** Read-only counters for the disposable LOAD100 database, no customer bodies. */
import pg from 'pg';
import {assertIsolatedSimulationDatabase} from '../backend/composition/postgres.ts';
const url=process.env.TEST_DATABASE_URL;
assertIsolatedSimulationDatabase(url);
if(process.env.AUTOIN_OPERATION_MODE!=='simulation')throw Error('SIMULATION_REQUIRED');
const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,
  options:'-c statement_timeout=10000'});
try{
  const shops=(await pool.query("SELECT shop_id,oa_id FROM core_shop_zalo_oa_registry "+
    "WHERE shop_id LIKE 'autoin-test-load100-%'")).rows;
  for(const {shop_id,oa_id} of shops){
    const batches=(await pool.query('SELECT status,last_error_code,count(*)::int n,max(attempts) attempts '+
      'FROM zalo_batches WHERE oa_id=$1 GROUP BY status,last_error_code',[oa_id])).rows;
    const queue=(await pool.query('SELECT status,count(*)::int n FROM zalo_process_queue '+
      'WHERE oa_id=$1 GROUP BY status',[oa_id])).rows;
    const proposals=(await pool.query('SELECT count(*)::int n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop_id])).rows[0].n;
    console.log('LOAD100_DIAGNOSTIC '+JSON.stringify({batches,queue,proposals}));
  }
}finally{await pool.end()}
