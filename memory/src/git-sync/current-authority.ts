import type pg from 'pg'
import {sourcePoolContext} from '../sources/pool-context.js'
import {readCurrentReviewMemberships} from '../governance/current-review-memberships.js'
import {requireCurrentGitAuthorization,type GitAuthorizationStamp} from './authorization.js'

/** Stored actors and consenting administrators are locators, never grants. */
export async function readGitActorMemberships(client:pg.PoolClient,stamp:GitAuthorizationStamp,ids:readonly string[]){
 return readCurrentReviewMemberships(client,stamp.installationId,ids,{installation_id:stamp.installationId,
  owner_scope_kind:stamp.ownerScopeKind,owner_scope_id:stamp.ownerScopeId,authorization_epoch:stamp.authorizationEpoch,
  membership_id:stamp.membershipId,membership_revision:stamp.membershipRevision,permissions:[]})
}

/** The consent's exact revision/epoch must still authorize its original admin.
 * Caller uses a short physical transaction and releases it before provider I/O. */
export async function managedGitConsentCurrent(client:pg.PoolClient,installationId:string,membershipId:string,target:Record<string,unknown>):Promise<boolean>{
 if(typeof target.membershipRevision!=='string'||typeof target.authorizationEpoch!=='string')return false
 let scope:{owner_scope_kind:string;owner_scope_id:string;config_version:string}|undefined
 if(sourcePoolContext(client).namespace==='memory'){
  const states=(await client.query('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[installationId],[membershipId]])).rows
  const s=states.length===1?states[0].state:undefined
  if(s)scope={owner_scope_kind:s.owner_scope_kind,owner_scope_id:s.owner_scope_id,config_version:s.config_version}
 }else scope=(await client.query(`SELECT s.owner_scope_kind,s.owner_scope_id::text,i.config_version::text
  FROM memory_owner_scopes s JOIN memory_installations i USING(installation_id) WHERE s.installation_id=$1`,[installationId])).rows[0]
 if(!scope||!['team','organization'].includes(scope.owner_scope_kind))return false
 try{
  await requireCurrentGitAuthorization(client,{installationId,ownerScopeKind:scope.owner_scope_kind as 'team'|'organization',ownerScopeId:scope.owner_scope_id,
   membershipId,membershipRevision:target.membershipRevision,authorizationEpoch:target.authorizationEpoch,configVersion:scope.config_version},'scope_admin')
  return true
 }catch(error){if(error instanceof Error&&error.message==='git_authorization_stale')return false;throw error}
}

export interface ManagedGitConsentLocator {
 installation_id:string;project_id:string;authorized_membership_id:string;target:Record<string,unknown>
}
export const managedGitConsentKey=(row:Pick<ManagedGitConsentLocator,'installation_id'|'project_id'>)=>`${row.installation_id}:${row.project_id}`

/** Authority rows are already validated and held by this physical transaction.
 * After the last blocking lock, sweep all accepted locators with one fresh clock.
 * This MVCC-only query takes no further row locks that could stale earlier dates. */
export async function currentManagedGitConsentClocks(client:pg.PoolClient,locators:readonly ManagedGitConsentLocator[]):Promise<Set<string>>{
 if(!locators.length)return new Set()
 const native=sourcePoolContext(client).namespace==='memory'
 const rows=(await client.query<{installation_id:string;project_id:string}>(`WITH moment AS MATERIALIZED(SELECT clock_timestamp() AS checked_at)
  SELECT p.installation_id,p.project_id FROM jsonb_to_recordset($1::jsonb)
   AS wanted(installation_id UUID,project_id UUID,authorized_membership_id UUID,target JSONB)
  JOIN memory_git_project_targets p ON p.installation_id=wanted.installation_id AND p.project_id=wanted.project_id
  JOIN memory_git_connections c ON c.installation_id=p.installation_id AND c.connection_id=p.connection_id
  LEFT JOIN memory_scope_memberships m ON m.installation_id=p.installation_id AND m.membership_id=wanted.authorized_membership_id
  CROSS JOIN moment
  WHERE p.target=wanted.target AND p.authorized_membership_id=wanted.authorized_membership_id
   AND p.token_cipher IS NOT NULL AND c.state='active' AND p.consent_until>moment.checked_at
   ${native?'':"AND m.membership_id IS NOT NULL AND m.state='active'"}
   AND (m.valid_from IS NULL OR m.valid_from<=moment.checked_at) AND (m.valid_until IS NULL OR m.valid_until>moment.checked_at)`,[JSON.stringify(locators)])).rows
 return new Set(rows.map(managedGitConsentKey))
}
