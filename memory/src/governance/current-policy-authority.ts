import type pg from 'pg'
import {sourceConnectionKey,sourcePoolContext} from '../sources/pool-context.js'
import {lockCurrentRelayAuthority} from '../sources/current-grant.js'

interface NativeScope {installation_id:string;status:string;owner_scope_kind:string;owner_scope_id:string;authorization_epoch:string;scope_state:string}
interface NativePolicyState extends NativeScope {
 policy_contract_version:number;provider_enabled:boolean;owner_exists:boolean;parent_state:string|null
 parent_organization_id:string|null;parent_authorization_epoch:string|null;parent_installation:NativeScope|null
}
export interface CurrentPolicyAuthority {scopeKind:'team'|'organization';parentOrganizationId:string|null;parentInstallationId:string|null}
export class CurrentPolicyScopeStaleError extends Error {constructor(){super('native_policy_scope_stale')}}

/** Native metadata is authoritative; policy documents, readiness and privacy
 * remain local. Every lock belongs to the caller's physical transaction. */
export async function readCurrentPolicyAuthority(client:Pick<pg.PoolClient,'query'>,installationId:string):Promise<CurrentPolicyAuthority|undefined>{
 if(sourcePoolContext(client).namespace!=='memory')return undefined
 const fail=()=>{throw new CurrentPolicyScopeStaleError()}
 if(typeof (sourceConnectionKey(client) as Partial<pg.PoolClient>).release!=='function')return fail()
 const read=async()=>{
  const rows=(await client.query<{state:NativePolicyState}>('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[installationId],[]])).rows
  if(rows.length!==1||rows[0].state?.policy_contract_version!==1)return fail()
  return rows[0].state
 }
 const observed=await read()
 const parent=observed.parent_installation
 const ids=[...new Set([installationId,...(parent?[parent.installation_id]:[])])].sort()
 if(!await lockCurrentRelayAuthority(client,ids))return fail()
 if(observed.owner_scope_kind==='team'&&!parent){
  // Native row locks cannot protect a missing installation. The existing
  // control fence prevents a phantom installation from committing until us.
  const guarded=(await client.query<{guarded:boolean}>('SELECT shared.guard_memory_control_commit(shared.memory_source_control_snapshot()::bigint) AS guarded')).rows[0]?.guarded
  if(!guarded)return fail()
 }
 for(const id of ids)if(!(await client.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0)) AS locked",[id])).rows[0]?.locked)return fail()
 const current=await read()
 if(JSON.stringify(current)!==JSON.stringify(observed))return fail()
 if(!current.provider_enabled||!current.owner_exists||current.status!=='active'||current.scope_state!=='active'||!['team','organization'].includes(current.owner_scope_kind))return fail()
 const scopes:NativeScope[]=[{...current,installation_id:installationId}]
 if(current.owner_scope_kind==='team'){
  if(!current.parent_organization_id||!current.parent_authorization_epoch||current.parent_state!=='active')return fail()
  if(parent){
   if(parent.status!=='active'||parent.owner_scope_kind!=='organization'||parent.owner_scope_id!==current.parent_organization_id||parent.scope_state!=='active'||parent.authorization_epoch!==current.parent_authorization_epoch)return fail()
   scopes.push(parent)
  }
  if((await client.query(`SELECT 1 FROM memory_scope_tombstones WHERE owner_scope_kind='organization'
    AND owner_scope_id=$1 AND authorization_epoch>=$2::bigint LIMIT 1`,[current.parent_organization_id,current.parent_authorization_epoch])).rowCount)return fail()
 }
 const local=(await client.query<{installation_id:string;local_status:string}>('SELECT installation_id,local_status FROM memory_installations WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE',[ids])).rows
 if(local.length!==ids.length||local.some(row=>['purging','purged','integrity_error'].includes(row.local_status)))return fail()
 for(const scope of scopes)if((await client.query(`SELECT 1 FROM memory_scope_tombstones WHERE owner_scope_kind=$1
   AND owner_scope_id=$2 AND authorization_epoch>=$3::bigint LIMIT 1`,[scope.owner_scope_kind,scope.owner_scope_id,scope.authorization_epoch])).rowCount)return fail()
 return {scopeKind:current.owner_scope_kind as 'team'|'organization',parentOrganizationId:current.owner_scope_kind==='team'?current.parent_organization_id:null,parentInstallationId:parent?.installation_id??null}
}
