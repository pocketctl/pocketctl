import type pg from 'pg'
import type {CurationMode} from './contracts.js'
import {JobDeferredError} from '../jobs/types.js'
import {lockCurrentRelayAuthority} from '../sources/current-grant.js'
import {sourcePoolContext} from '../sources/pool-context.js'
export interface CurationPolicy {mode:CurationMode;revision:number;authorizationEpoch:string;version:string}
/** Acquire current Relay authority before taking local curation locks. */
export async function lockCurationAuthority(client:Pick<pg.PoolClient,'query'>,installationId:string):Promise<void>{
 if(!await lockCurrentRelayAuthority(client,[installationId]))throw new JobDeferredError('source_not_ready',new Date(Date.now()+1000))
}
/** The installation is the owner boundary. Personal automation never inherits
 * a team publication capability, even when the same user owns both scopes.
 * Shared-mode writers acquire the current Relay authority before local locks. */
export async function readCurationPolicy(client:Pick<pg.PoolClient,'query'>,installationId:string,globalMode:CurationMode):Promise<CurationPolicy|'source_denied'|null>{
 if(globalMode==='off')return null
 const shared=sourcePoolContext(client).namespace==='memory'
 const row=(await client.query(shared?`SELECT policy.*,current.state->>'authorization_epoch' AS authorization_epoch,
  current.state->>'owner_scope_kind' AS owner_scope_kind,
  current.state @> '{"status":"active","owner_exists":true,"provider_enabled":true,"curation_input_allowed":true}'::jsonb AS source_allowed
 FROM shared.memory_current_grant_states(ARRAY[$1::uuid],ARRAY[]::uuid[]) current
 LEFT JOIN LATERAL (
  SELECT p.mode,p.revision,p.policy_version FROM memory_curation_policies p JOIN memory_installations i USING(installation_id)
  WHERE p.installation_id=current.installation_id AND i.local_status NOT IN('purging','purged','integrity_error')
  FOR SHARE OF p,i
 ) policy ON TRUE`:`SELECT p.mode,p.revision,p.policy_version,s.authorization_epoch::text
 FROM memory_curation_policies p JOIN memory_owner_scopes s USING(installation_id)
 WHERE p.installation_id=$1 AND s.owner_scope_kind='personal' AND s.state='active' FOR SHARE OF p,s`,[installationId])).rows[0]
 if(shared){
  if(!row||row.owner_scope_kind==='personal'&&row.source_allowed!==true)return 'source_denied'
  if(row.owner_scope_kind!=='personal')return null
 }
 if(!row?.mode||row.mode==='off')return null
 return {mode:globalMode==='shadow'?'shadow':row.mode,revision:Number(row.revision),authorizationEpoch:row.authorization_epoch,version:row.policy_version}
}
/** Used inside both legacy reservation/commit transactions. The policy row is
 * locked so migration cannot transfer processing ownership midway through a write. */
export async function assertLegacySourceOwner(client:Pick<pg.PoolClient,'query'>,installationId:string,globalMode:CurationMode='off'):Promise<void>{
 if(globalMode!=='enabled')return
 const row=(await client.query('SELECT mode FROM memory_curation_policies WHERE installation_id=$1 FOR SHARE',[installationId])).rows[0]
 if(row?.mode==='enabled')throw new Error('source_owned_by_lifecycle')
}
