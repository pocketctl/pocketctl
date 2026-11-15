import {createHash,randomUUID} from 'node:crypto'
import {archiveObjectKey,canonicalPayloadHash,encodeArchiveChunk,MemoryArchiveStorage} from '@pocketctl/session-source'
import {bindSourcePool} from '../../sources/pool-context.js'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {projectHistoricalPersonalPage} from '../../sources/canonical-references.js'

const url=process.env.HISTORICAL_PROJECTION_TEST_DATABASE_URL

describe.skipIf(!url)('historical personal projection on PostgreSQL 13',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{
  f=await directLaunchFixture(url!)
  await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
 },60000)
 afterAll(async()=>{await f?.close()})

 test('uses the sealed roster without reopening a window, and refuses permission drift',async()=>{
  const source=await f.source()
  const installationId=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installationId])
  const ids=[await f.event(source,false,{status:'historical-status'}),await f.event(source,true)]
  await f.pool.query(`INSERT INTO memory.source_sessions
   (installation_id,session_id,status,first_recorded_at,last_recorded_at)
   VALUES($1,$2,'current-status',now()-interval '1 day',now()+interval '1 day')`,[installationId,source.session])
  const rootKey=f.root(source)
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'history-test-scheduler',signal:new AbortController().signal})
  let seal
  for(let i=0;i<15&&!seal;i++){
   await scheduler.runOnce()
   seal=(await f.pool.query(`SELECT scan_id::text AS "scanId", work_revision::text AS "workRevision"
    FROM shared.memory_source_distributions WHERE root_key=$1 AND state='sealed' AND dispatch_complete`,[rootKey])).rows[0]
  }
  expect(seal).toBeDefined()
  const root={installationId,rootKey,...seal}
  const expired=await f.pool.query(`INSERT INTO shared.memory_source_processing_windows
   (owner_user_id,session_id,activity_epoch,business_activity_at,started_at,hard_deadline)
   SELECT user_id,session_id,activity_epoch,last_business_activity_at,now()-interval '1 hour',now()-interval '58 minutes'
   FROM public.sessions WHERE session_id=$1`,[source.session])
  expect(expired.rowCount).toBe(1)
  const job=(await f.pool.query(`UPDATE memory.memory_jobs SET state='dead',attempts=12,completed_at=now(),last_error_code='source_not_ready',
   payload=jsonb_set(payload,'{source_wait_count}','3'::jsonb)
   WHERE job_type='project_shared_source' AND installation_id=$1 RETURNING job_id,payload`,[installationId])).rows[0]
  const deadHash=createHash('sha256').update(JSON.stringify(job.payload)).digest()
  await f.pool.query(`INSERT INTO memory.memory_dead_letters(job_id,installation_id,job_type,attempts,error_code,payload_hash)
   VALUES($1,$2,'project_shared_source',12,'source_not_ready',$3)`,[job.job_id,installationId,deadHash])
  const jobs=async()=> (await f.pool.query("SELECT to_jsonb(j) AS job FROM memory.memory_jobs j WHERE installation_id=$1 ORDER BY job_id",[installationId])).rows
  const custody=async()=> (await f.pool.query(`SELECT (SELECT to_jsonb(s) FROM public.sessions s WHERE s.session_id=$1) AS session,
   (SELECT jsonb_agg(to_jsonb(w)) FROM shared.memory_source_processing_windows w WHERE w.session_id=$1) AS windows`,[source.session])).rows[0]
  const before={jobs:await jobs(),custody:await custody()}
  await expect(projectHistoricalPersonalPage(f.runtime,root)).rejects.toThrow('historical_projection_admin_pg13_required')
  const admin=await f.pool.connect()
  try{
   await admin.query("SET ROLE direct_launch_definer; SET search_path=pg_catalog,memory,shared")
   const maintenance={connect:async()=>Object.assign(Object.create(admin),{query:admin.query.bind(admin),release:()=>{}})} as typeof f.pool
   await f.pool.query(`UPDATE memory.memory_jobs SET payload=payload||'{"reference_repair_paged":true}' WHERE job_id=$1`,[job.job_id])
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow('historical_projection_seal_changed')
   await f.pool.query(`UPDATE memory.memory_jobs SET payload=jsonb_set(payload- 'reference_repair_paged','{source_wait_count}','"3"'::jsonb) WHERE job_id=$1`,[job.job_id])
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow('historical_projection_seal_changed')
   await f.pool.query('UPDATE memory.memory_jobs SET payload=$2 WHERE job_id=$1',[job.job_id,job.payload])
   await f.pool.query('UPDATE memory.memory_dead_letters SET payload_hash=$2 WHERE job_id=$1',[job.job_id,Buffer.alloc(32)])
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow('historical_projection_dead_receipt_changed')
   await f.pool.query('UPDATE memory.memory_dead_letters SET payload_hash=$2 WHERE job_id=$1',[job.job_id,deadHash])
   const dry=await projectHistoricalPersonalPage(maintenance,root,{pageSize:1,dryRun:true})
   expect(dry).toMatchObject({state:'scanning',count:1,created:1})
   expect((await f.runtime.query('SELECT canonical_key FROM source_events WHERE installation_id=$1',[installationId])).rows).toEqual([])
   expect(await projectHistoricalPersonalPage(maintenance,root,{pageSize:1})).toMatchObject({state:'scanning',count:1,created:1})
   expect(await projectHistoricalPersonalPage(maintenance,root,{pageSize:1})).toMatchObject({state:'scanning',count:1,created:1})
   expect((await f.pool.query('SELECT processed_revision::text AS n FROM shared.memory_source_progress WHERE installation_id=$1 AND root_key=$2',[installationId,rootKey])).rows[0].n).not.toBe(root.workRevision)
   const emptyTail=await projectHistoricalPersonalPage(maintenance,root,{pageSize:1})
   expect(emptyTail).toMatchObject({state:'ready',count:0,created:0,revision:root.workRevision})
   expect((await projectHistoricalPersonalPage(maintenance,root)).state).toBe('already')
   const refs=(await f.runtime.query(`SELECT canonical_key,payload,source_provenance,encode(content_hash,'hex') AS hash
    FROM source_events WHERE installation_id=$1 ORDER BY canonical_key::bigint`,[installationId])).rows
   expect(refs.map(r=>r.canonical_key)).toEqual(ids)
   expect(refs.every(r=>r.payload===null&&r.source_provenance.state==='known'&&/^[a-f0-9]{64}$/.test(r.hash))).toBe(true)
   expect((await f.runtime.query('SELECT status FROM source_sessions WHERE installation_id=$1 AND session_id=$2',[installationId,source.session])).rows[0].status).toBe('current-status')
   expect(await jobs()).toEqual(before.jobs)
   expect((await f.pool.query('SELECT payload_hash FROM memory.memory_dead_letters WHERE job_id=$1',[job.job_id])).rows[0].payload_hash).toEqual(deadHash)
   expect(await custody()).toEqual(before.custody)
   const beforeRevoke=await jobs()
   const grantLock=await f.pool.connect()
   try {
    await grantLock.query('BEGIN')
    await grantLock.query('SELECT installation_id FROM public.extension_installations WHERE installation_id=$1 FOR UPDATE',[installationId])
    await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow('shared_source_unavailable:changed')
    await grantLock.query('ROLLBACK')
   } finally {grantLock.release()}
   await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[installationId])
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow()
   expect(await jobs()).toEqual(beforeRevoke)
  }finally{
   await admin.query('RESET ROLE; RESET search_path')
   admin.release()
  }
 },30000)
 test.each(['feed','request','headerless-feed'])('reuses the exact original UUID using %s evidence',async proof=>{
  const source=await f.source()
  const installationId=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installationId])
  const eventId=proof!=='request'?await f.event(source):(await f.pool.query(`INSERT INTO public.events
   (session_id,user_id,event_type,payload,event_hash,effect_status) VALUES($1,$2,'agent_text',$3,$4,'completed') RETURNING id::text`,
   [source.session,source.owner,{request_id:'literal-request',text:'retained test record'},
    createHash('md5').update(source.session+':agent_text:request:literal-request').digest('hex').slice(0,16)])).rows[0].id
  const row=(await f.pool.query('SELECT payload,created_at::text AS at,source_classification FROM public.events WHERE id=$1',[eventId])).rows[0]
  if(proof==='headerless-feed')await f.pool.query('UPDATE public.events SET source_header_version=NULL,source_classification=NULL,source_sequence=NULL,canonical_payload_hash=NULL WHERE id=$1',[eventId])
  const uuid=randomUUID(),position='1001',type='agent_text',turn=row.payload.turn_id??null
  const header={envelope_version:1,feed_id:position,topic:'session.event.v1',
   source:{kind:'canonical_event',id:'event:'+eventId,recorded_at:new Date(row.at).toISOString()},
   subject:{session_id:source.session,turn_id:turn,event_type:type},classification:row.source_classification,data:row.payload}
  await f.pool.query(`INSERT INTO memory.source_events
   (source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,source_provenance)
   VALUES($1,$2,'feed',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[uuid,installationId,position,source.session,turn,type,
   row.at,row.source_classification??{},row.payload,canonicalPayloadHash(row.payload),
   row.source_classification?.memory_source?{memory:row.source_classification.memory_source}:{}])
  if(proof==='request')await f.pool.query(`INSERT INTO memory.source_events
   (source_event_id,installation_id,origin,origin_position,session_id,event_type,occurred_at,classification,payload,payload_hash)
   VALUES($1,$2,'feed','1002',$3,'agent_text',$4::timestamptz+interval '1 second','{}',$5,$6)`,
   [randomUUID(),installationId,source.session,row.at,{request_id:'literal-request',text:'distinct retained observation'},
   canonicalPayloadHash({request_id:'literal-request',text:'distinct retained observation'})])
  if(proof!=='request')await f.pool.query(`INSERT INTO memory.memory_feed_inbox
   (installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,payload_hash,projection_state,data,classification)
   VALUES($1,$2,1,'session.event.v1','canonical_event',$3,$4,$5,$6,$7,$8,'projected',$9,$10)`,
   [installationId,position,'event:'+eventId,source.session,turn,type,row.at,canonicalPayloadHash(header),row.payload,row.source_classification])
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'history-bind-test',signal:new AbortController().signal})
  const rootKey=f.root(source)
  let seal
  for(let i=0;i<15&&!seal;i++){
   await scheduler.runOnce()
   seal=(await f.pool.query(`SELECT scan_id::text AS "scanId",work_revision::text AS "workRevision"
    FROM shared.memory_source_distributions WHERE root_key=$1 AND state='sealed' AND dispatch_complete`,[rootKey])).rows[0]
  }
  expect(seal).toBeDefined()
  const admin=await f.pool.connect()
  try{
   await admin.query("SET ROLE direct_launch_definer; SET search_path=pg_catalog,memory,shared")
   const maintenance={connect:async()=>Object.assign(Object.create(admin),{query:admin.query.bind(admin),release:()=>{}})} as typeof f.pool
   const readOriginal=async()=> (await f.pool.query(`SELECT source_event_id,payload,payload_hash,source_provenance,canonical_key,mapping_state
    FROM memory.source_events WHERE installation_id=$1 AND source_event_id=$2`,[installationId,uuid])).rows
   const before=await readOriginal()
   if(proof==='request'){
    const duplicate=randomUUID()
    await f.pool.query(`INSERT INTO memory.source_events(installation_id,source_event_id,origin,origin_position,session_id,
     turn_id,event_type,occurred_at,classification,payload,payload_hash,source_provenance)
     SELECT installation_id,$2,origin,'1003',session_id,turn_id,event_type,occurred_at,classification,payload,payload_hash,source_provenance
     FROM memory.source_events WHERE source_event_id=$1`,[uuid,duplicate])
    await expect(projectHistoricalPersonalPage(maintenance,{installationId,rootKey,...seal})).rejects.toThrow('historical_projection_original_ambiguous')
    expect(await readOriginal()).toEqual(before)
    await f.pool.query('DELETE FROM memory.source_events WHERE source_event_id=$1',[duplicate])
   }
   expect(await projectHistoricalPersonalPage(maintenance,{installationId,rootKey,...seal})).toMatchObject({state:'ready',count:1,created:0,rebound:1})
   expect(await readOriginal()).toEqual([{...before[0],canonical_key:eventId,mapping_state:'verified'}])
  }finally{
   await admin.query('RESET ROLE; RESET search_path')
   admin.release()
  }
 },30000)

 test('requires archive bytes and the same archive manifest at commit',async()=>{
  const source=await f.source()
  const installationId=(await f.install(source,'retained_history')).inst.installation_id
  await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[installationId])
  const id=await f.event(source),manifestId=randomUUID(),rootKey=f.root(source)
  const payload=(await f.pool.query('SELECT payload FROM public.events WHERE id=$1',[id])).rows[0].payload
  const epoch=(await f.pool.query('SELECT activity_epoch::text AS epoch FROM public.sessions WHERE session_id=$1',[source.session])).rows[0].epoch
  const limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100}
  const encoded=await encodeArchiveChunk({userId:source.owner,sessionId:source.session,activityEpoch:epoch,manifestId,ordinal:0},[{id,eventType:'agent_text',payload}],limits)
  const key=archiveObjectKey(manifestId,0),m=encoded.manifest,storage=new MemoryArchiveStorage()
  await storage.put(key,encoded.bytes)
  await f.pool.query(`INSERT INTO public.session_archive_manifests
   (manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace)
   VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),'history-cold-test')`,[manifestId,source.owner,source.session,epoch,id])
  await f.pool.query(`INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
   VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)`,[manifestId,key,id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
  await f.pool.query(`UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,
   body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5`,[source.session,manifestId,source.owner,epoch,id])
  const scheduler=createSharedSourceScheduler({pool:f.runtime,workerId:'history-cold-test',signal:new AbortController().signal})
  let seal
  for(let i=0;i<15&&!seal;i++){
   await scheduler.runOnce()
   seal=(await f.pool.query(`SELECT scan_id::text AS "scanId",work_revision::text AS "workRevision"
    FROM shared.memory_source_distributions WHERE root_key=$1 AND state='sealed' AND dispatch_complete`,[rootKey])).rows[0]
  }
  expect(seal).toBeDefined()
  const admin=await f.pool.connect()
  try{
   await admin.query("SET ROLE direct_launch_definer; SET search_path=pg_catalog,memory,shared")
   const maintenance={connect:async()=>Object.assign(Object.create(admin),{query:admin.query.bind(admin),release:()=>{}})} as typeof f.pool
   const root={installationId,rootKey,...seal}
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow('archive_unconfigured')
   let changeManifest=true
   bindSourcePool(maintenance,{namespace:'memory',archive:{limits,storage:{namespace:'history-cold-test',async read(objectKey){
    if(changeManifest){
     changeManifest=false
     await f.pool.query("UPDATE public.session_archive_chunks SET compressed_sha256=repeat('f',64) WHERE manifest_id=$1",[manifestId])
    }
    return storage.read(objectKey)
   }}}})
   await expect(projectHistoricalPersonalPage(maintenance,root)).rejects.toThrow()
   expect((await f.runtime.query('SELECT canonical_key FROM source_events WHERE installation_id=$1',[installationId])).rows).toEqual([])
   await f.pool.query('UPDATE public.session_archive_chunks SET compressed_sha256=$2 WHERE manifest_id=$1',[manifestId,m.compressedSha256])
   expect(await projectHistoricalPersonalPage(maintenance,root)).toMatchObject({state:'ready',count:1,created:1})
  }finally{
   await admin.query('RESET ROLE; RESET search_path')
   admin.release()
  }
 },30000)

})
