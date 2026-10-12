import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {z} from 'zod'
import {requireCurrentScopePermission,assertCurrentGrantClock,type ValidatedV2Grant} from './authorization.js'
export const executorPermissions=z.array(z.enum(['auto_accept_personal','publish_delegated'])).max(2)
export function createExecutorPrincipals(pool:pg.Pool){return {async authorize(input:{grant:ValidatedV2Grant&{callerType?:string};installationId:string;providerClientId:string;permissions:unknown;expiresAt:string;maxAcceptsPerDay?:number}){
 if(!['web','ios'].includes(input.grant.callerType??''))throw new Error('human_executor_admin_required')
 const permissions=executorPermissions.parse(input.permissions)
 if(!input.providerClientId||input.providerClientId.length>200)throw new Error('invalid_executor_identity')
 const c=await pool.connect()
 try{await c.query('BEGIN');const binding=await requireCurrentScopePermission({client:c,grant:input.grant,targetInstallationId:input.installationId,permission:'policy_admin'})
  if(permissions.includes('auto_accept_personal')&&binding.owner_scope_kind!=='personal')throw new Error('personal_permission_scope_required')
  if(permissions.includes('publish_delegated')&&binding.owner_scope_kind==='personal')throw new Error('shared_permission_scope_required')
  if(!(await c.query("SELECT $1::timestamptz>clock_timestamp() AND $1::timestamptz<=clock_timestamp()+interval '1 day' AS valid",[input.expiresAt])).rows[0].valid)throw new Error('executor_expiry_invalid')
  const quota=input.maxAcceptsPerDay??0;if(!Number.isInteger(quota)||quota<0||quota>1000)throw new Error('invalid_acceptance_quota')
  const principalId=randomUUID();await c.query(`INSERT INTO memory_governance_executor_principals(principal_id,installation_id,provider_client_id,state,permissions,authorization_epoch,valid_until,max_accepts_per_day,authorized_by_owner_id,authorized_by_membership_id) VALUES($1,$2,$3,'active',$4,$5,$6,$7,$8,$9)`,[principalId,input.installationId,input.providerClientId,[...new Set(permissions)],binding.authorization_epoch,input.expiresAt,quota,binding.owner_scope_id,binding.membership_id]);await assertCurrentGrantClock(c,input.grant,[input.installationId]);await c.query('COMMIT');return {principalId}
 }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
},async disable(input:{grant:ValidatedV2Grant&{callerType?:string};installationId:string;principalId:string;expectedRevision:string}){
 if(!['web','ios'].includes(input.grant.callerType??''))throw new Error('human_executor_admin_required')
 const c=await pool.connect();try{await c.query('BEGIN');await requireCurrentScopePermission({client:c,grant:input.grant,targetInstallationId:input.installationId,permission:'policy_admin'});const row=await c.query(`UPDATE memory_governance_executor_principals SET state='disabled',permission_revision=permission_revision+1 WHERE installation_id=$1 AND principal_id=$2 AND permission_revision=$3::bigint RETURNING principal_id`,[input.installationId,input.principalId,input.expectedRevision]);if(!row.rowCount)throw new Error('executor_revision_conflict');await assertCurrentGrantClock(c,input.grant,[input.installationId]);await c.query('COMMIT');return {disabled:true}}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}}}
