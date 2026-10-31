import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import pg from 'pg'
import Fastify from 'fastify'
import {initDB} from '../db.js'
import {lifecycleTestPool} from './session-lifecycle-test-database.js'
import {AttentionNotificationRepository} from '../attention-inbox/notification-repository.js'
import {LifecycleJobRepository} from '../session-lifecycle/repository.js'
import {publishMaintenanceSummaries} from '../session-lifecycle/maintenance-summary.js'
import {maintenanceSlot} from '../session-lifecycle/schedule.js'
import {registerMaintenanceRoutes} from '../extensions/maintenance-routes.js'
import {signProviderExtensionToken} from '../extensions/provider-auth.js'
const suite=process.env.RUN_SESSION_LIFECYCLE_POSTGRES==='1'?describe:describe.skip
suite('one notification for the entire maintenance cycle',()=>{
 let pool:pg.Pool,repo:AttentionNotificationRepository,user:number,other:number
 const installation=randomUUID(),slot=maintenanceSlot('archive',new Date()),day=new Date(slot.getTime()+8*3600000).toISOString().slice(0,10)
 const beforeDeadline=new Date(slot.getTime()+3600000),afterDeadline=new Date(slot.getTime()+3*3600000)
 beforeAll(async()=>{pool=await lifecycleTestPool();await initDB(pool);repo=new AttentionNotificationRepository(pool,'maintenance-test')},30000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE users,daemons,sessions,extension_providers,session_lifecycle_daily_runs CASCADE')
  user=(await pool.query("INSERT INTO users(email,password_hash) VALUES('maint@test.invalid','x') RETURNING id")).rows[0].id
  other=(await pool.query("INSERT INTO users(email,password_hash) VALUES('other@test.invalid','x') RETURNING id")).rows[0].id
  await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('maint-a',$1),('maint-b',$1)",[user])
  await pool.query(`INSERT INTO extension_providers(provider_id,manifest_version,manifest,trust_level,status) VALUES('pocketctl-memory',1,'{}','first_party','enabled')`)
  await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,start_policy,created_at)
   VALUES($1,'pocketctl-memory',$2,'active','{}','{}','{}','from_now',$3::timestamptz-INTERVAL '1 day')`,[installation,user,slot])
 })
 async function record(session:string,state:'running'|'succeeded'|'partial'='succeeded',host='maint-a'){
  const job=await new LifecycleJobRepository(pool).enqueue({userId:user,sessionId:session,action:'archive',policyVersion:'session-lifecycle-v2',activityEpoch:'1',scheduledAt:slot})
  const c=await pool.connect();try{await c.query('BEGIN');const r=await repo.recordResultInTransaction(c,{operationId:job.operationId,notificationId:randomUUID(),userId:user,sessionId:session,daemonId:host,titleSnapshot:session,daemonNameSnapshot:host,action:'archive',state,activityAt:slot.toISOString(),reasonCode:'inactivity_30_days',retentionDays:90});await c.query('COMMIT');return r}finally{c.release()}
 }
 async function finishRelay(){await pool.query(`INSERT INTO session_lifecycle_daily_runs(policy_version,action,scheduled_at,completed_at) VALUES('session-lifecycle-v2','archive',$1,NOW()),('session-lifecycle-v2','purge',$1,NOW())`,[slot])}
 async function memory(state='completed',revision=1,counts={inbox_body:500}){await pool.query(`INSERT INTO maintenance_provider_results(installation_id,scheduled_at,revision,state,counts,started_at,completed_at)
  VALUES($1,$2,$3,$4,$5,$2,CASE WHEN $4='completed' THEN NOW() ELSE NULL END) ON CONFLICT(installation_id,scheduled_at) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,counts=EXCLUDED.counts`,[installation,slot,revision,state,JSON.stringify(counts)])}
 const publish=(now=beforeDeadline)=>publishMaintenanceSummaries(pool,'session-lifecycle-v2',true,now)
 test('draft progress is invisible, all subjects and Memory results publish once',async()=>{
  const a=await record('a','running');await record('b','succeeded','maint-b')
  expect((await repo.list({userId:user,limit:10})).notifications).toHaveLength(0)
  expect(await repo.get(user,a.notificationId)).toBeNull()
  expect((await pool.query('SELECT count(*)::int n FROM notification_delivery_outbox')).rows[0].n).toBe(0)
  await finishRelay();expect(await publish()).toBe(0)
  await memory();await record('a','succeeded');expect(await publish()).toBe(1)
  const page=await repo.list({userId:user,limit:10});expect(page.unread).toBe(1);expect(page.notifications).toHaveLength(1)
  expect(page.notifications[0]).toMatchObject({subjectCount:2,maintenance:{state:'completed',counts:{inbox_body:500,session_archive:2}}})
  expect(await publish()).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM notification_delivery_outbox')).rows[0].n).toBe(1)
 })
 test('deadline produces a partial result; late completion preserves read status and notification identity',async()=>{
  const r=await record('a');await finishRelay();expect(await publish(afterDeadline)).toBe(1)
  const n=(await repo.get(user,r.notificationId))!;expect(n.maintenance?.state).toBe('partial')
  expect(await repo.markRead(user,r.notificationId,n.revision)).toBe('read')
  await memory();expect(await publish(afterDeadline)).toBe(1)
  const next=(await repo.get(user,r.notificationId))!;expect(next.readAt).not.toBeNull();expect(next.maintenance?.state).toBe('completed')
  expect((await repo.list({userId:user,limit:10})).unread).toBe(0)
 })
 test('Memory-only work appears in one global notification, never for another user or host scope',async()=>{
  await finishRelay();await memory();expect(await publish()).toBe(1)
  const p=await repo.list({userId:user,limit:10});expect(p.notifications).toHaveLength(1);expect(p.notifications[0].subjectCount).toBe(0)
  expect(await repo.get(other,p.notifications[0].id)).toBeNull()
  expect((await repo.list({userId:user,daemonId:'maint-a',limit:10})).notifications).toHaveLength(0)
  const n=p.notifications[0];expect(await repo.markRead(user,n.id,n.revision)).toBe('read')
  expect((await repo.subjects({userId:user,notificationId:n.id,limit:20}))?.total).toBe(0)
 })
 test('empty work produces no notification and historical notices are not republished',async()=>{
  await finishRelay();await memory('completed',1,{} as any);expect(await publish()).toBe(0)
  await pool.query(`INSERT INTO attention_notifications(notification_id,user_id,maintenance_day,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '90 days')`,[randomUUID(),user,day])
  expect(await publish()).toBe(0)
 })
 test('critical failures publish one immediate partial notice and subsequent results stay on it',async()=>{
  await memory('running',1,{} as any)
  await pool.query("UPDATE maintenance_provider_results SET last_error_code='42501'")
  expect(await publish()).toBe(1);expect(await publish()).toBe(0)
  const p=await repo.list({userId:user,limit:10});expect(p.notifications).toHaveLength(1);expect(p.notifications[0].maintenance?.state).toBe('partial')
 })
 test('ownership changes remove session summary counters while retaining authorized Memory counters',async()=>{
  const r=await record('a');await finishRelay();await memory();await publish()
  await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='maint-a'",[other])
  const n=(await repo.get(user,r.notificationId))!
  expect(n.subjectCount).toBe(0);expect(n.maintenance?.counts).toEqual({inbox_body:500})
  expect(await repo.get(other,r.notificationId)).toBeNull()
 })
 test('business resume appends to the original read notice without a new notification',async()=>{
  const r=await record('a');await finishRelay();await memory();await publish()
  const old=(await repo.get(user,r.notificationId))!;await repo.markRead(user,r.notificationId,old.revision)
  await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,archived_at,archive_reason,last_activity_at)
    VALUES('a',$1,'maint-a','idle',NOW()-INTERVAL '40 days','inactivity',NOW()-INTERVAL '40 days')`,[user])
  await pool.query("UPDATE sessions SET last_business_activity_at=NOW(),last_activity_at=NOW() WHERE session_id='a'")
  const page=await repo.list({userId:user,limit:10})
  expect(page.notifications).toHaveLength(1);expect(page.unread).toBe(0)
  expect(page.notifications[0].subjectCount).toBe(2);expect(page.notifications[0].subjects.some(s=>s.action==='resume')).toBe(true)
 })
 test('business resume with no original notice keeps an audit record without creating a notification',async()=>{
  await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,archived_at,archive_reason,last_activity_at)
    VALUES('old',$1,'maint-a','idle',NOW()-INTERVAL '40 days','inactivity',NOW()-INTERVAL '40 days')`,[user])
  await pool.query("UPDATE sessions SET last_business_activity_at=NOW(),last_activity_at=NOW() WHERE session_id='old'")
  expect((await pool.query("SELECT count(*)::int n FROM session_lifecycle_results WHERE action='resume'")).rows[0].n).toBe(1)
  expect((await repo.list({userId:user,limit:10})).notifications).toHaveLength(0)
 })
 test('provider reports reject cross-provider identity, arbitrary fields and stale revisions',async()=>{
  const app=Fastify(),secret='maintenance-token-secret',issuer='http://relay.test'
  registerMaintenanceRoutes(app,{pool,mode:'enabled',providerJwtSecret:secret,issuer})
  const token=(providerId:string)=>signProviderExtensionToken({providerId,credentialId:randomUUID(),secret,issuer})
  const body={installation_id:installation,scheduled_at:slot.toISOString(),revision:2,state:'completed',counts:{inbox_body:5},started_at:slot.toISOString(),completed_at:beforeDeadline.toISOString()}
  const send=(payload:any,provider='pocketctl-memory')=>app.inject({method:'POST',url:'/api/extensions/v1/maintenance',headers:{authorization:'Bearer '+token(provider)},payload})
  try{
   expect((await send(body,'other')).statusCode).toBe(404)
   expect((await send({...body,counts:{prompt:1}})).statusCode).toBe(400)
   expect((await send(body)).statusCode).toBe(200)
   expect((await send({...body,revision:1,counts:{inbox_body:100}})).statusCode).toBe(200)
   expect((await pool.query('SELECT counts FROM maintenance_provider_results')).rows[0].counts.inbox_body).toBe(5)
  }finally{await app.close()}
 })
})
