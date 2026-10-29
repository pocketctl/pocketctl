import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {initDB} from '../db.js'
import {humanTeamFixture} from './fixtures/team-v2.js'
import {TeamDispatchRepository} from '../team/dispatch-repository.js'
const enabled=process.env.RUN_POSTGRES_INTEGRATION==='1'&&Boolean(process.env.TEST_DATABASE_URL)
;(enabled?describe:describe.skip)('authoritative original terminal after daemon disconnect',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  const url=new URL(process.env.TEST_DATABASE_URL!)
  if(url.hostname!=='127.0.0.1'||url.port!=='19030'||url.pathname!=='/team_relay_test'||url.username!=='team_relay_test')throw Error('dedicated disposable database required')
  pool=new pg.Pool({connectionString:url.href})
  expect((await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper).toBe(false)
  await initDB(pool)
 },30000)
 beforeEach(async()=>{await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE')})
 afterAll(async()=>{await pool?.end()})
 test.each(['completed','failed','missing-receipt','generation-mismatch','wrong-owner','earlier-terminal','unaccepted','other-uncertainty','forged-terminal','subagent','nonterminal','receipt-auth-mismatch','missing-generation','terminal-before-receipt','receipt-pending'])( '%s preserves the original Call identity and authority',async scenario=>{
  const f=await humanTeamFixture(pool),owner=f.users[0],daemon='uncertain-daemon',offer='uncertain-offer',native='uncertain-native',repo=new TeamDispatchRepository(pool)
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'isolated','online',$2,'[{"type":"claude-code","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[daemon,owner])
  await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'claude-code')`,[offer,f.teamId,owner,daemon])
  await f.service.changeBinding({sessionId:f.session.id,actorUserId:owner,offerId:offer,active:true,expectedRevision:f.session.revision,requestId:'bind'})
  const message=await f.service.appendMessage({sessionId:f.session.id,actorUserId:owner,requestId:'request',content:'One original invocation',targetMode:'offers',targetOfferIds:[offer],referenceEventId:null,contextVersion:0})
  const claimed=await repo.claim(message.call_ids[0]);expect(claimed).toBeTruthy()
  const id=claimed!.callId
  await repo.bindNativeSession(id,daemon,owner,native)
  if(scenario!=='unaccepted')await repo.recordReceipt(id,daemon,owner,'accepted',null)
  await repo.markDaemonUncertain(daemon)
  if(scenario==='other-uncertainty')await pool.query("UPDATE collaboration_calls SET outcome='dispatch_internal_error' WHERE call_id=$1",[id])
  const receipt={type:'collaboration_dispatch_receipt',session_id:native,seq:5,status:'accepted',collaboration:scenario==='receipt-auth-mismatch'?{...claimed!.authorization,owner_user_id:f.users[1]}:claimed!.authorization}
  const terminal={type:scenario==='nonterminal'?'agent_text':'turn_status',session_id:native,seq:scenario==='terminal-before-receipt'?3:10,turn_status:scenario==='failed'?'failed':'completed',...(scenario==='subagent'?{is_subagent:true}:{}),...(scenario==='nonterminal'?{text:'Still running'}:{})}
  const persist=async(seq:number,type:string,payload:unknown)=>pool.query(`INSERT INTO event_inbox(user_id,daemon_id,daemon_generation,seq,dedup_key,session_id,event_type,priority_class,status,payload) VALUES($1,$2,77,$3,$4,$5,$6,0,2,$7::jsonb)`,[owner,daemon,seq,'uncertain:'+seq,native,type,JSON.stringify(payload)])
  if(scenario!=='missing-receipt')await persist(5,receipt.type,receipt)
  if(scenario==='receipt-pending')await pool.query("UPDATE event_inbox SET status=1 WHERE seq=5")
  if(scenario==='earlier-terminal')await persist(8,'turn_status',{...terminal,seq:8})
  if(scenario!=='forged-terminal')await persist(terminal.seq,terminal.type,terminal)
  const result=await repo.projectDaemonEvent(daemon,scenario==='wrong-owner'?f.users[1]:owner,terminal,scenario==='missing-generation'?undefined:scenario==='generation-mismatch'?78:77)
  const row=(await pool.query('SELECT state,outcome,finished_at FROM collaboration_calls WHERE call_id=$1',[id])).rows[0]
  if(['completed','failed'].includes(scenario)){
   expect(result?.event.call_id).toBe(id);expect(row.state).toBe(scenario);expect(row.finished_at).toBeTruthy()
   expect(await repo.projectDaemonEvent(daemon,owner,terminal,77)).toBeNull()
  }else{expect(result).toBeNull();expect(row.state).toBe('uncertain');expect(row.finished_at).toBeNull()}
  expect((await pool.query('SELECT call_id FROM collaboration_calls')).rows).toEqual([{call_id:id}])
 })
})
