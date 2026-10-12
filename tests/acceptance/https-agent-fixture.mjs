export const HTTPS_AGENT_SCENARIOS=Object.freeze(['normal','cli','lost_mark_ack','lost_report_ack','before_mark_sending','after_mark_sending','after_journal_before_driver','after_driver']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,sha40=/^[0-9a-f]{40}$/;
export function validateHttpsAgentFixture(f,s){
 if(!f||typeof f!=='object'||Array.isArray(f))throw Error('Fixture must be JSON object');
 if(!HTTPS_AGENT_SCENARIOS.includes(f.scenario))throw Error('Unknown HTTPS agent scenario');
 if(!uuid.test(f.job_id??'')||!uuid.test(f.order_id??''))throw Error('Fresh PostgreSQL job/order UUID required');
 if(typeof f.shop_id!=='string'||!/^autoin[-_]test[-_]/i.test(f.shop_id))throw Error('Synthetic shop required');
 if(f.printer_id!=='RMP7000')throw Error('Only synthetic RMP7000 printer identity allowed');
 if(!sha40.test(f.integration_sha??'')||f.integration_sha!==s.integrationSha)throw Error('Fixture exact integrated SHA required');
 if(s.operationMode!=='simulation')throw Error('Non-simulation mode forbidden');
 let u;try{u=new URL(s.httpsUrl)}catch{throw Error('Valid localhost HTTPS URL required')}
 if(u.protocol!=='https:'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||!u.port||u.username||u.password||u.pathname!=='/'||u.search||u.hash)
  throw Error('Only HTTPS localhost with explicit port; no credentials/path/query');
 if(typeof s.agentToken!=='string'||s.agentToken.length<32||/[\r\n]/.test(s.agentToken))throw Error('Scoped agent token >=32 required');
 if(s.tlsCertificatePresent!==true)throw Error('Trusted TLS certificate required');
 return {scenario:f.scenario,job_id:f.job_id,order_id:f.order_id,shop_id:f.shop_id,printer_id:f.printer_id,integration_sha:f.integration_sha};
}
