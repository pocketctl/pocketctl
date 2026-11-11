import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'

const url=process.env.SHARED_R1_NATIVE_PUBLICATION_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native publication against short shared-work metadata transactions',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  if(!url||!new URL(url).pathname.endsWith('_test'))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url,max:5})
  await pool.query('DROP SCHEMA IF EXISTS memory CASCADE;DROP SCHEMA IF EXISTS shared CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  const {initDB}=await import(new URL('../../../../relay/src/db.ts',import.meta.url).href)
  const {applyRelaySourceCapture}=await import(new URL('../../../../relay/src/shared-source/capture.ts',import.meta.url).href)
  await initDB(pool);await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool);await applyRelaySourceCapture(pool)
  await pool.query("INSERT INTO public.users(id,email,password_hash) VALUES(1,'native-publication@example.invalid','synthetic-only')")
 },60000)
 afterAll(async()=>{await pool?.end()})
 const insert=(client:Pick<pg.Pool,'query'>,session:string,id:number)=>client.query(`INSERT INTO public.events(id,user_id,session_id,event_type,payload,event_hash,effect_status)
  VALUES($1,1,$2,'agent_text','{"text":"synthetic native publication"}',$3,'completed')`,[id,session,'native-publication-'+id])
 async function prepare(session:string,id:number){
  await pool.query("INSERT INTO public.sessions(session_id,user_id,source) VALUES($1,1,'codex')",[session]);await insert(pool,session,id)
  return (await pool.query("SELECT * FROM shared.claim_memory_source_work($1,30,256)",['native-'+session])).rows.find(r=>r.root_key==='1:'+session)!
 }
 // The barrier holds a real SQL lease renewal (or mandatory positive SHARE)
 // transaction. Release only after the publisher is observed in its bounded
 // metadata acquisition, rather than racing a timer against the event insert.
 test.each(['renewal','distribution-step','positive-share'])('a released %s holder admits exactly one native revision without an Inbox retry',async mode=>{
  const id=mode==='renewal'?1000:mode==='distribution-step'?2500:2000
  const session='released-'+mode,claim=await prepare(session,id),holder=await pool.connect(),publisher=await pool.connect()
  let outcome:{error?:unknown}|undefined
  try{
   await holder.query('BEGIN')
   if(mode==='renewal')expect((await holder.query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30) AS valid',[claim.source_kind,claim.root_key,claim.lease_token,claim.lease_owner,claim.claimed_revision])).rows[0].valid).toBe(true)
   else if(mode==='distribution-step')await holder.query("SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,NULL,'',128)",[claim.source_kind,claim.root_key,claim.lease_token,claim.lease_owner,claim.claimed_revision])
   else await holder.query("SELECT 1 FROM shared.memory_source_work WHERE source_kind='relay_event' AND root_key=$1 FOR SHARE",['1:'+session])
   const pid=(await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const pending=insert(publisher,session,id+1).then(()=>{outcome={}},error=>{outcome={error}})
   let observed=false
   for(let n=0;n<200&&!outcome;n++){
    const row=(await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]
    if(row?.wait_event==='PgSleep'){observed=true;break}
   }
   if(observed){
    expect(outcome).toBeUndefined()
    expect((await pool.query('SELECT count(*)::int AS n FROM public.events WHERE session_id=$1',[session])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',['1:'+session])).rows[0].revision).toBe('1')
   }
   await holder.query('COMMIT');await pending
   expect(outcome?.error).toBeUndefined();expect(observed).toBe(true)
   expect((await pool.query('SELECT revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',['1:'+session])).rows[0]).toEqual({revision:'2',claimed_revision:'1'})
   expect((await pool.query('SELECT count(*)::int AS n FROM public.events WHERE session_id=$1',[session])).rows[0].n).toBe(2)
  }finally{await holder.query('ROLLBACK');holder.release();publisher.release()}
 })
 test('sustained row contention remains 55P03 and rolls back canonical publication and dirty state together',async()=>{
  const session='persistent-holder',claim=await prepare(session,3000),holder=await pool.connect(),publisher=await pool.connect()
  try{
   await holder.query('BEGIN');await holder.query('SELECT shared.renew_memory_source_lease($1,$2,$3,$4,$5,30)',[claim.source_kind,claim.root_key,claim.lease_token,claim.lease_owner,claim.claimed_revision])
   const started=performance.now()
   await expect(insert(publisher,session,3001)).rejects.toMatchObject({code:'55P03'})
   expect(performance.now()-started).toBeLessThan(1000)
   expect((await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',['1:'+session])).rows[0].revision).toBe('1')
   expect((await pool.query('SELECT 1 FROM public.events WHERE id=3001')).rowCount).toBe(0)
   await holder.query('COMMIT');await insert(publisher,session,3001)
   expect((await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',['1:'+session])).rows[0].revision).toBe('2')
  }finally{await holder.query('ROLLBACK');holder.release();publisher.release()}
 })
 test('a late smaller event ID still increments dirty state beyond an already claimed revision',async()=>{
  const session='late-small-id',claim=await prepare(session,4000),late=await pool.connect()
  try{
   await late.query('BEGIN');await insert(late,session,3999);await late.query('COMMIT')
   expect((await pool.query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5) AS valid',[claim.source_kind,claim.root_key,claim.lease_token,claim.lease_owner,claim.claimed_revision])).rows[0].valid).toBe(true)
   expect((await pool.query('SELECT revision::text,processed_revision::text FROM shared.memory_source_work WHERE root_key=$1',['1:'+session])).rows[0]).toEqual({revision:'2',processed_revision:'1'})
   const next=(await pool.query("SELECT * FROM shared.claim_memory_source_work('late-next',30,256)")).rows.find(r=>r.root_key==='1:'+session)
   expect(next.claimed_revision).toBe('2')
   expect((await pool.query('SELECT id::text FROM public.events WHERE session_id=$1 ORDER BY id',[session])).rows.map(r=>r.id)).toEqual(['3999','4000'])
  }finally{await late.query('ROLLBACK');late.release()}
 })
 test.each(['advisory-only','released-row','shared-cleanup-fence'] as const)('existing native row retains the independent writer/cleanup fence after tuple acquisition: %s',async mode=>{
  const id=mode==='advisory-only'?5000:mode==='released-row'?6000:6500,session='creation-mutex-existing-'+mode,claim=await prepare(session,id),holder=await pool.connect(),publisher=await pool.connect()
  let outcome:{error?:unknown}|undefined
  try{
   await holder.query('BEGIN');await holder.query(mode==='shared-cleanup-fence'?"SELECT pg_advisory_xact_lock_shared(hashtextextended('memory-source-dirty:relay_event:'||$1,0))":"SELECT pg_advisory_xact_lock(hashtextextended('memory-source-dirty:relay_event:'||$1,0))",[claim.root_key])
   if(mode==='released-row'){await holder.query('SAVEPOINT tuple_holder');await holder.query('SELECT 1 FROM shared.memory_source_work WHERE source_kind=$1 AND root_key=$2 FOR SHARE',[claim.source_kind,claim.root_key])}
   const pid=(await publisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const pending=insert(publisher,session,id+1).then(()=>{outcome={}},error=>{outcome={error}})
   if(mode==='released-row'){
    let observed=false;for(let n=0;n<200&&!outcome;n++){if((await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event==='PgSleep'){observed=true;break}}
    await holder.query('ROLLBACK TO SAVEPOINT tuple_holder');expect(observed).toBe(true)
   }
   await pending;expect(outcome?.error).toMatchObject({code:'55P03',message:'source_dirty_busy'})
   // A native writer must not commit through either the shared cleanup fence
   // or an exclusive writer fence, even when its tuple lock is obtainable.
   expect((await holder.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted")).rows[0].n).toBeGreaterThan(0)
   expect((await pool.query('SELECT revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[claim.root_key])).rows[0]).toEqual({revision:'1',claimed_revision:'1'})
   expect((await pool.query('SELECT id::text FROM public.events WHERE session_id=$1 ORDER BY id',[session])).rows.map(r=>r.id)).toEqual([String(id)])
   await holder.query('COMMIT');await insert(publisher,session,id+1)
   expect((await pool.query('SELECT revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[claim.root_key])).rows[0]).toEqual({revision:'2',claimed_revision:'1'})
   expect((await pool.query('SELECT id::text FROM public.events WHERE session_id=$1 ORDER BY id',[session])).rows.map(r=>r.id)).toEqual([String(id),String(id+1)])
  }finally{await holder.query('ROLLBACK');holder.release();publisher.release()}
 })
 test('a genuinely missing native root still refuses the creation mutex immediately and rolls back atomically',async()=>{
  const session='creation-mutex-missing',root='1:'+session,holder=await pool.connect()
  await pool.query("INSERT INTO public.sessions(session_id,user_id,source) VALUES($1,1,'codex')",[session]);expect((await pool.query('SELECT 1 FROM shared.memory_source_work WHERE root_key=$1',[root])).rowCount).toBe(0)
  try{
   await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-source-dirty:relay_event:'||$1,0))",[root]);const began=performance.now()
   await expect(insert(pool,session,7000)).rejects.toMatchObject({code:'55P03',message:'source_dirty_busy'});expect(performance.now()-began).toBeLessThan(250)
   expect((await pool.query('SELECT 1 FROM public.events WHERE id=7000')).rowCount).toBe(0);expect((await pool.query('SELECT 1 FROM shared.memory_source_work WHERE root_key=$1',[root])).rowCount).toBe(0)
   await holder.query('COMMIT');await insert(pool,session,7000);expect((await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].revision).toBe('1')
  }finally{await holder.query('ROLLBACK');holder.release()}
 })
 test('an uncommitted first creator keeps the missing-root barrier without an invisible-tuple wait',async()=>{
  const root='task25-uncommitted-first-creator',holder=await pool.connect(),contender=await pool.connect()
  try{
   await holder.query('BEGIN');expect((await holder.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)::text AS revision",[root])).rows[0].revision).toBe('1')
   expect((await pool.query('SELECT 1 FROM shared.memory_source_work WHERE root_key=$1',[root])).rowCount).toBe(0)
   const began=performance.now();await expect(contender.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)",[root])).rejects.toMatchObject({code:'55P03',message:'source_dirty_busy'});expect(performance.now()-began).toBeLessThan(250)
   await holder.query('COMMIT');expect((await contender.query("SELECT shared.mark_memory_source_dirty('relay_event',$1)::text AS revision",[root])).rows[0].revision).toBe('2')
  }finally{await holder.query('ROLLBACK');holder.release();contender.release()}
 })
 test('concurrent existing-root native publishers increment exactly once per committed event',async()=>{
  const session='concurrent-existing-dirty',claim=await prepare(session,9000),first=await pool.connect(),second=await pool.connect()
  let outcome:{error?:unknown}|undefined
  try{
   await first.query('BEGIN');await insert(first,session,9001)
   const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const pending=insert(second,session,9002).then(()=>{outcome={}},error=>{outcome={error}})
   let observed=false
   for(let n=0;n<200&&!outcome;n++){if((await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event==='PgSleep'){observed=true;break}}
   // The first native publisher, not a synthetic metadata-only locker, owns
   // BOTH locks. The second must wait on its tuple before attempting the fence.
   await first.query('COMMIT');await pending;expect(observed).toBe(true);expect(outcome?.error).toBeUndefined()
   expect((await pool.query('SELECT revision::text,claimed_revision::text FROM shared.memory_source_work WHERE root_key=$1',[claim.root_key])).rows[0]).toEqual({revision:'3',claimed_revision:'1'})
   expect((await pool.query('SELECT id::text FROM public.events WHERE session_id=$1 ORDER BY id',[session])).rows.map(r=>r.id)).toEqual(['9000','9001','9002'])
  }finally{await first.query('ROLLBACK');first.release();second.release()}
 })
 test('existing legacy custody roots retain their exclusive native writer fence',async()=>{
  const root='task25-legacy-custody',holder=await pool.connect()
  expect((await pool.query("SELECT shared.mark_memory_source_dirty('legacy_archive',$1)::text AS revision",[root])).rows[0].revision).toBe('1')
  try{
   await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-source-dirty:legacy_archive:'||$1,0))",[root])
   await expect(pool.query("SELECT shared.mark_memory_source_dirty('legacy_archive',$1)",[root])).rejects.toMatchObject({code:'55P03',message:'source_dirty_busy'})
   expect((await pool.query('SELECT revision::text FROM shared.memory_source_work WHERE root_key=$1',[root])).rows[0].revision).toBe('1')
   await holder.query('COMMIT');expect((await pool.query("SELECT shared.mark_memory_source_dirty('legacy_archive',$1)::text AS revision",[root])).rows[0].revision).toBe('2')
  }finally{await holder.query('ROLLBACK');holder.release()}
 })

})
