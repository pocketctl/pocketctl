import type pg from 'pg'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {canonicalPayloadHash} from '@pocketctl/session-source'
import {assertDaemonSessionAccess,lockSessionMaterializationFence,nativeSessionFenceSet} from '../db.js'
export const USAGE_RECOVERY_AUDIT_SQL=`CREATE TABLE IF NOT EXISTS public.relay_usage_write_recovery_audit(manifest_digest TEXT NOT NULL,inbox_id BIGINT NOT NULL,fingerprint TEXT NOT NULL,original JSONB NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),applied_by TEXT NOT NULL DEFAULT current_user,PRIMARY KEY(manifest_digest,inbox_id))`
type Scope={daemonId:string;ownerId:number;generation:string}
type Entry={inboxId:string;fingerprint:string;original:Record<string,unknown>}
type Target={database:string;address:string;port:number}
export type UsageRecoveryManifest={version:1;policy:'usage-first-write-v1';createdAt:string;target:Target;scope:Scope;entries:Entry[];digest:string}
type DB=Pick<pg.PoolClient,'query'>
const hash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const id=(v:unknown)=>typeof v==='string'&&/^[1-9][0-9]{0,15}$/.test(v)&&Number.isSafeInteger(Number(v))
function validate(scope:Scope,ids:string[]){
 if(!scope||!scope.daemonId||scope.daemonId.length>64||!Number.isSafeInteger(scope.ownerId)||scope.ownerId<1||!id(scope.generation)
  ||!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(v=>!id(v)))throw Error('invalid_recovery_scope')
}
async function target(db:DB):Promise<Target>{return(await db.query('SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port')).rows[0]}
async function candidate(db:DB,scope:Scope,inboxId:string):Promise<Entry>{
 const row=(await db.query('SELECT to_jsonb(i) AS row FROM event_inbox i WHERE inbox_id=$1',[inboxId])).rows[0]?.row
 if(!row||row.user_id!==scope.ownerId||row.daemon_id!==scope.daemonId||String(row.daemon_generation)!==scope.generation
  ||row.status!==3||row.last_error!=='materialization_failed'||row.attempts!==12||row.claimed_by!==null||row.claimed_at!==null
  ||!Number.isFinite(Date.parse(row.completed_at))||row.materialized_event_id!==null||!Number.isSafeInteger(row.seq))throw Error('ineligible_usage_failure')
 const p=row.payload,u=p?.usage
 const usageFields=new Set(['input_tokens','output_tokens','cache_read_tokens','cache_create_tokens','reasoning_tokens','total_tokens'])
 if(row.event_type!=='agent_text'||p?.type!=='agent_text'||p.session_id!==row.session_id||p.resync===true||p.is_subagent===true
  ||typeof p.event_id!=='string'||!p.event_id||p.event_id.length>500||p.request_id!==undefined
  ||!u||typeof u!=='object'||Array.isArray(u)||!Object.keys(u).length
  ||Object.entries(u).some(([k,v])=>!usageFields.has(k)||!Number.isSafeInteger(v)||Number(v)<0)
  ||!Object.entries(row.materialization_context??{}).every(([k,v])=>['agentType','cwd','hostname'].includes(k)||(k==='reservationId'&&v==null)))throw Error('unsupported_usage_payload')
 if((await db.query('SELECT 1 FROM session_aliases WHERE old_session_id=$1',[row.session_id])).rowCount)throw Error('alias_requires_review')
 await assertDaemonSessionAccess(db as pg.Pool,{sessionId:row.session_id,daemonId:scope.daemonId,userId:scope.ownerId,policy:'must_exist'})
 const eventHash=createHash('md5').update(`${row.session_id}:agent_text:event:${p.event_id}`).digest('hex').slice(0,16)
 if((await db.query('SELECT 1 FROM events WHERE session_id=$1 AND event_hash=$2',[row.session_id,eventHash])).rowCount)throw Error('canonical_already_exists')
 if((await db.query('SELECT 1 FROM token_usage_facts WHERE fact_key=$1',['inbox:'+inboxId])).rowCount)throw Error('usage_fact_already_exists')
 if((await db.query('SELECT 1 FROM realtime_outbox WHERE inbox_id=$1',[inboxId])).rowCount)throw Error('delivery_already_exists')
 const{payload:_p,materialization_context:_c,...original}=row
 return{inboxId,fingerprint:hash(row),original}
}
function digest(m:UsageRecoveryManifest){const{digest:_d,...body}=m;return hash(body)}
/** Planning is all-or-nothing for an explicit reviewed <=100 ID set. */
export async function planUsageWriteRecovery(pool:pg.Pool,scope:Scope,ids:string[]):Promise<UsageRecoveryManifest>{
 validate(scope,ids);const c=await pool.connect()
 try{
  await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='5s'")
  const m:UsageRecoveryManifest={version:1,policy:'usage-first-write-v1',createdAt:new Date().toISOString(),target:await target(c),scope,entries:[],digest:''}
  for(const id of ids)m.entries.push(await candidate(c,scope,id))
  m.entries.sort((a,b)=>Number(a.original.seq)-Number(b.original.seq));m.digest=digest(m)
  await c.query('COMMIT');return m
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
/** Session fences plus the inbox table lock exclude concurrent claim/write
 * races. Refuse any already leased work in the daemon, even another session.
 * No service-pause assertion is trusted in place of these database checks. */
export async function applyUsageWriteRecovery(pool:pg.Pool,m:UsageRecoveryManifest,expected:string){
 if(!m||m.version!==1||m.policy!=='usage-first-write-v1'||m.digest!==expected||digest(m)!==expected)throw Error('manifest_digest_mismatch')
 validate(m.scope,m.entries.map(e=>e.inboxId));const c=await pool.connect()
 try{
  await c.query("BEGIN; SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='1s'")
  if(!isDeepStrictEqual(await target(c),m.target))throw Error('recovery_target_mismatch')
  const sessions=m.entries.map(e=>String(e.original.session_id)),fences=await nativeSessionFenceSet(c,sessions)
  for(const session of fences)await lockSessionMaterializationFence(c,session)
  if(!isDeepStrictEqual(fences,await nativeSessionFenceSet(c,sessions)))throw Error('alias_set_changed')
  await c.query('LOCK TABLE event_inbox IN SHARE ROW EXCLUSIVE MODE NOWAIT')
  if((await c.query('SELECT 1 FROM event_inbox WHERE daemon_id=$1 AND status=1 LIMIT 1',[m.scope.daemonId])).rowCount)throw Error('active_claims_present')
  const deadline=Date.now()+10000;let applied=0,alreadyApplied=0
  for(const entry of m.entries){
   if(Date.now()>deadline)throw Error('recovery_time_budget_exceeded')
   const receipt=(await c.query('SELECT fingerprint FROM relay_usage_write_recovery_audit WHERE manifest_digest=$1 AND inbox_id=$2',[expected,entry.inboxId])).rows[0]
   if(receipt){if(receipt.fingerprint!==entry.fingerprint)throw Error('audit_mismatch');alreadyApplied++;continue}
   // The fingerprint check precedes eligibility to distinguish drift from a
   // reviewed candidate's original rejection. Neither check writes data.
   const snapshot=(await c.query('SELECT to_jsonb(i) AS row FROM event_inbox i WHERE inbox_id=$1',[entry.inboxId])).rows[0]?.row
   if(!snapshot||hash(snapshot)!==entry.fingerprint)throw Error('candidate_changed')
   if(!isDeepStrictEqual(await candidate(c,m.scope,entry.inboxId),entry))throw Error('candidate_changed')
   const changed=await c.query("UPDATE event_inbox SET status=0,attempts=0,available_at=NOW(),last_error=NULL,completed_at=NULL WHERE inbox_id=$1 AND status=3 AND attempts=12 AND last_error='materialization_failed' AND claimed_by IS NULL AND claimed_at IS NULL",[entry.inboxId])
   if(changed.rowCount!==1)throw Error('candidate_changed')
   await c.query('INSERT INTO relay_usage_write_recovery_audit(manifest_digest,inbox_id,fingerprint,original) VALUES($1,$2,$3,$4)',[expected,entry.inboxId,entry.fingerprint,entry.original]);applied++
  }
  if(Date.now()>deadline)throw Error('recovery_time_budget_exceeded')
  await c.query('COMMIT');return{digest:expected,applied,alreadyApplied}
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}
