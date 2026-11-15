import type pg from 'pg'
import type {MaterializationInput} from '../materialization/types.js'
export type Outcome='success'|'failure'|'unknown'
export interface CallState {hasStart:boolean;revision:number;outcome:Outcome;occurredAt:string}
export function mergeCall(previous:CallState|undefined,next:CallState):CallState {if(!previous)return next;if(next.revision<previous.revision)return next.hasStart&&!previous.hasStart?{...previous,hasStart:true,occurredAt:next.occurredAt}:previous;return {hasStart:previous.hasStart||next.hasStart,revision:Math.max(previous.revision,next.revision),outcome:next.revision>previous.revision||previous.outcome==='unknown'?next.outcome:previous.outcome,occurredAt:previous.hasStart?previous.occurredAt:next.occurredAt}}
export function explicitSkill(meta:Record<string,unknown>){return meta.evidence_kind==='native_skill_execution'&&typeof meta.skill_key==='string'&&typeof meta.skill_name==='string'}
/** Runs on the canonical event's transaction client, before ACK/checkpoint.
 * A replay of a completed event repairs this independent idempotent projection. */
export async function projectUsageCall(db:Pick<pg.Pool,'query'>,input:MaterializationInput,eventId:number){
 if(!['tool_call','tool_result'].includes(input.eventType)||input.userId===null||!input.sessionId)return
 const authority=(await db.query('SELECT native_session_authority($1,$2,$3) AS value',[input.sessionId,input.userId,input.daemonId])).rows[0]?.value
 const sourceSession=authority?.state==='current'?authority.originSessionId??input.sessionId:input.sessionId
 const m=input.payload.call_meta as Record<string,unknown>|undefined
 // Legacy calls have no proven source clock/classification/revision. Do not guess.
 if(!m||m.version!==1||typeof m.invocation_id!=='string'||!m.invocation_id||m.invocation_id.length>200)return
 const runtime=String(input.context?.agentType??input.payload.agent??'unknown'),received=input.receivedAt??new Date();let occurred=new Date(String(m.occurred_at));let quality='source'
 if(!Number.isFinite(+occurred)||+occurred>+received+300000||+occurred<Date.UTC(2000,0,1)){occurred=received;quality='receipt_fallback'}
 let revision=Number.isSafeInteger(m.revision)&&Number(m.revision)>=0?Number(m.revision):0
 const start=input.eventType==='tool_call',kind=['builtin','mcp','unknown'].includes(String(m.tool_kind))?String(m.tool_kind):'unknown'
 let outcome:Outcome=['success','failure'].includes(String(m.outcome))?m.outcome as Outcome:'unknown'
 const eventIdentity=typeof input.payload.event_id==='string'?input.payload.event_id.slice(0,300):null,previousIdentity=typeof input.payload.previous_event_id==='string'?input.payload.previous_event_id.slice(0,300):null
 if(eventIdentity){
  await db.query(`INSERT INTO usage_call_event_metadata(owner_user_id,daemon_id,runtime,source_session,invocation_id,event_identity,previous_identity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[input.userId,input.daemonId,runtime,sourceSession,m.invocation_id,eventIdentity,previousIdentity])
  const prior=(await db.query(`SELECT * FROM usage_call_facts WHERE owner_user_id=$1 AND daemon_id=$2 AND runtime=$3 AND source_session=$4 AND invocation_id=$5 FOR UPDATE`,[input.userId,input.daemonId,runtime,sourceSession,m.invocation_id])).rows[0]
  if(prior){const phase=start?'start':'outcome',currentIdentity=prior[phase+'_identity'],currentRevision=Number(prior[phase+'_revision']);
   const edges=(await db.query(`SELECT event_identity,previous_identity FROM usage_call_event_metadata WHERE owner_user_id=$1 AND daemon_id=$2 AND runtime=$3 AND source_session=$4 AND invocation_id=$5`,[input.userId,input.daemonId,runtime,sourceSession,m.invocation_id])).rows
   const byId=new Map(edges.map(r=>[r.event_identity,r.previous_identity]));const precedes=(earlier:string,later:string)=>{const seen=new Set<string>();let next=byId.get(later);while(next&&!seen.has(next)){if(next===earlier)return true;seen.add(next);next=byId.get(next)}return false}
   if(currentIdentity===eventIdentity||currentIdentity&&precedes(eventIdentity,currentIdentity))return
   if(currentIdentity&&precedes(currentIdentity,eventIdentity))revision=Math.max(revision,currentRevision+1)
   else if(currentRevision>=0&&revision<=currentRevision){if(revision<currentRevision)return;if(!start&&outcome!==prior.outcome){outcome='unknown';quality='revision_order_unverified';revision=currentRevision+1}else return}
  }
 }
 await db.query(`INSERT INTO usage_call_facts(owner_user_id,daemon_id,runtime,source_session,invocation_id,source_event_id,revision,tool_kind,tool_name,mcp_server,occurred_at,received_at,outcome,has_start,quality,start_revision,outcome_revision,start_identity,outcome_identity)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CASE WHEN $14 THEN $7::bigint ELSE -1::bigint END,CASE WHEN NOT $14 THEN $7::bigint ELSE -1::bigint END,CASE WHEN $14 THEN $16::text END,CASE WHEN NOT $14 THEN $16::text END)
 ON CONFLICT(owner_user_id,daemon_id,runtime,source_session,invocation_id) DO UPDATE SET
 source_event_id=EXCLUDED.source_event_id,start_identity=CASE WHEN EXCLUDED.has_start AND EXCLUDED.start_revision>=usage_call_facts.start_revision THEN EXCLUDED.start_identity ELSE usage_call_facts.start_identity END,outcome_identity=CASE WHEN NOT EXCLUDED.has_start AND EXCLUDED.outcome_revision>=usage_call_facts.outcome_revision THEN EXCLUDED.outcome_identity ELSE usage_call_facts.outcome_identity END,quality=EXCLUDED.quality,start_revision=GREATEST(usage_call_facts.start_revision,EXCLUDED.start_revision),outcome_revision=GREATEST(usage_call_facts.outcome_revision,EXCLUDED.outcome_revision),revision=GREATEST(usage_call_facts.revision,EXCLUDED.revision),
 tool_kind=CASE WHEN EXCLUDED.has_start AND EXCLUDED.start_revision>=usage_call_facts.start_revision THEN EXCLUDED.tool_kind ELSE usage_call_facts.tool_kind END,
 tool_name=CASE WHEN EXCLUDED.has_start AND EXCLUDED.start_revision>=usage_call_facts.start_revision THEN EXCLUDED.tool_name ELSE usage_call_facts.tool_name END,
 mcp_server=CASE WHEN EXCLUDED.has_start AND EXCLUDED.start_revision>=usage_call_facts.start_revision THEN EXCLUDED.mcp_server ELSE usage_call_facts.mcp_server END,
 occurred_at=CASE WHEN usage_call_facts.has_start THEN usage_call_facts.occurred_at ELSE EXCLUDED.occurred_at END,
 has_start=usage_call_facts.has_start OR EXCLUDED.has_start,
 outcome=CASE WHEN NOT EXCLUDED.has_start AND (EXCLUDED.outcome_revision>usage_call_facts.outcome_revision OR usage_call_facts.outcome='unknown') THEN EXCLUDED.outcome ELSE usage_call_facts.outcome END
 WHERE EXCLUDED.start_revision>=usage_call_facts.start_revision OR EXCLUDED.outcome_revision>=usage_call_facts.outcome_revision`,[input.userId,input.daemonId,runtime,sourceSession,m.invocation_id,eventId,revision,kind,String(m.tool_name??'unknown').slice(0,500),typeof m.mcp_server==='string'?m.mcp_server.slice(0,200):null,occurred,received,outcome,start,quality,eventIdentity])
 if(start&&explicitSkill(m))await db.query(`INSERT INTO usage_skill_facts(owner_user_id,daemon_id,runtime,source_session,skill_invocation_id,skill_key,skill_name,occurred_at,evidence_kind,evidence_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'native_skill_execution',1) ON CONFLICT DO NOTHING`,[input.userId,input.daemonId,runtime,sourceSession,m.invocation_id,String(m.skill_key).slice(0,200),String(m.skill_name).slice(0,500),occurred])

}
