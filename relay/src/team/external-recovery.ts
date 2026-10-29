import type pg from 'pg'
import type { TeamErrorCode } from './types.js'
import { TeamRepositoryError } from './repository.js'
import { requireTeamAccess } from './access.js'
import { stableDigest } from './delivery-contract.js'
import { TeamExternalAuthorizationService, type ExternalAuthorizationRequest } from './external-authorization.js'

type DB=Pick<pg.PoolClient,'query'>
export type ExternalRecoveryAction='query'|'retry_original'
export type ExternalRecoveryResult={state:'pending'|'running'|'succeeded'|'failed'|'cancelled'|'absent'|'unknown';remote_task_id:string|null}
export interface ExternalRecoveryInput {request_id:string;action:ExternalRecoveryAction;expected_query_id?:string}
export interface ExternalRecoveryReport extends ExternalAuthorizationRequest {operation_id:string;result:ExternalRecoveryResult}
const fail=(code:TeamErrorCode,message:string):never=>{throw new TeamRepositoryError(code,message)}
const validId=(x:unknown):x is string=>typeof x==='string'&&x.length>0&&x.length<=128&&!/[\x00\r\n]/.test(x)

/** Durable user commands for one original Call. The daemon always rechecks the
 * complete frozen grant and owns the transport journal; Relay never resubmits. */
