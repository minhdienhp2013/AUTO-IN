import {DomainError} from '../core/model.js';
import {createTn005SealedOutbox,
  type SealedSourceBinding} from '../core/tn005-sealed-outbox.js';
import type {PgStore,SqlPool} from '../storage/database.js';
import {verifiedSyntheticSource} from './inbound-draft.js';
import type {SyntheticArtifactScope} from './synthetic-ingest.js';

/** AI0 binds AI1's CAS outbox to the server-owned synthetic sealed-source
 * index and re-hashes the manifest plus source bytes at every AI1 check. This
 * is a simulation/test Port only: it does not create a sender or a route.
 */
export function createVerifiedSyntheticTn005Outbox(options:{
  readonly pool:SqlPool;
  readonly store:PgStore;
  readonly artifactRoot:string;
  readonly scope:SyntheticArtifactScope;
}) {
  if(!options?.pool?.query||!options?.store?.tx||
     typeof options.artifactRoot!=='string'||options.artifactRoot.length===0||
     !options.scope||typeof options.scope.shop_id!=='string'||
     !options.scope.shop_id||typeof options.scope.oa_id!=='string'||!options.scope.oa_id)
    throw new DomainError('TN005_PORT_UNCONFIGURED','Trusted sealed-source scope required',503);

  const scope=Object.freeze({shop_id:options.scope.shop_id,oa_id:options.scope.oa_id});
  return createTn005SealedOutbox({
    store:options.store,
    trusted:scope,
    verify_sealed_source:async(binding:Readonly<SealedSourceBinding>):Promise<boolean>=>{
      if(binding.shop_id!==scope.shop_id||binding.oa_id!==scope.oa_id)return false;
      try{
        const verified=await verifiedSyntheticSource(
          options.pool,options.artifactRoot,scope,binding.event_id);
        return verified.artifact_ref===binding.artifact_ref&&
          verified.sha256===binding.source_sha256;
      }catch(error){
        if(error instanceof DomainError)throw error;
        // Do not let filesystem paths or source-specific errors escape the Port.
        throw new DomainError('TN005_SOURCE_UNVERIFIED','Sealed source verification failed',409);
      }
    }
  });
}
