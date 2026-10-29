import type pg from 'pg'
import { createHash } from 'node:crypto'
import { TeamExternalAuthorizationService, type ExternalAuthorizationRequest } from './external-authorization.js'
import { TeamRepositoryError } from './repository.js'

type Turn = {original_id:string;model:string;finished_at:string;input_tokens:number;output_tokens:number;cache_read_tokens:number;cache_create_tokens:number;total_tokens:number}
export interface ExternalUsageRequest extends ExternalAuthorizationRequest {
  remote_task_id:string
  usage:{chat_id:string;session_id:string;turns:Turn[]}
}
const text=(v:unknown,max=256):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00\r\n]/.test(v)
const fail=():never=>{throw new TeamRepositoryError('invalid_request','Invalid external usage facts')}
export class TeamExternalUsageService {
 constructor(private pool:pg.Pool,private enabled:(id:string)=>boolean,private steps:(id:string)=>boolean){}
 async record(actor:number,daemon:string,call:string,input:ExternalUsageRequest){
  if(!input||input.phase!=='account'||!text(input.remote_task_id,1024)||!input.usage||!text(input.usage.chat_id)||!text(input.usage.session_id)||!input.usage.session_id.startsWith('matrix:!')||!Array.isArray(input.usage.turns)||input.usage.turns.length<1||input.usage.turns.length>1000)fail()
  const ids=new Set<string>()
  const turns=input.usage.turns.map(t=>{
   if(!t||!text(t.original_id)||!text(t.model,128)||!text(t.finished_at)||!Number.isFinite(Date.parse(t.finished_at))||Date.parse(t.finished_at)>Date.now()+300000||ids.has(t.original_id))fail()
   ids.add(t.original_id)
   for(const key of ['input_tokens','output_tokens','cache_read_tokens','cache_create_tokens','total_tokens'] as const)if(!Number.isSafeInteger(t[key])||t[key]<0||t[key]>2**50)fail()
   if(t.total_tokens!==t.input_tokens+t.output_tokens+t.cache_read_tokens+t.cache_create_tokens)fail()
   return {original_id:t.original_id,model:t.model,finished_at:new Date(t.finished_at).toISOString(),input_tokens:t.input_tokens,output_tokens:t.output_tokens,cache_read_tokens:t.cache_read_tokens,cache_create_tokens:t.cache_create_tokens,total_tokens:t.total_tokens}
  }).sort((a,b)=>a.original_id.localeCompare(b.original_id))
  const client=await this.pool.connect()
  try{
   await client.query('BEGIN')
   await client.query('SELECT call_id FROM collaboration_calls WHERE call_id=$1 FOR UPDATE',[call])
   const authority=new TeamExternalAuthorizationService(client,this.enabled,this.steps)
   await authority.authorize(actor,daemon,call,{authorization:input.authorization,request_id:input.request_id,native_session_id:input.native_session_id,phase:'account'})
   let inserted=0
   for(const turn of turns){
    // Different calls cannot count the same Worker turn twice. Identity and
    // normalized facts remain immutable even when the HTTP response is lost.
    const fact='agentteams:'+createHash('sha256').update(JSON.stringify([actor,daemon,input.usage.chat_id,turn.original_id])).digest('hex')
    const evidence={remote_task_id:input.remote_task_id,session_id:input.usage.session_id,turn}
    const old=(await client.query('SELECT call_id,request_id,evidence FROM team_external_usage_facts WHERE fact_key=$1',[fact])).rows[0]
    if(old){
     const equal=old.call_id===call&&old.request_id===input.request_id&&old.evidence.remote_task_id===evidence.remote_task_id&&old.evidence.session_id===evidence.session_id&&Object.entries(turn).every(([k,v])=>old.evidence.turn?.[k]===v)
     if(!equal)throw new TeamRepositoryError('revision_conflict','External usage fact changed')
     continue
    }
    const saved=await client.query(`INSERT INTO token_usage_facts(fact_key,user_id,daemon_id,session_id,agent_type,model,usage_date,recorded_at,input,output,cache_read,cache_create,reasoning,reported_total,requests)
      VALUES($1,$2,$3,$4,'agentteams',$5,($6::timestamptz AT TIME ZONE 'UTC')::date,$6,$7,$8,$9,$10,0,$11,1) ON CONFLICT DO NOTHING RETURNING fact_key`,[fact,actor,daemon,input.native_session_id,turn.model,turn.finished_at,turn.input_tokens,turn.output_tokens,turn.cache_read_tokens,turn.cache_create_tokens,turn.total_tokens])
    if(saved.rowCount!==1)throw new TeamRepositoryError('revision_conflict','External usage identity already recorded')
    await client.query('INSERT INTO team_external_usage_facts(fact_key,call_id,request_id,remote_task_id,chat_id,original_turn_id,evidence) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[fact,call,input.request_id,input.remote_task_id,input.usage.chat_id,turn.original_id,JSON.stringify(evidence)])
    const session=await client.query(`UPDATE sessions SET tok_input=COALESCE(tok_input,0)+$2,tok_output=COALESCE(tok_output,0)+$3,tok_cache_read=COALESCE(tok_cache_read,0)+$4,tok_cache_create=COALESCE(tok_cache_create,0)+$5,total_tokens=COALESCE(total_tokens,0)+$6 WHERE session_id=$1 AND user_id=$7 AND daemon_id=$8`,[input.native_session_id,turn.input_tokens,turn.output_tokens,turn.cache_read_tokens,turn.cache_create_tokens,turn.total_tokens,actor,daemon])
    if(session.rowCount!==1)throw new TeamRepositoryError('revision_conflict','Original session no longer available')
    inserted++
   }
   await client.query('COMMIT')
   return {call_id:call,request_id:input.request_id,recorded_turns:turns.length,new_turns:inserted,cost_status:'unavailable' as const}
  }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 }
}
