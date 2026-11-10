import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {performance} from 'node:perf_hooks'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {encodeArchiveChunk,archiveObjectKey,type SourceScope} from '@pocketctl/session-source'
import {createMemoryPool} from '../../db.js'
import {createObservedSourceReader} from '../../sources/observed-reader.js'
import {bindSourceConnectionAlias,bindSourcePool,sourcePoolContext} from '../../sources/pool-context.js'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'

const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
suite('factory-bound physical source SQL has finite native Memory lifetime',()=>{
 let f:DirectLaunchFixture,scope:SourceScope,root:{kind:'relay_event';key:string},event:string,s:{owner:number;session:string;daemon:string},readDefinition:string
 const pools:pg.Pool[]=[]
 const pool=(namespace:'public'|'memory'='memory',admin=false)=>{
  const runtimeUrl=new URL(url!);runtimeUrl.username='direct_launch_memory'
  const db=createMemoryPool({databaseUrl:admin?process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL!:runtimeUrl.href,databaseNamespace:namespace,dbPoolMax:1})
  pools.push(db);return db
 }
 const reader=(db:pg.Pool)=>createObservedSourceReader(db)
 const state=(db:pg.Pool)=>reader(db).checkCurrent(scope,root)
 const heads=(db:pg.Pool)=>reader(db).getHeads(scope,root,[event])
 const noBackend=async(pid:number)=>{
  for(let n=0;n<50;n++){
   if(!(await f.pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[pid])).rowCount)return
   await sleep(20)
  }
  throw Error('discarded_source_backend_survived')
 }
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);s=await f.source();const {inst}=await f.install(s,'retained_history');event=await f.event(s)
  scope={installationId:inst.installation_id,principalUserId:String(s.owner),ownerScopeKind:'personal',ownerScopeId:inst.installation_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
  root={kind:'relay_event',key:f.root(s)}
  readDefinition=(await f.pool.query("SELECT pg_get_functiondef('shared.read_memory_relay_sources(jsonb,text,bigint,integer,bigint[])'::regprocedure) AS definition")).rows[0].definition
 },60000)
 afterAll(async()=>{await Promise.all(pools.map(p=>p.end()));await f?.close()})

 test('slow controlled source function is canceled on PostgreSQL before returning and the slot stays healthy',async()=>{
  const db=pool();await db.query("SET statement_timeout='0';SET lock_timeout='0'")
  const pid=(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  await f.pool.query(readDefinition.replace(/BEGIN/i,'BEGIN PERFORM pg_sleep(6);'))
  const started=performance.now()
  try{
   await expect(heads(db)).rejects.toThrow('shared_source_unavailable:source_store_unavailable')
   expect(performance.now()-started).toBeLessThan(5800)
   expect((await f.pool.query("SELECT state,query FROM pg_stat_activity WHERE pid=$1 AND state='active'",[pid])).rows).toEqual([])
  }finally{await f.pool.query(readDefinition)}
  expect((await heads(db)).heads.map(h=>h.canonicalKey)).toEqual([event])
 },10000)

 test('server lock timeout bounds blocked source SQL independently of statement timeout',async()=>{
  const db=pool(),locker=await f.pool.connect();await locker.query('BEGIN;LOCK public.events IN ACCESS EXCLUSIVE MODE')
  const started=performance.now()
  try{await expect(heads(db)).rejects.toThrow('source_store_unavailable');expect(performance.now()-started).toBeLessThan(1800)}finally{await locker.query('ROLLBACK');locker.release()}
  expect((await heads(db)).heads).toHaveLength(1)
 },10000)

 test('saturated single-slot acquisition returns finitely and discards its late acquired client without SQL',async()=>{
  const db=pool(),held=await db.connect(),pid=(await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const started=performance.now(),pending=state(db).then(()=>null,e=>e)
  let error:unknown
  try{error=await Promise.race([pending,sleep(1800).then(()=>null)])}finally{held.release()}
  expect(error).toBeInstanceOf(Error);expect(performance.now()-started).toBeLessThan(1800)
  await noBackend(pid)
  expect((await state(db)).state).toBe('current')
 },5000)

 test.each(['BEGIN','SET LOCAL','read_memory_relay_sources','COMMIT','ROLLBACK'])('connected %s response stall destroys the physical socket and consumes late completion',async phase=>{
  const db=pool(),held=await db.connect(),pid=(await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const query=held.query.bind(held),sent:string[]=[]
  let finish!:(value?:unknown)=>void,fail!:(error:Error)=>void,entered!:()=>void,blocked=false
  const arrived=new Promise<void>(r=>{entered=r}),late=new Promise((resolve,reject)=>{finish=resolve;fail=reject})
  held.query=((sql:string,...args:any[])=>{
   sent.push(sql)
   if(phase==='ROLLBACK'&&sql.includes('read_memory_relay_sources'))return Promise.reject(Error('source_revoked'))
   const result=(query as any)(sql,...args)
   if(!blocked&&(sql.startsWith(phase)||sql.includes(phase))){blocked=true;entered();return Promise.resolve(result).then(()=>late)}
   return result
  }) as typeof held.query
  held.release()
  const started=performance.now(),pending=heads(db).then(()=>null,e=>e)
  await Promise.race([arrived,sleep(1000).then(()=>{throw Error('physical_source_phase_not_reached:'+phase)})])
  expect(await pending).toMatchObject({message:'shared_source_unavailable:'+(phase==='ROLLBACK'?'revoked':'source_store_unavailable')});expect(performance.now()-started).toBeLessThan(8700)
  expect((held as any).connection.stream.destroyed).toBe(true);await noBackend(pid)
  const sentAtTimeout=sent.length
  if(phase==='ROLLBACK')fail(Error('late_rollback_rejection'));else finish({rows:[]})
  await sleep(30);expect(sent).toHaveLength(sentAtTimeout)
  expect((await heads(db)).heads).toHaveLength(1)
 },11000)

 test('controlled reads run read-only and retain source error mapping',async()=>{
  const db=pool()
  await f.pool.query(readDefinition.replace(/BEGIN/i,"BEGIN IF current_setting('transaction_read_only') <> 'on' THEN RAISE EXCEPTION 'source_read_only_required';END IF;"))
  try{expect((await heads(db)).heads).toHaveLength(1)}finally{await f.pool.query(readDefinition)}
  expect((await db.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro).toBe('off')
  for(const reason of ['revoked','deleted','changed']){
   await f.pool.query(readDefinition.replace(/BEGIN/i,`BEGIN RAISE EXCEPTION 'source_${reason}';`))
   try{await expect(heads(db)).rejects.toThrow('shared_source_unavailable:'+reason)}finally{await f.pool.query(readDefinition)}
  }
 })

 test('inherited transaction client and its registered alias retain one backend and uncommitted state',async()=>{
  const db=pool('memory',true),client=await db.connect(),query=client.query.bind(client),sql:string[]=[]
  client.query=((text:string,...args:any[])=>{sql.push(text);return(query as any)(text,...args)}) as typeof client.query
  try{
   await client.query('BEGIN')
   const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const before=await state(client as unknown as pg.Pool)
   await client.query("UPDATE shared.memory_source_work SET revision=revision+9 WHERE source_kind='relay_event' AND root_key=$1",[root.key])
   const expected=(BigInt(before.version.content)+9n).toString()
   const alias={query:client.query.bind(client)};bindSourceConnectionAlias(alias,client)
   expect(sourcePoolContext(alias).namespace).toBe('memory')
   expect((await state(client as unknown as pg.Pool)).version.content).toBe(expected)
   expect((await state(alias as unknown as pg.Pool)).version.content).toBe(expected)
   expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid)
   expect(sql.filter(t=>t.startsWith('BEGIN'))).toEqual(['BEGIN'])
   expect(sql.some(t=>t.startsWith('SET LOCAL'))).toBe(false)
  }finally{await client.query('ROLLBACK');client.query=query;client.release()}
  expect((await state(db)).state).toBe('current')
 },5000)

 test('public factory and query-only compatibility readers do not acquire or nest a transaction',async()=>{
  const db=pool('public'),client=await db.connect(),query=client.query.bind(client),sql:string[]=[]
  client.query=((text:string,...args:any[])=>{sql.push(text);return(query as any)(text,...args)}) as typeof client.query
  try{
   await client.query('BEGIN');await state(client as unknown as pg.Pool)
   const only={query:client.query.bind(client)};bindSourcePool(only,{namespace:'memory'})
   expect((await state(only as unknown as pg.Pool)).state).toBe('current')
   expect(sql.filter(t=>t.startsWith('BEGIN'))).toEqual(['BEGIN'])
  }finally{await client.query('ROLLBACK');client.query=query;client.release()}
  const seen:string[]=[],acquire=(c:pg.PoolClient)=>{const q=c.query.bind(c);c.query=((text:string,...args:any[])=>{seen.push(text);return(q as any)(text,...args)}) as typeof c.query}
  db.once('acquire',acquire);expect((await state(db)).state).toBe('current');expect(seen.some(t=>/^(BEGIN|SET LOCAL)/.test(t))).toBe(false)
 })

 test('the only physical slot is released before real filesystem archive read and final current checks remain live',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bounded-source-archive-')),manifest=randomUUID(),key=archiveObjectKey(manifest,0),db=pool()
  const row=(await f.pool.query('SELECT payload FROM public.events WHERE id=$1',[event])).rows[0],epoch=(await f.pool.query('SELECT activity_epoch::text AS epoch FROM public.sessions WHERE session_id=$1',[s.session])).rows[0].epoch
  const encoded=await encodeArchiveChunk({userId:s.owner,sessionId:s.session,activityEpoch:epoch,manifestId:manifest,ordinal:0},[{id:event,eventType:'agent_text',payload:row.payload}],limits),m=encoded.manifest
  await mkdir(join(directory,'session-archive/v1',manifest),{recursive:true});await writeFile(join(directory,key),encoded.bytes)
  await f.pool.query("INSERT INTO public.session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),'bounds-test')",[manifest,s.owner,s.session,epoch,event])
  await f.pool.query('INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)',[manifest,key,event,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
  await f.pool.query("UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5",[s.session,manifest,s.owner,epoch,event])
  const storage=createSourceArchiveReader(directory,'bounds-test'),read=storage.read.bind(storage);let reads=0
  storage.read=async key=>{
   reads++;expect(db.idleCount).toBe(1)
   const c=await db.connect()
   try{expect((await c.query("SELECT current_setting('transaction_read_only') AS ro")).rows[0].ro).toBe('off')}finally{c.release()}
   return read(key)
  }
  try{
   const cold=createObservedSourceReader(db,{storage,limits}),page=await cold.getHeads(scope,root,[event]),bodies=await cold.resolveBodies(scope,root,page.heads,page.version)
   expect(bodies[0].payload).toEqual(row.payload);expect(reads).toBeGreaterThan(0)
   await f.pool.query("UPDATE shared.memory_source_work SET revision=revision+1 WHERE source_kind='relay_event' AND root_key=$1",[root.key])
   await expect(cold.resolveBodies(scope,root,page.heads,page.version)).rejects.toThrow('changed')
  }finally{await rm(directory,{recursive:true,force:true})}
 },10000)
})
