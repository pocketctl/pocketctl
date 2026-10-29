import {createHash} from 'node:crypto'
import type pg from 'pg'
import {dispatchAuthorizationMatches,type DispatchAuthorization} from './dispatch-repository.js'
import {TeamRepositoryError} from './repository.js'
export interface ExternalStopReport {authorization:DispatchAuthorization;request_id:string;native_session_id:string;state:'cancelled'}
/** Stop-only accounting survives revoked execution authority. It grants no I/O,
 * result access or submission rights and binds the original daemon and Call. */
export class TeamExternalStopService {
 constructor(private pool:pg.Pool){}
 async record(actor:number,daemon:string,call:string,input:ExternalStopReport){
  if(!input||input.state!=='cancelled'||!input.authorization||typeof input.request_id!=='string'||!input.request_id||typeof input.native_session_id!=='string'||!input.native_session_id||Object.keys(input).some(k=>!['authorization','request_id','native_session_id','state'].includes(k)))throw new TeamRepositoryError('invalid_request','Invalid stop-only receipt')
  const db=await this.pool.connect()
  try{
   await db.query('BEGIN')
   const row=(await db.query(`SELECT c.*,o.provider,o.owner_user_id,o.daemon_id,d.user_id daemon_owner FROM collaboration_calls c JOIN team_agent_offers o ON o.offer_id=c.offer_id JOIN daemons d ON d.daemon_id=o.daemon_id WHERE c.call_id=$1 FOR UPDATE OF c`,[call])).rows[0]
   if(!row||row.provider!=='agentteams'||Number(row.daemon_owner)!==actor||!dispatchAuthorizationMatches(row,input.authorization,daemon,actor)||input.authorization.call_id!==call||input.authorization.team_session_id!==row.team_session_id||input.authorization.operation!==row.operation||input.request_id!==row.provider_request_id||input.native_session_id!==row.native_session_id||!row.accepted_at)throw new TeamRepositoryError('team_access_denied','Original stop receipt identity required')
   if(!['accepted','uncertain','completed','failed'].includes(row.state))throw new TeamRepositoryError('invalid_state','Original Call not accepted')
   if(['accepted','uncertain'].includes(row.state)){
    const sequence=(await db.query('UPDATE collaboration_sessions SET latest_event_seq=latest_event_seq+1,updated_at=NOW() WHERE team_session_id=$1 RETURNING latest_event_seq',[row.team_session_id])).rows[0].latest_event_seq
    const key=`external-stop:${call}`,id='cev_'+createHash('sha256').update(key).digest('hex').slice(0,32)
    await db.query(`INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_offer_id,call_id,content,request_id) VALUES($1,$2,$3,'status',$4,$5,'interrupted',$6)`,[id,row.team_session_id,sequence,row.offer_id,call,key])
    await db.query("UPDATE collaboration_calls SET state='failed',outcome='external_stop_confirmed',finished_at=NOW(),updated_at=NOW() WHERE call_id=$1",[call])
   }
   await db.query('COMMIT')
   return {call_id:call,request_id:input.request_id,recorded:true}
  }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
 }
}
