import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {initDB} from '../../db.js'
import {TeamSessionService} from '../../team/session-service.js'
export const teamV2DatabaseEnabled=process.env.RUN_POSTGRES_INTEGRATION==='1' && Boolean(process.env.TEST_DATABASE_URL)
export async function teamV2Pool() {
  const url=new URL(process.env.TEST_DATABASE_URL!)
  if(url.hostname!=='127.0.0.1'||url.pathname!=='/team_relay_test'||url.username!=='team_relay_test') throw new Error('isolated Team database required')
  const pool=new pg.Pool({connectionString:url.toString()});await initDB(pool);return pool
}
export async function humanTeamFixture(pool:pg.Pool) {
  const key=randomUUID(),teamId=`t-${key}`
  const users=(await pool.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true),($2,'x',true),($3,'x',true) RETURNING id`,[`${key}-a@example.test`,`${key}-b@example.test`,`${key}-c@example.test`])).rows.map(r=>Number(r.id))
  await pool.query(`INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES($1,'v2 fixture',$2)`,[teamId,users[0]])
  for(const u of users) await pool.query(`INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id,role) VALUES($1,$2,$3,$4)`,[`m-${key}-${u}`,teamId,u,u===users[0]?'admin':'member'])
  const service=new TeamSessionService(pool)
  const session=await service.createSession({teamId,actorUserId:users[0],title:'v2 conversation',taskId:null,offerIds:[],participantUserIds:users.slice(1),requestId:key})
  const send=(requestId:string,actor=users[0])=>service.appendMessage({sessionId:session.id,actorUserId:actor,requestId,content:requestId,targetMode:'discussion',targetOfferIds:[],referenceEventId:null})
  return {key,teamId,users,service,session,send}
}
