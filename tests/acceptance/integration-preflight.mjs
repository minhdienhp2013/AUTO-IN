// CODE-305 provenance and fail-closed integration gating. No network or DB access here.
const sha40=/^[a-f0-9]{40}$/;
const preIntegration=new Set([
 '5707b81128e7e84180db57865896d52d256dac33',
 '7066849be67dabd992cda08209584e7c861b47ca',
 '2038863949e8366e9e6742472d4992f2cf224601'
]);
export function requireIntegratedSha(env=process.env){
 const sha=env.AUTOIN_INTEGRATION_SHA;
 if(!sha40.test(sha??''))throw Error('AUTOIN_INTEGRATION_SHA must be exact 40-character integration commit SHA from AI0');
 if(preIntegration.has(sha))throw Error('Module/document/scaffold SHA is NOT an AI0 CODE-006 integrated build');
 if(env.AUTOIN_OPERATION_MODE!=='simulation')throw Error('AUTOIN_OPERATION_MODE=simulation is required');
 return sha;
}
export function requireIsolatedPgEnv(env=process.env){
 requireIntegratedSha(env);
 if(!env.AUTOIN_TEST_DATABASE_URL || env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
  throw Error('Require explicit local PostgreSQL test DB URL and acknowledgement');
}
