import type pg from 'pg'
import {sourceConnectionKey,sourcePoolContext} from '../sources/pool-context.js'
import {lockCurrentRelayAuthority} from '../sources/current-grant.js'
import {TargetBindingError,type GrantScopeBinding} from './authorization.js'
export interface ReviewMembershipRow {membership_id:string;membership_revision:string;state:string;roles:string[]}
/** Revalidate stored votes, not a caller's grant. Native reviewer rows must
 * remain locked on the publication's physical client until its COMMIT. */
export async function readCurrentReviewMemberships(client:pg.PoolClient,installationId:string,membershipIds:readonly string[],binding:GrantScopeBinding):Promise<ReviewMembershipRow[]>{
 const ids=[...new Set(membershipIds)].sort()
 if(!ids.length)return []
 if(sourcePoolContext(client).namespace!=='memory')return (await client.query<ReviewMembershipRow>(`SELECT membership_id,membership_revision::text,state,roles FROM memory_scope_memberships
  WHERE installation_id=$1 AND membership_id=ANY($2::uuid[]) AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())
  ORDER BY membership_id FOR SHARE`,[installationId,ids])).rows
 if(typeof (sourceConnectionKey(client) as Partial<pg.PoolClient>).release!=='function'||binding.installation_id!==installationId)throw new TargetBindingError('reviewer physical authority required')
 const native:ReviewMembershipRow[]=[]
 for(let start=0;start<ids.length;start+=16){
  const page=ids.slice(start,start+16)
  if(!await lockCurrentRelayAuthority(client,[installationId],page))throw new TargetBindingError('reviewer authority busy')
  const rows=(await client.query<{state:{status:string;provider_enabled:boolean;owner_exists:boolean;owner_scope_kind:string;owner_scope_id:string;scope_state:string;parent_state:string|null;authorization_epoch:string;member_exists:boolean;membership_id:string|null;membership_revision:string|null;membership_state:string|null;roles:string[]|null}}>('SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[installationId],page])).rows
  for(const {state:s} of rows){
   if(!s||s.status!=='active'||!s.provider_enabled||!s.owner_exists||s.owner_scope_kind!==binding.owner_scope_kind||s.owner_scope_id!==binding.owner_scope_id
    ||s.scope_state!=='active'||s.owner_scope_kind==='team'&&s.parent_state!=='active'||s.authorization_epoch!==binding.authorization_epoch
    ||!s.member_exists||!s.membership_id||!s.membership_revision||!Array.isArray(s.roles))continue
   native.push({membership_id:s.membership_id,membership_revision:s.membership_revision,state:s.membership_state??'revoked',roles:s.roles})
  }
 }
 // Local dates are optional restrictions, not native membership authority.
 // Missing mirrors add no restriction; present dates stay locked through COMMIT.
 const local=(await client.query<{membership_id:string;valid:boolean}>(`SELECT membership_id,
  ((valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())) AS valid
  FROM memory_scope_memberships WHERE installation_id=$1 AND membership_id=ANY($2::uuid[]) ORDER BY membership_id FOR SHARE`,[installationId,ids])).rows
 const expired=new Set(local.filter(row=>!row.valid).map(row=>row.membership_id))
 return native.filter(row=>!expired.has(row.membership_id))
}
