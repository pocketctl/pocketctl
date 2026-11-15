import {createHash} from 'node:crypto'
import {lstat,readFile,writeFile} from 'node:fs/promises'
import {request} from 'node:http'
import {setTimeout as sleep} from 'node:timers/promises'
import pg from 'pg'
import {assertArchiveObjectKey,canonicalPayloadHash,SourceUnavailableError,type ArchiveReadStorage} from '@pocketctl/session-source'
import {projectHistoricalPersonalPage} from '../../sources/canonical-references.js'
import {bindSourcePool} from '../../sources/pool-context.js'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import type {HistoricalProjectionRoot} from '../../sources/historical-projection-authority.js'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digits=/^[1-9][0-9]{0,18}$/
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"'
const maxBatch=16
const retryable=new Set(['canonical_reference_busy','canonical_reference_cursor_changed','55P03'])

function archiveSocketReader(socketPath:string,namespace:string):ArchiveReadStorage {
 return {namespace, read(key){
  assertArchiveObjectKey(key)
  return new Promise((resolve,reject)=>{
   const req=request({socketPath,path:'/'+key,timeout:10000},response=>{
    if(response.statusCode===200){resolve(response);return}
    response.resume();reject(Error('historical_projection_archive_socket_failed'))
   })
   req.once('timeout',()=>req.destroy(Error('historical_projection_archive_socket_timeout')))
   req.once('error',reject)
   req.end()
  })
 }}
}

interface DatabaseIdentity {
 database:string
 oid:string
 cluster:string
 major:number
 schema:number
 owner:string
}

interface Plan {
 version:1
 database:DatabaseIdentity
 installationId:string
 roots:HistoricalProjectionRoot[]
 digest:string
}

async function identity(pool:pg.Pool){
 const actual=(await pool.query<DatabaseIdentity>(`SELECT current_database() AS database,
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
  (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
  current_setting('server_version_num')::int/10000 AS major,
  (SELECT max(version) FROM memory.memory_schema_migrations) AS schema,rolname::text AS owner
  FROM pg_roles r JOIN pg_namespace n ON n.nspowner=r.oid
  WHERE n.nspname='shared' AND NOT r.rolcanlogin AND NOT r.rolsuper
   AND session_user='postgres' AND inet_server_addr() IS NULL
   AND current_setting('fsync')='on' AND current_setting('session_replication_role')='origin'`)).rows[0]
 if(actual?.major!==13||actual.schema!==103)throw Error('historical_projection_database_contract')
 return actual
}

async function makePlan(pool:Pick<pg.Pool,'query'>,database:DatabaseIdentity,installationId:string):Promise<Plan>{
 const roots=(await pool.query<HistoricalProjectionRoot>(`
  SELECT p.installation_id::text AS "installationId",p.root_key AS "rootKey",
   d.scan_id::text AS "scanId",d.work_revision::text AS "workRevision"
  FROM shared.memory_source_progress p
  JOIN shared.memory_source_work w USING(source_kind,root_key)
  JOIN shared.memory_source_distributions d USING(source_kind,root_key)
  JOIN shared.memory_source_modes m ON m.installation_id=p.installation_id
  JOIN public.extension_installations i ON i.installation_id=p.installation_id
  JOIN public.sessions s ON s.user_id=i.owner_user_id AND p.root_key=i.owner_user_id::text||':'||s.session_id
  JOIN shared.memory_source_distribution_targets t ON t.scan_id=d.scan_id AND t.installation_id=p.installation_id
  WHERE p.installation_id=$1 AND p.source_kind='relay_event' AND p.processed_revision<p.dispatched_revision
   AND p.dispatched_revision=w.revision AND w.processed_revision=w.revision AND d.work_revision=w.revision
   AND p.mode_generation=m.generation AND m.mode='shared-active' AND d.state='sealed' AND d.dispatch_complete
   AND d.control_revision=shared.memory_source_control_snapshot()::bigint AND t.state='current' AND t.target_mode=m.mode
   AND i.owner_scope_kind='personal' AND i.status='active' AND i.provider_id='pocketctl-memory'
   AND s.source IS DISTINCT FROM 'app_review_demo' AND s.session_id NOT LIKE 'pending-%' AND s.session_id NOT LIKE 'app-review-demo-%'
   AND s.content_state NOT IN('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM public.deleted_sessions x WHERE x.session_id=s.session_id)
  ORDER BY p.root_key COLLATE "C" LIMIT 2049`,[installationId])).rows
 if(roots.length>2048||roots.length!==new Set(roots.map(root=>root.rootKey)).size)throw Error('historical_projection_roster_limit')
 const plan={version:1 as const,database,installationId,roots}
 return {...plan,digest:hash(plan)}
}

async function readPlan(file:string,database:DatabaseIdentity,installationId:string):Promise<Plan>{
 const stat=await lstat(file)
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>1024*1024)throw Error('historical_projection_private_plan_required')
 const plan=JSON.parse(await readFile(file,'utf8')) as Plan
 const {digest,...input}=plan
 if(plan.version!==1||digest!==hash(input)||hash(plan.database)!==hash(database)||plan.installationId!==installationId
  ||!Array.isArray(plan.roots)||plan.roots.length>2048||plan.roots.some(r=>r.installationId!==installationId
   ||typeof r.rootKey!=='string'||r.rootKey.length>1024||!uuid.test(r.scanId)||!digits.test(r.workRevision))
  ||new Set(plan.roots.map(r=>r.rootKey)).size!==plan.roots.length)throw Error('historical_projection_plan_changed')
 return plan
}