export class TeamExternalRecoveryService {
 constructor(private pool:pg.Pool,private enabled:(team:string)=>boolean,private steps:(team:string)=>boolean,private terminalProjection?:(daemon:string,actor:number,call:string,remote:string,state:'succeeded'|'failed'|'cancelled')=>Promise<void>){}
 private async call(db:DB,actor:number,session:string,call:string){
  await requireTeamAccess(db,actor)
  const row=(await db.query(`SELECT c.*,s.team_id,o.owner_user_id,o.daemon_id,o.provider,
    o.state offer_state,o.revision current_offer_revision,b.state binding_state,b.revision current_binding_revision,
    d.status daemon_status,m.role,EXISTS(SELECT 1 FROM collaboration_session_participants p WHERE p.team_session_id=s.team_session_id AND p.user_id=$1 AND p.state='active') participant
    FROM collaboration_calls c JOIN collaboration_sessions s ON s.team_session_id=c.team_session_id
    JOIN collaboration_teams t ON t.team_id=s.team_id AND t.state='active'
    JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=$1 AND m.state='active'
    JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.team_id=s.team_id
    JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id
    JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
    WHERE c.call_id=$2 AND c.team_session_id=$3 AND s.state='active' AND o.provider='agentteams'`,[actor,call,session])).rows[0]
  if(!row)fail('team_not_found','Original external Call unavailable')
  return row
 }
 private controls(row:any,actor:number){return this.enabled(row.team_id)&&row.role!=='viewer'&&row.participant&&Number(row.owner_user_id)===actor&&row.daemon_status==='online'&&row.offer_state==='active'&&row.binding_state==='active'&&Number(row.current_offer_revision)===Number(row.offer_revision)&&Number(row.current_binding_revision)===Number(row.binding_revision)&&Boolean(row.native_session_id)&&['accepted','uncertain','completed','failed'].includes(row.state)}
 private async latest(db:DB,call:string){return(await db.query('SELECT * FROM team_external_recovery_operations WHERE call_id=$1 ORDER BY created_at DESC,sequence DESC LIMIT 1',[call])).rows[0]??null}
 private presentation(row:any,op:any,actor:number){
  const state=op?.state==='pending'&&new Date(op.expires_at).getTime()<=Date.now()?'expired':op?.state
  const pending=state==='pending',controls=this.controls(row,actor)
  const retry=controls&&!pending&&state==='done'&&op?.action==='query'&&op?.result?.state==='absent'&&['accepted','uncertain'].includes(row.state)&&Date.now()-new Date(op.updated_at).getTime()<120000
  return {call_id:row.call_id,team_session_id:row.team_session_id,provider:'agentteams',call_state:row.state,can_query:controls&&!pending,can_retry_original:Boolean(retry),operation:op?{request_id:op.request_id,action:op.action,state,result:op.result,updated_at:op.updated_at}:null,capabilities:{automatic_retry:false,hard_cost_limit:false}}
 }
 async get(actor:number,session:string,call:string){const row=await this.call(this.pool,actor,session,call);return this.presentation(row,await this.latest(this.pool,call),actor)}
 async enqueue(actor:number,session:string,call:string,input:ExternalRecoveryInput){
  if(!input||!validId(input.request_id)||!['query','retry_original'].includes(input.action)||Object.keys(input).some(k=>!['request_id','action','expected_query_id'].includes(k))||(input.action==='retry_original'?!validId(input.expected_query_id):input.expected_query_id!==undefined))fail('invalid_request','Invalid original recovery operation')
  const db=await this.pool.connect()
  try{
   await db.query('BEGIN');await db.query('SELECT call_id FROM collaboration_calls WHERE call_id=$1 FOR UPDATE',[call])
   const row=await this.call(db,actor,session,call)
   if(!this.controls(row,actor))fail('team_access_denied','Current owner authorization required')
   const hash=stableDigest(input),prior=(await db.query('SELECT * FROM team_external_recovery_operations WHERE call_id=$1 AND actor_user_id=$2 AND request_id=$3',[call,actor,input.request_id])).rows[0]
   if(prior){if(prior.input_hash!==hash)fail('idempotency_conflict','Original operation changed');const latest=await this.latest(db,call);await db.query('COMMIT');return this.presentation(row,latest,actor)}
   await db.query("UPDATE team_external_recovery_operations SET state='expired',updated_at=NOW() WHERE call_id=$1 AND state='pending' AND expires_at<=NOW()",[call])
   const latest=await this.latest(db,call),view=this.presentation(row,latest,actor)
   if(latest?.state==='pending')fail('source_busy','Original recovery operation pending')
   if(input.action==='retry_original'&&(!view.can_retry_original||input.expected_query_id!==latest?.request_id))fail('invalid_state','Query the exact original request before confirming a retry')
   const inserted=(await db.query(`INSERT INTO team_external_recovery_operations(call_id,actor_user_id,request_id,action,input_hash,expected_query_id,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '2 minutes') RETURNING *`,[call,actor,input.request_id,input.action,hash,input.expected_query_id??null])).rows[0]
   await db.query('COMMIT');return this.presentation(row,inserted,actor)
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
 async pending(actor:number,daemon:string){
  await requireTeamAccess(this.pool,actor,true)
  const owned=(await this.pool.query('SELECT 1 FROM daemons WHERE daemon_id=$1 AND user_id=$2',[daemon,actor])).rows[0]
  if(!owned)fail('team_access_denied','Daemon ownership required')
  const rows=(await this.pool.query(`SELECT op.call_id,op.request_id operation_id,op.action,c.provider_request_id original_request_id,c.native_session_id,c.team_session_id
    FROM team_external_recovery_operations op JOIN collaboration_calls c USING(call_id) JOIN team_agent_offers o ON o.offer_id=c.offer_id
    WHERE op.state='pending' AND op.expires_at>NOW() AND o.daemon_id=$1 AND o.owner_user_id=$2 AND op.actor_user_id=$2 ORDER BY op.sequence LIMIT 16`,[daemon,actor])).rows
  const commands=[]
  for(const r of rows){try{const row=await this.call(this.pool,actor,r.team_session_id,r.call_id);if(this.controls(row,actor))commands.push(r)}catch(error){if(!(error instanceof TeamRepositoryError))throw error}}
  return {commands}
 }
 async report(actor:number,daemon:string,call:string,input:ExternalRecoveryReport){
  const r=input?.result
  if(!input||input.phase!=='account'||!validId(input.operation_id)||!r||Object.keys(r).some(k=>!['state','remote_task_id'].includes(k))||!['pending','running','succeeded','failed','cancelled','absent','unknown'].includes(r.state)||(r.remote_task_id!==null&&(typeof r.remote_task_id!=='string'||r.remote_task_id.length<1||r.remote_task_id.length>1024||/[\x00\r\n]/.test(r.remote_task_id)))||(['absent','unknown'].includes(r.state)&&r.remote_task_id!==null))fail('invalid_request','Invalid external recovery result')
  const db=await this.pool.connect()
  try{
   await db.query('BEGIN')
   const original=(await db.query('SELECT team_session_id FROM collaboration_calls WHERE call_id=$1 FOR UPDATE',[call])).rows[0]
   if(!original)fail('team_not_found','Original Call missing')
   const row=await this.call(db,actor,original.team_session_id,call)
   if(!this.controls(row,actor))fail('team_access_denied','Current owner authorization required')
   const op=(await db.query('SELECT * FROM team_external_recovery_operations WHERE call_id=$1 AND actor_user_id=$2 AND request_id=$3 FOR UPDATE',[call,actor,input.operation_id])).rows[0]
   if(!op)fail('team_not_found','Original recovery operation missing')
   await new TeamExternalAuthorizationService(db,this.enabled,this.steps).authorize(actor,daemon,call,{authorization:input.authorization,request_id:input.request_id,native_session_id:input.native_session_id,phase:'account'})
   if(op.state==='done'){if(stableDigest(op.result)!==stableDigest(r))fail('revision_conflict','Original recovery result changed')}
   else{
    if(op.state!=='pending'||new Date(op.expires_at).getTime()<=Date.now())fail('invalid_state','Original recovery operation expired')
    if(op.action!=='query'&&r.state==='absent')fail('invalid_request','A retry cannot mint absence evidence')
    await db.query("UPDATE team_external_recovery_operations SET state='done',result=$4::jsonb,updated_at=NOW() WHERE call_id=$1 AND actor_user_id=$2 AND request_id=$3",[call,actor,input.operation_id,JSON.stringify(r)])
   }
   await db.query('COMMIT')
   // Report replay retries this projection after a crash between its durable
   // acknowledgement and projection; no new transport request is created.
   if(r.remote_task_id && (r.state==='succeeded'||r.state==='failed'||r.state==='cancelled'))await this.terminalProjection?.(daemon,actor,call,r.remote_task_id,r.state)
   return {call_id:call,operation_id:input.operation_id,recorded:true}
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
}
