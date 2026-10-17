import type pg from 'pg'
import {requireTeamAccess} from './access.js'
import {TeamRepositoryError} from './repository.js'

export class TeamReadStateService {
 constructor(private readonly pool:pg.Pool){}
 private async authorize(db:Pick<pg.Pool,'query'>,sessionId:string,userId:number,lock=false) {
  await requireTeamAccess(db,userId,lock)
  const row=(await db.query(`SELECT s.* FROM collaboration_sessions s
   JOIN collaboration_teams t ON t.team_id=s.team_id AND t.state='active'
   JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=$2 AND m.state='active'
   JOIN collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=$2 AND p.state='active'
   WHERE s.team_session_id=$1 ${lock?'FOR SHARE OF s,t,m,p':''}`,[sessionId,userId])).rows[0]
  if(!row) throw new TeamRepositoryError('team_not_found','shared session not found')
  return row
 }
 async advance(sessionId:string,userId:number,eventSeq:number) {
  const client=await this.pool.connect()
  try {
   await client.query('BEGIN')
   const session=await this.authorize(client,sessionId,userId,true)
   if(!Number.isSafeInteger(eventSeq)||eventSeq<0||eventSeq>Number(session.latest_event_seq)) throw new TeamRepositoryError('invalid_state','read position exceeds shared high water')
   const row=(await client.query(`INSERT INTO team_read_positions(team_session_id,user_id,event_seq) VALUES($1,$2,$3)
     ON CONFLICT(team_session_id,user_id) DO UPDATE SET event_seq=GREATEST(team_read_positions.event_seq,EXCLUDED.event_seq),updated_at=NOW() RETURNING event_seq`,[sessionId,userId,eventSeq])).rows[0]
   await client.query('COMMIT');return {event_seq:Number(row.event_seq)}
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
 }
 async summary(sessionId:string,userId:number) {
  await this.authorize(this.pool,sessionId,userId)
  const row=(await this.pool.query(`SELECT COALESCE(r.event_seq,0) AS read_event_seq,
    (SELECT COUNT(DISTINCT CASE WHEN e.kind='agent_message' AND e.call_id IS NOT NULL THEN 'call:'||e.call_id ELSE e.event_id END)
     FROM collaboration_events e WHERE e.team_session_id=s.team_session_id AND e.event_seq>COALESCE(r.event_seq,0)
       AND e.kind IN ('member_message','agent_message') AND (e.author_user_id IS NULL OR e.author_user_id<>$2)) AS unread_count,
    (SELECT e.content FROM collaboration_events e WHERE e.team_session_id=s.team_session_id AND e.kind IN ('member_message','agent_message') ORDER BY e.event_seq DESC LIMIT 1) AS preview
    FROM collaboration_sessions s LEFT JOIN team_read_positions r ON r.team_session_id=s.team_session_id AND r.user_id=$2 WHERE s.team_session_id=$1`,[sessionId,userId])).rows[0]
  return {read_event_seq:Number(row.read_event_seq),unread_count:Number(row.unread_count),preview:row.preview??null}
 }
}