function errorCode(error:unknown){
 if(error instanceof SourceUnavailableError)return 'source:'+error.code
 const e=error as {message?:string;code?:string}
 if(e.code&&e.code!=='P0001'&&/^[A-Z0-9]{5}$/.test(e.code))return e.code
 return e.message&&/^(?:historical_projection_|canonical_reference_|source_)[a-z_]+$/.test(e.message)?e.message:'historical_projection_failed'
}

async function main(){
 const [operation,installationId,file,start,count,pageBudget]=process.argv.slice(2)
 if(operation==='--help'){
  console.log('historical-projection-cli plan INSTALLATION PRIVATE_PLAN')
  console.log('historical-projection-cli dry-run|apply INSTALLATION PRIVATE_PLAN OFFSET_OR_INDICES BATCH_SIZE PAGE_BUDGET')
  console.log('Run on local PG13 via postgres peer with PGDATABASE and the exact HISTORICAL_PROJECTION_PLAN_HASH. Batch size is 1..16. Select a contiguous range with an offset or pass comma-separated indices.')
  return
 }
 if(!['plan','apply','dry-run'].includes(operation)||!uuid.test(installationId??'')||!file||!process.env.PGDATABASE)
  throw Error('historical_projection_arguments')
 const pool=new pg.Pool({host:'/run/postgresql',user:'postgres',database:process.env.PGDATABASE,max:1,
  application_name:'pocketctl-historical-projection',connectionTimeoutMillis:5000,
  options:"-c search_path=pg_catalog,memory,shared -c statement_timeout=7000 -c lock_timeout=400 -c jit=off -c pocketctl.writer_capability=identity_v2 -c pocketctl.writer_identity_generation=adaptive"})
 try{
  const actual=await identity(pool)
  if(operation==='plan'){
   const client=await pool.connect()
   try{
    await client.query('BEGIN READ ONLY')
    const plan=await makePlan(client,actual,installationId)
    await writeFile(file,JSON.stringify(plan)+'\n',{flag:'wx',mode:0o600})
    console.log(JSON.stringify({operation,total:plan.roots.length,plan:plan.digest,pg:actual.major,schema:actual.schema}))
   }finally{await client.query('ROLLBACK');client.release()}
   return
  }
  const size=Number(count),pages=Number(pageBudget)
  const offset=Number(start)
  const indices=start?.includes(',')?start.split(',').map(Number):
   Number.isInteger(size)&&size>=1&&size<=maxBatch?Array.from({length:size},(_,n)=>offset+n):[]
  if(!Number.isInteger(size)||size!==indices.length||size<1||size>maxBatch
   ||indices.some(index=>!Number.isSafeInteger(index)||index<0)||new Set(indices).size!==indices.length
   ||!Number.isInteger(pages)||pages<1||pages>256||!process.env.HISTORICAL_PROJECTION_PLAN_HASH)
   throw Error('historical_projection_batch_bounds')
  const plan=await readPlan(file,actual,installationId)
  if(plan.digest!==process.env.HISTORICAL_PROJECTION_PLAN_HASH||indices.some(index=>index>=plan.roots.length))throw Error('historical_projection_plan_changed')
  const archiveDir=process.env.MEMORY_SHARED_ARCHIVE_DIRECTORY,archiveNamespace=process.env.MEMORY_SHARED_ARCHIVE_NAMESPACE
  const archiveSocket=process.env.HISTORICAL_PROJECTION_ARCHIVE_SOCKET
  if(Boolean(archiveDir||archiveSocket)!==Boolean(archiveNamespace)||archiveDir&&archiveSocket)throw Error('historical_projection_archive_config')
  const db=await pool.connect()
  try{
   await db.query('SET ROLE '+quote(actual.owner))
   // The surrounding process retains only this socket. SET ROLE must not be
   // lost via a transparent pool reconnect, including during an apply retry.
   const dbPool={connect:async()=>({query:db.query.bind(db),release(){}})} as unknown as pg.Pool
   const archiveSource=archiveNamespace&&(archiveSocket||archiveDir)?{
    storage:archiveSocket?archiveSocketReader(archiveSocket,archiveNamespace):createSourceArchiveReader(archiveDir!,archiveNamespace),
    limits:{maxRawBytes:32*1024*1024,maxCompressedBytes:16*1024*1024,maxRecords:10000},
   }:undefined
   bindSourcePool(dbPool,{namespace:'memory',archive:archiveSource})
   for(const index of indices){
    const root=plan.roots[index]
    const rootHash=createHash('sha256').update(root.rootKey).digest('hex')
    let state='scanning',seen=0,created=0,rebound=0,completedPages=0
    const digests:string[]=[]
    try{
     for(let page=0;page<pages&&state==='scanning';page++){
      const project=()=>projectHistoricalPersonalPage(dbPool,root,{dryRun:operation==='dry-run'})
      const result=await project().catch(async error=>{
       if(operation!=='apply'||!retryable.has(errorCode(error)))throw error
       await sleep(150)
       return project()
      })
      state=result.state
      seen+=result.count
      created+=result.created
      rebound+=result.rebound
      completedPages++
      if(result.sourceDigest)digests.push(result.sourceDigest)
      if(operation==='dry-run')break
     }
     console.log(JSON.stringify({operation,index,rootHash,state,seen,created,rebound,completedPages,revision:root.workRevision,digest:hash(digests)}))
    }catch(error){
     console.log(JSON.stringify({operation,index,rootHash,state:'refused',error:errorCode(error),seen,created,rebound,completedPages,revision:root.workRevision,digest:hash(digests)}))
    }
   }
  }finally{db.release()}
 }finally{await pool.end()}
}
try{await main()}catch(error){console.error(errorCode(error));process.exitCode=2}
