/** Synthetic, loopback-only reproduction. Never accepts a production database. */
import pg from 'pg'
import { initDB } from '../src/db.js'
import { assertDurableIngressTestDatabase } from '../src/__tests__/durable-ingress-test-db.js'
import { InboxRepository } from '../src/ingress/inbox-repository.js'
import { createInboxWorker } from '../src/inbox-worker.js'
import { EventMaterializer } from '../src/materialization/event-materializer.js'
import { RealtimeOutboxWriter } from '../src/materialization/realtime-outbox.js'

const url = process.env.TEST_DATABASE_URL!
const pool = new pg.Pool({connectionString:url,max:8})
await assertDurableIngressTestDatabase(pool,url)
const stats = new Map<string,{count:number,totalMs:number,maxMs:number}>()
let profiling = false
function query(target:any,args:any[]) {
  const sql=String(args[0]?.text ?? args[0]).replace(/\s+/g,' ').trim()
  const start=performance.now()
  const result=target.query(...args)
  return result.finally(()=>{
    if(!profiling)return
    const key=sql.slice(0,180),stat=stats.get(key)??{count:0,totalMs:0,maxMs:0},ms=performance.now()-start
    stat.count++;stat.totalMs+=ms;stat.maxMs=Math.max(stat.maxMs,ms);stats.set(key,stat)
  })
}
const profiled = new Proxy(pool,{get(target,key){
  if(key==='query')return (...args:any[])=>query(target,args)
  if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(c,k){
    if(k==='query')return (...args:any[])=>query(c,args)
    const v=Reflect.get(c,k);return typeof v==='function'?v.bind(c):v
  }})}
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v
}})
try {
  await initDB(pool)
  // Another worker or an abandoned run would invalidate query/time totals.
  // The fixture's services must be stopped before running this serial probe.
  const pending = await pool.query('SELECT count(*)::int AS count FROM event_inbox WHERE status IN(0,1)')
  if (pending.rows[0].count !== 0) throw new Error('profile requires an empty pending inbox and no other worker')
  const user = await pool.query(`INSERT INTO users(email,password_hash) VALUES('cu-queue-profile@example.test','') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`)
  const uid=user.rows[0].id
  await pool.query(`INSERT INTO daemons(daemon_id,user_id) VALUES('cu-queue-profile',$1) ON CONFLICT(daemon_id) DO NOTHING`,[uid])
  for(const sid of ['cu-profile-history','cu-profile-live'])await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,status,cwd) VALUES($1,'cu-queue-profile',$2,'claude-code','running','/synthetic') ON CONFLICT(session_id) DO NOTHING`,[sid,uid])
  const seed=Math.max(0,Number(process.env.PROFILE_SEED_EVENTS??0))
  if(seed>0){
    await pool.query(`INSERT INTO events(session_id,event_type,payload,event_hash,effect_status,user_id) SELECT 'cu-profile-history','tool_result',jsonb_build_object('type','tool_result','output','synthetic background'),'seed:'||g,'none',$2 FROM generate_series(1,$1::int) g ON CONFLICT(session_id,event_hash) DO NOTHING`,[seed,uid])
    await pool.query('ANALYZE events')
  }
  const generation=Date.now(),count=Number(process.env.PROFILE_BACKLOG??128)
  const seedInbox=Math.max(0,Number(process.env.PROFILE_SEED_INBOX??0))
  if(seedInbox>0){
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,payload,status,completed_at)
      SELECT 'old-inbox-profile',1,g,'old-inbox-profile-'||g,'tool_result',2,'{}'::jsonb,2,NOW()
      FROM generate_series(1,$1::int) g ON CONFLICT DO NOTHING`,[seedInbox])
    await pool.query('ANALYZE event_inbox')
  }
  const repository=new InboxRepository(profiled)
  await repository.persistBatch(Array.from({length:count},(_,i)=>({
    userId:uid,daemonId:'cu-queue-profile',registrationId:'profile',daemonGeneration:generation,seq:i+1,
    dedupKey:`profile:${generation}:${i}`,sessionId:'cu-profile-live',eventType:'tool_result',priority:process.env.PROFILE_RESYNC==='true'?'replay' as const:'live' as const,
    payload:{type:'tool_result',session_id:'cu-profile-live',call_id:`profile:${generation}:${i}`,output:'synthetic tool result',seq:i+1,...(process.env.PROFILE_RESYNC==='true'?{resync:true}:{}),...(process.env.PROFILE_STABLE_IDS==='true'?{event_id:`profile:${generation}:${i}`}:{})},
    materializationContext:{agentType:'',cwd:'',hostname:'isolated',reservationId:null},receivedAt:new Date(),
  })))
  const materializer=new EventMaterializer({pool:profiled})
  const worker=createInboxWorker({repository,materializer:process.env.PROFILE_DISABLE_REPLAY_BATCH==='true'?{materialize:materializer.materialize.bind(materializer)}:materializer,outboxWriter:new RealtimeOutboxWriter(profiled),workerId:'cu-profile-worker',shardCount:1,shardIndex:0,maxDrainPasses:count+1})
  profiling=true
  const start=performance.now();await worker.runOnce();const totalMs=performance.now()-start;profiling=false
  const remaining=await pool.query(`SELECT count(*) FROM event_inbox WHERE daemon_id='cu-queue-profile' AND daemon_generation=$1 AND status<>2`,[generation])
  console.log(JSON.stringify({seed,seedInbox,resync:process.env.PROFILE_RESYNC==='true',stableIDs:process.env.PROFILE_STABLE_IDS==='true',extensions:process.env.RELAY_EXTENSIONS??'off',batch:process.env.PROFILE_DISABLE_REPLAY_BATCH!=='true',count,totalMs,perEventMs:totalMs/count,remaining:remaining.rows[0].count,queries:[...stats].map(([sql,s])=>({sql,...s,meanMs:s.totalMs/s.count})).sort((a,b)=>b.totalMs-a.totalMs)},null,2))
} finally {await pool.end()}
