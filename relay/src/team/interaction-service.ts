import type pg from 'pg'
import {requireTeamAccess} from './access.js'
import {TeamRepositoryError} from './repository.js'
import {mapAttentionItemRow} from '../attention-inbox/repository.js'
import {serializeAttentionItem} from '../attention-inbox/dto.js'
import type {AttentionInboxService} from '../attention-inbox/service.js'

// A Team interaction is a view of the owner Inbox item, never a second request.
export class TeamInteractionService {
 constructor(private readonly pool:pg.Pool,private readonly inbox:AttentionInboxService){}
 private async authorize(db:Pick<pg.Pool,'query'>,session:string,user:number,lock=false){
  await requireTeamAccess(db,user,lock)
  const r=await db.query(`SELECT s.team_session_id FROM collaboration_sessions s
    JOIN collaboration_teams t ON t.team_id=s.team_id AND t.state='active'
    JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=$2 AND m.state='active'
    JOIN collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=$2 AND p.state='active'
    WHERE s.team_session_id=$1 ${lock?'FOR SHARE OF s,t,m,p':''}`,[session,user])
  if(!r.rows[0])throw new TeamRepositoryError('team_not_found','shared session not found')
 }
 async list(session:string,user:number){
  const client=await this.pool.connect()
  try{
   await client.query('BEGIN');await this.authorize(client,session,user,true)
   // The native session + authenticated daemon owner is the trusted join. The
   // request's immutable Inbox ID remains the action/CAS/idempotency authority.
   await client.query(`INSERT INTO team_private_interaction_links(attention_item_id,team_session_id,binding_id,call_id,owner_user_id)
     SELECT DISTINCT ON (i.item_id) i.item_id,c.team_session_id,c.binding_id,c.call_id,i.user_id
     FROM attention_items i JOIN collaboration_calls c ON c.native_session_id=i.session_id
     JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.owner_user_id=i.user_id AND o.daemon_id=i.daemon_id
     JOIN collaboration_session_agent_bindings b ON b.binding_id=c.binding_id AND b.owner_user_id=i.user_id
     WHERE c.team_session_id=$1 AND i.user_id=$2 ORDER BY i.item_id,c.created_at DESC
     ON CONFLICT(attention_item_id) DO NOTHING`,[session,user])
   const rows=(await client.query(`SELECT i.* FROM team_private_interaction_links l JOIN attention_items i ON i.item_id=l.attention_item_id
      WHERE l.team_session_id=$1 AND l.owner_user_id=$2 AND i.user_id=$2
      ORDER BY i.updated_at DESC,i.item_id DESC LIMIT 100`,[session,user])).rows
   await client.query('COMMIT')
   return {items:rows.map(r=>serializeAttentionItem(mapAttentionItemRow(r))),private_cursor:rows.map(r=>`${r.item_id}:${r.revision}`).join(',')}
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }
 async submit(input:{sessionId:string;userId:number;itemId:string;idempotencyKey:string;expectedRevision:number;action:'once'|'reject'}){
  const client=await this.pool.connect()
  try{
   await client.query('BEGIN');await this.authorize(client,input.sessionId,input.userId,true)
   const link=await client.query(`SELECT l.attention_item_id FROM team_private_interaction_links l JOIN attention_items i ON i.item_id=l.attention_item_id JOIN daemons d ON d.daemon_id=i.daemon_id AND d.user_id=i.user_id WHERE l.team_session_id=$1 AND l.owner_user_id=$2 AND l.attention_item_id=$3 AND (i.provider NOT IN ('claude-code','dsh') OR d.collaboration_capabilities ? 'team_private_interactions_v2')`,[input.sessionId,input.userId,input.itemId])
   if(!link.rows[0])throw new TeamRepositoryError('team_not_found','interaction not found')
   // Hold the membership barrier through native Inbox admission. The original
   // service handles opposite actions, retries, unknown results and terminals.
   const result=await this.inbox.submitAction({userId:input.userId,itemId:input.itemId,idempotencyKey:input.idempotencyKey,request:{expectedRevision:input.expectedRevision,actionId:input.action}})
   await client.query('COMMIT')
   return result.outcome==='error'?{outcome:'error',code:result.code,...(result.item?{item:serializeAttentionItem(result.item)}:{})}:{...result,item:serializeAttentionItem(result.item)}
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }
}

// An older worker can advance its Inbox cursor over a provider it did not
// understand. Recover terminal facts from the original native event without
// moving that cursor backwards or creating another approval request.
export async function recoverTeamPrivateResolutions(pool:pg.Pool,repository:Pick<import('../attention-inbox/repository.js').AttentionInboxRepository,'applyProjection'>):Promise<number>{
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  const rows=(await client.query(`SELECT DISTINCT ON(i.item_id) e.id,e.event_type,e.session_id,e.payload,e.created_at,e.body_storage,
      i.user_id,i.daemon_id,i.provider AS agent_type,s.control_mode,s.title AS session_title,s.status AS session_status
    FROM attention_items i JOIN sessions s ON s.session_id=i.session_id AND s.user_id=i.user_id AND s.daemon_id=i.daemon_id
    JOIN events e ON e.session_id=i.session_id AND e.payload->>'request_id'=i.request_id
    WHERE i.context->>'team_native_request'='true' AND i.state IN ('open','snoozed','submitting','result_unknown')
      AND e.event_type IN ('approval_resolved','question_resolved')
    ORDER BY i.item_id,e.id ASC LIMIT 50`)).rows
  const {projectAttentionEvent}=await import('../attention-inbox/projector.js')
  for(const row of rows){
   if(row.body_storage==='cold')throw new Error('private interaction recovery requires native body reconciliation')
   const projection=projectAttentionEvent({eventId:Number(row.id),eventType:row.event_type,sessionId:row.session_id,payload:row.payload??{},userId:Number(row.user_id),daemonId:row.daemon_id,provider:row.agent_type,controlMode:row.control_mode,capabilities:['team_private_interactions_v2'],sessionTitle:row.session_title,sessionStatus:row.session_status,daemonAlias:null,daemonHostname:null,createdAt:new Date(row.created_at)})
   if(projection?.operation==='resolve')await repository.applyProjection(client,projection)
  }
  await client.query('COMMIT');return rows.length
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
