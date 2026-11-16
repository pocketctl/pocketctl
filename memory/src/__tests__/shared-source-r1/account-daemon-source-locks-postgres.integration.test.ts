import type pg from 'pg'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {createPostgresSharedSourceReader,type SourceScope} from '@pocketctl/session-source'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'

const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL
const suite=url?describe:describe.skip
const lifecycleOperations=['delete account','delete daemon','rebind daemon','consolidate daemon'] as const

suite('Relay account and daemon lifecycle against Memory source commit',()=>{
 let fixture:DirectLaunchFixture
 let relay:{
  deleteUserAccount(pool:pg.Pool,owner:number):Promise<boolean>
  deleteDaemon(pool:pg.Pool,owner:number,daemon:string):Promise<boolean>
  bindDaemonToUser(db:Pick<pg.PoolClient,'query'>,daemon:string,owner:number):Promise<void>
  consolidateOfflineMachineDaemons(pool:pg.Pool,input:{userId:number;daemonId:string;machineId:string}):Promise<{mergedDaemonIds:string[]}>
 }
 beforeAll(async()=>{
  fixture=await directLaunchFixture(url!,{captureRelayControls:true})
  relay=await import(new URL('../../../../relay/dist/db.js',import.meta.url).href)
 },60000)
 afterAll(async()=>{await fixture?.close()})

 async function sourceFixture(operation:typeof lifecycleOperations[number]){
  const source=await fixture.source()
  const nextOwner=await fixture.source()
  const machineId='machine-'+'d'.repeat(32)
  const replacementDaemon=source.daemon+'-new'
  if(operation==='consolidate daemon'){
   await fixture.publisher.query("UPDATE public.daemons SET status='offline',machine_id=$2 WHERE daemon_id=$1",[source.daemon,machineId])
   await fixture.publisher.query("INSERT INTO public.daemons(daemon_id,user_id,hostname,status,machine_id) VALUES($1,$2,'synthetic','online',$3)",[replacementDaemon,source.owner,machineId])
  }
  const {inst}=await fixture.install(source,'retained_history')
  await fixture.event(source)
  const scope:SourceScope={installationId:inst.installation_id,principalUserId:String(source.owner),ownerScopeKind:'personal',
   ownerScopeId:inst.installation_id,authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
  const root={kind:'relay_event' as const,key:fixture.root(source)}
  const reader=createPostgresSharedSourceReader(fixture.runtime)
  const current=await reader.checkCurrent(scope,root)
  expect(current.state).toBe('current')
  const fence=async(client:pg.PoolClient)=>(await client.query<{locked:boolean}>(
   'SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,false) AS locked',
   [scope,root.kind,root.key,current.version],
  )).rows[0].locked
  return {source,nextOwner,machineId,replacementDaemon,fence,assertCommittedAuthority:async()=>{
   if(operation==='consolidate daemon'){
    expect((await fixture.publisher.query('SELECT daemon_id FROM public.sessions WHERE session_id=$1',[source.session])).rows)
     .toEqual([{daemon_id:replacementDaemon}])
    expect((await reader.checkCurrent(scope,root)).state).toBe('current')
   }else expect((await reader.checkCurrent(scope,root)).state).toMatch(/^(revoked|deleted)$/)
  }}
 }

 type SourceFixture=Awaited<ReturnType<typeof sourceFixture>>
 async function mutate(operation:typeof lifecycleOperations[number],data:SourceFixture,client:pg.PoolClient, beforeCommit?:()=>Promise<void>){
  if(operation==='rebind daemon'){
   await client.query('BEGIN')
   try{
    await relay.bindDaemonToUser(client,data.source.daemon,data.nextOwner.owner)
    await beforeCommit?.()
    await client.query('COMMIT')
   }catch(error){await client.query('ROLLBACK');throw error}
   return
  }
  // The production deletion helper still owns its transaction. Pause only
  // after its last real statement, while PostgreSQL holds the write locks.
  const connection={
   query:async(sql:string,params?:unknown[])=>{
    if(sql==='COMMIT')await beforeCommit?.()
    return client.query(sql,params)
   },
   release:()=>{},
  }
  const pool={connect:async()=>connection} as unknown as pg.Pool
  if(operation==='consolidate daemon'){
   expect(await relay.consolidateOfflineMachineDaemons(pool,{
    userId:data.source.owner,daemonId:data.replacementDaemon,machineId:data.machineId,
   })).toEqual({mergedDaemonIds:[data.source.daemon]})
   return
  }
  const deleted=operation==='delete account'
   ?await relay.deleteUserAccount(pool,data.source.owner)
   :await relay.deleteDaemon(pool,data.source.owner,data.source.daemon)
  expect(deleted).toBe(true)
 }

 test.each(lifecycleOperations)('%s waits for a winning Memory commit and then commits its authority change',async operation=>{
  const data=await sourceFixture(operation),memory=await fixture.runtime.connect(),writer=await fixture.publisher.connect()
  let mutation:Promise<PromiseSettledResult<void>>|undefined
  try{
   const memoryPid=(await memory.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   const writerPid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   await memory.query('BEGIN')
   expect(await data.fence(memory)).toBe(true)
   mutation=mutate(operation,data,writer).then(value=>({status:'fulfilled',value}),reason=>({status:'rejected',reason}))
   await vi.waitFor(async()=>{
    const {rows}=await fixture.pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[memoryPid,writerPid])
    expect(rows[0].blocked).toBe(true)
   },{timeout:2500})
   await memory.query('COMMIT')
   expect(await mutation).toMatchObject({status:'fulfilled'})
   await data.assertCommittedAuthority()
  }finally{
   await memory.query('ROLLBACK')
   await mutation
   memory.release();writer.release()
  }
 },12000)

 test.each(lifecycleOperations)('%s holding its write locks makes Memory fail closed before commit',async operation=>{
  const data=await sourceFixture(operation),memory=await fixture.runtime.connect(),writer=await fixture.publisher.connect()
  let paused!:()=>void,unblock!:()=>void
  const ready=new Promise<void>(resolve=>{paused=resolve})
  const proceed=new Promise<void>(resolve=>{unblock=resolve})
  const mutation=mutate(operation,data,writer,async()=>{paused();await proceed})
   .then(value=>({status:'fulfilled' as const,value}),reason=>({status:'rejected' as const,reason}))
  try{
   await Promise.race([ready,mutation.then(result=>{throw result.status==='rejected'?result.reason:new Error('writer missed commit barrier')})])
   await memory.query("BEGIN; SET LOCAL statement_timeout='500ms'; SET LOCAL lock_timeout='250ms'")
   expect(await data.fence(memory)).toBe(false)
   await memory.query('ROLLBACK')
   unblock()
   expect(await mutation).toMatchObject({status:'fulfilled'})
   await data.assertCommittedAuthority()
  }finally{
   unblock()
   await memory.query('ROLLBACK')
   await mutation
   memory.release();writer.release()
  }
 },12000)
})
