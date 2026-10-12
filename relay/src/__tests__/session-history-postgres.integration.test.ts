import { randomUUID, createHash } from 'node:crypto'
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB, getSessionAllEvents, getLatestAgentPlan, getRecentSubagentEvents, getCompleteBackwardReplayPage, getCompleteForwardReplayPage, getTokenSummary, getTokensByDaemon, getTokenDailySeries, backfillSessionTokens, deleteSession } from '../db.js'
import { installPostgresHistoryBodyReader, withSessionHistoryScope } from '../session-history/postgres-reader.js'
import { PrivateObjectArchiveStorage } from '../session-archive/object-storage.js'
import { archiveObjectKey, type ArchiveStorage } from '../session-archive/storage.js'
import { encodeArchiveChunk } from '../session-archive/codec.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { getSnapshotEventPage } from '../extensions/snapshot-repository.js'
import { createSessionHistoryReadBroker } from '../session-history-read.js'
import { SessionDocumentRepository, SessionDocumentNotFoundError, SessionDocumentReadUnavailableError } from '../session-documents/repository.js'
import { installDocumentBodyReader } from '../session-documents/body-reader.js'
import { encodeDocumentArchiveChunk } from '../session-documents/archive-codec.js'
import { migrateTokenUsageAccounting } from '../token-usage/migration.js'
import { getTokenDashboardV2 } from '../token-usage/dashboard-v2.js'

const suite = process.env.RUN_SESSION_LIFECYCLE_POSTGRES === '1' && process.env.RUN_SESSION_LIFECYCLE_OBJECTS === '1' ? describe : describe.skip
suite('existing history consumers with real PostgreSQL and MinIO', () => {
  let pool: pg.Pool, storage: PrivateObjectArchiveStorage, s3: S3Client, userId: number, otherId: number
  const limits = { maxRawBytes:1_000_000,maxCompressedBytes:1_000_000,maxRecords:1000 }
  const objects = new Set<string>()
  let onRead: (()=>Promise<void>) | undefined, readCount = 0
  const adapter: ArchiveStorage = {
    get namespace() { return storage.namespace },
    put: (key,bytes)=>storage.put(key,bytes), delete:key=>storage.delete(key),
    read: async key=>{ readCount++; const body=await storage.read(key); await onRead?.(); return body },
  }
  const owned = <T>(work:()=>T) => withSessionHistoryScope({userId},work)
  beforeAll(async () => {
    pool = await lifecycleTestPool()
    const endpoint = process.env.TEST_SESSION_LIFECYCLE_OBJECT_ENDPOINT ?? ''
    const url = new URL(endpoint)
    if (url.hostname!=='127.0.0.1' || url.port!=='18690' || url.protocol!=='http:' || url.pathname!=='/' || url.search || url.hash || url.username || url.password
      || process.env.TEST_SESSION_LIFECYCLE_OBJECT_BUCKET!=='pocketctl-session-lifecycle-test') throw new Error('dedicated object fixture required')
    await initDB(pool)
    // Fixture-only DDL. Application migrations retain NOT NULL until every
    // consumer and executor publish gate is implemented and verified.
    await pool.query('ALTER TABLE events ALTER COLUMN payload DROP NOT NULL')
    await pool.query('ALTER TABLE session_document_versions ALTER COLUMN content_bytes DROP NOT NULL')
    const credentials={accessKeyId:'lifecycle-test',secretAccessKey:'lifecycle-test-only'}
    storage=new PrivateObjectArchiveStorage({endpoint,bucket:'pocketctl-session-lifecycle-test',region:'us-east-1',credentials,localTest:true,maxObjectBytes:1_000_000})
    s3=new S3Client({endpoint,region:'us-east-1',credentials,forcePathStyle:true})
    try { await s3.send(new CreateBucketCommand({Bucket:'pocketctl-session-lifecycle-test'})) }
    catch(error) { if(!(error instanceof Error)||!['BucketAlreadyExists','BucketAlreadyOwnedByYou'].includes(error.name)) throw error }
  },30_000)
  beforeEach(async()=>{
    await pool.query('TRUNCATE users,daemons,sessions,deleted_sessions RESTART IDENTITY CASCADE')
    await pool.query('TRUNCATE token_usage_accounting_state,token_daily_closures,token_daily_stats,token_session_daily_stats,token_usage_facts')
    const users=await pool.query("INSERT INTO users(email,password_hash) VALUES('cold@test.invalid','x'),('other@test.invalid','x') RETURNING id")
    userId=users.rows[0].id;otherId=users.rows[1].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('cold-host',$1)",[userId])
    await pool.query("INSERT INTO sessions(session_id,daemon_id,user_id,status,activity_epoch,activity_verified,last_activity_at) VALUES('cold-session','cold-host',$1,'idle',1,true,'2026-07-01')",[userId])
    onRead=undefined;readCount=0
    installPostgresHistoryBodyReader(pool,adapter,limits)
    installDocumentBodyReader(pool,adapter,limits)
  })
  afterEach(async()=>{for(const key of objects) await storage.delete(key);objects.clear()})
  afterAll(async()=>{
    if(pool){await pool.query('TRUNCATE users,daemons,sessions,deleted_sessions RESTART IDENTITY CASCADE');await pool.query('ALTER TABLE events ALTER COLUMN payload SET NOT NULL');await pool.query('ALTER TABLE session_document_versions ALTER COLUMN content_bytes SET NOT NULL');await pool.end()}
    storage?.close();s3?.destroy()
  })
  async function events() {
    const payloads=[
      {type:'user_text',text:'Exact hot/cold content'},
      {type:'agent_plan',revision:9,plan:[{step:'Cold latest revision',status:'completed'}]},
      {type:'agent_text',text:'Subagent cold content',agent_id:'child-agent',streaming:false,usage:{input_tokens:10,output_tokens:3,cache_read_tokens:2,cache_create_tokens:1}},
      {type:'agent_plan',revision:2,plan:[{step:'Newer event; older plan revision',status:'completed'}]},
      {type:'agent_text',text:'Mixed hot continuation',streaming:false},
    ]
    const rows=[]
    for(const payload of payloads) rows.push((await pool.query("INSERT INTO events(session_id,event_type,payload) VALUES('cold-session',$1,$2::jsonb) RETURNING id::text,event_type,payload",[payload.type,JSON.stringify(payload)])).rows[0])
    return rows
  }
  async function publish(rows:Record<string,any>[]) {
    const manifestId=randomUUID(),key=archiveObjectKey(manifestId,0)
    const encoded=await encodeArchiveChunk({userId,sessionId:'cold-session',activityEpoch:'1',manifestId,ordinal:0},rows.map(row=>({id:row.id,eventType:row.event_type,payload:row.payload})),limits)
    objects.add(key);await storage.put(key,encoded.bytes)
    const m=encoded.manifest
    await pool.query(`INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace)
      VALUES($1,$2,'cold-session',1,1,'gzip','published',$3,NOW(),$4)`,[manifestId,userId,m.lastEventId,storage.namespace])
    await pool.query(`INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
      VALUES($1,0,$2,$3,$4,$5,$6,$7,$8,$9)`,[manifestId,key,m.firstEventId,m.lastEventId,m.eventCount,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
    await pool.query(`UPDATE events SET body_storage='cold',payload=NULL,body_manifest_id=$1,body_chunk_ordinal=0,body_owner_user_id=$2,body_activity_epoch=1 WHERE id=ANY($3::bigint[])`,[manifestId,userId,rows.map(row=>row.id)])
    return key
  }
  async function coldDocument() {
    const documentId='doc-cold',versionId=randomUUID(),latestVersionId=randomUUID(),bytes=Buffer.from('<h1>Cold document</h1>\n😀'),sha256=createHash('sha256').update(bytes).digest('hex')
    const latestBytes=Buffer.from('<h1>Latest hot document</h1>'),latestSha=createHash('sha256').update(latestBytes).digest('hex')
    await pool.query(`INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at)
      VALUES($1,$2,'cold-session','report.html','html','turn-1','event-1','available',NOW())`,[documentId,userId])
    await pool.query(`INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes)
      VALUES($1,$2,'cold-session',$3,'turn-1','event-1',$4,$5,NOW()-INTERVAL '1 minute',$6),($7,$2,'cold-session',$3,'turn-2','event-2',$8,$9,NOW(),$10)`,
      [versionId,userId,documentId,bytes.length,sha256,bytes,latestVersionId,latestBytes.length,latestSha,latestBytes])
    await pool.query('UPDATE session_documents SET latest_version_id=$1 WHERE document_id=$2',[latestVersionId,documentId])
    const manifestId=randomUUID(),key=archiveObjectKey(manifestId,0)
    const encoded=await encodeDocumentArchiveChunk({userId,sessionId:'cold-session',activityEpoch:'1',manifestId,ordinal:0},{documentId,versionId,byteSize:bytes.length,sha256},bytes,limits)
    objects.add(key);await storage.put(key,encoded.bytes)
    const m=encoded.manifest
    await pool.query(`INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace)
      VALUES($1,$2,'cold-session',1,1,'gzip','published',0,NOW(),$3)`,[manifestId,userId,storage.namespace])
    await pool.query(`INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
      VALUES($1,0,$2,1,1,1,$3,$4,$5,$6)`,[manifestId,key,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
    await pool.query(`UPDATE session_document_versions SET content_bytes=NULL,body_storage='cold',body_manifest_id=$1,body_chunk_ordinal=0,body_activity_epoch=1 WHERE version_id=$2`,[manifestId,versionId])
    return {documentId,versionId,latestVersionId,bytes,sha256,latestBytes,key}
  }
  test('latest hot and historical cold documents retain bytes, digest, format and logical quota sizes',async()=>{
    const fixture=await coldDocument(),repository=new SessionDocumentRepository(pool,{uploadTimeoutMs:60_000})
    expect((await repository.listLatest(userId,'cold-session'))[0].latestVersionId).toBe(fixture.latestVersionId)
    expect((await repository.readCommittedContent(userId,'cold-session',fixture.documentId,fixture.versionId)).bytes).toEqual(fixture.bytes)
    expect((await repository.readCommittedContent(userId,'cold-session',fixture.documentId,fixture.latestVersionId)).bytes).toEqual(fixture.latestBytes)
    expect(Number((await pool.query('SELECT SUM(byte_size) AS bytes FROM session_document_versions')).rows[0].bytes)).toBe(fixture.bytes.length+fixture.latestBytes.length)
    await expect(repository.readCommittedContent(otherId,'cold-session',fixture.documentId,fixture.versionId)).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    await storage.delete(fixture.key)
    await expect(repository.readCommittedContent(userId,'cold-session',fixture.documentId,fixture.versionId)).rejects.toBeInstanceOf(SessionDocumentReadUnavailableError)
  })
  test('legacy totals and daily counters are unchanged by cold migration and repeated deletion',async()=>{
    const rows=await events();await backfillSessionTokens(pool)
    const summary=await getTokenSummary(pool,userId),host=await getTokensByDaemon(pool,userId,'cold-host')
    const daily=await getTokenDailySeries(pool,userId,null)
    expect(summary.total).toBe(16)
    await publish(rows.slice(0,3))
    expect(await getTokenSummary(pool,userId)).toEqual(summary)
    expect((await getTokensByDaemon(pool,userId,'cold-host'))?.total).toBe(host?.total)
    expect(await getTokenDailySeries(pool,userId,null)).toEqual(daily)
    await deleteSession(pool,'cold-session',{extensionMode:'off'})
    expect(await getTokenSummary(pool,userId)).toEqual(summary)
    expect((await getTokensByDaemon(pool,userId,'cold-host'))?.total).toBe(host?.total)
    expect(await getTokenDailySeries(pool,userId,null)).toEqual(daily)
    await deleteSession(pool,'cold-session',{extensionMode:'off'})
    expect(await getTokenSummary(pool,userId)).toEqual(summary)
    expect(await getTokenDailySeries(pool,userId,null)).toEqual(daily)
  })
  test('V2 baseline can adopt cold heads and keep immutable totals after attribution revocation',async()=>{
    const rows=await events();await publish(rows.slice(0,3))
    await migrateTokenUsageAccounting(pool)
    const before=await getTokenDashboardV2(pool,userId,null,30)
    expect(before.summary.total).toBe(16)
    await deleteSession(pool,'cold-session',{usageFactsAuthoritative:true,writeUsageFacts:true,extensionMode:'off'})
    const after=await getTokenDashboardV2(pool,userId,null,30)
    expect(after.summary).toEqual(before.summary)
    expect((await pool.query('SELECT session_attribution_revoked FROM token_usage_facts WHERE user_id=$1',[userId])).rows.every(row=>row.session_attribution_revoked)).toBe(true)
  })
  test('document quota pruning commits a durable object deletion with removal of the cold version',async()=>{
    const f=await coldDocument(),repository=new SessionDocumentRepository(pool,{uploadTimeoutMs:60_000,maxVersionsPerDocument:2})
    const versionId=randomUUID(),bytes=Buffer.from('<h1>Third version</h1>'),sha256=createHash('sha256').update(bytes).digest('hex')
    await repository.beginUpload({userId,sessionId:'cold-session',daemonId:'cold-host',daemonGeneration:1,documentId:f.documentId,versionId,displayName:'report.html',format:'html',sourceTurnId:'turn-3',sourceEventId:'event-3',totalBytes:bytes.length,sha256,chunkCount:1,capturedAt:new Date()})
    await repository.storeChunk({userId,sessionId:'cold-session',documentId:f.documentId,versionId,chunkIndex:0,byteOffset:0,bytes,sha256})
    expect((await repository.commitUpload({userId,sessionId:'cold-session',documentId:f.documentId,versionId,totalBytes:bytes.length,sha256})).status).toBe('committed')
    expect((await pool.query('SELECT state FROM session_archive_object_deletions WHERE object_key=$1 AND storage_namespace=$2',[f.key,storage.namespace])).rows[0]?.state).toBe('pending')
    await expect(repository.readCommittedContent(userId,'cold-session',f.documentId,f.versionId)).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    expect((await repository.readCommittedContent(userId,'cold-session',f.documentId,versionId)).bytes).toEqual(bytes)
  })
  test('document ownership changes or pruning during cold IO prevent bytes from escaping',async()=>{
    const f=await coldDocument(),repository=new SessionDocumentRepository(pool,{uploadTimeoutMs:60_000})
    onRead=async()=>{await pool.query('DELETE FROM session_document_versions WHERE version_id=$1',[f.versionId])}
    await expect(repository.readCommittedContent(userId,'cold-session',f.documentId,f.versionId)).rejects.toBeInstanceOf(SessionDocumentNotFoundError)
    expect((await pool.query('SELECT state FROM session_archive_object_deletions WHERE object_key=$1 AND storage_namespace=$2',[f.key,storage.namespace])).rows[0]?.state).toBe('pending')
  })
  test('hot, cold and mixed export, forward/backward replay, agent filter and plan revision are equivalent',async()=>{
    const original=await events()
    const hot=await owned(()=>getSessionAllEvents(pool,'cold-session'))
    await publish(original.slice(0,3))
    const mixed=await owned(()=>getSessionAllEvents(pool,'cold-session'))
    expect(mixed.map(row=>[row.id,row.payload])).toEqual(hot.map(row=>[row.id,row.payload]))
    expect(readCount).toBe(1)
    expect((await owned(()=>getLatestAgentPlan(pool,'cold-session'))).payload.revision).toBe(9)
    expect((await owned(()=>getRecentSubagentEvents(pool,'cold-session','child-agent',20))).map(row=>row.payload.text)).toEqual(['Subagent cold content'])
    expect((await owned(()=>getCompleteBackwardReplayPage(pool,'cold-session',undefined,50))).events.map(row=>row.payload)).toEqual(original.map(row=>row.payload))
    expect((await owned(()=>getCompleteForwardReplayPage(pool,'cold-session',0,50))).events.map(row=>row.payload)).toEqual(original.map(row=>row.payload))
  })
  test('cross-session history broker preserves transcript messages and protects its source authorization',async()=>{
    const rows=await events()
    const broker=createSessionHistoryReadBroker({pool,cursorSecret:'cold-fixture-cursor-secret'})
    const identity={userId,daemonId:'cold-host'},input={sourceSessionId:'cold-session',targetSessionId:'cold-session'}
    const hot=await broker.read(identity,input)
    await publish(rows.slice(0,3))
    expect(await broker.read(identity,input)).toEqual(hot)
    onRead=async()=>{await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='cold-host'",[otherId])}
    installPostgresHistoryBodyReader(pool,adapter,limits)
    await expect(broker.read(identity,input)).rejects.toThrow('not accessible')
  })
  test('scope and current daemon ownership are rechecked on cache hits; missing objects never return empty history',async()=>{
    const original=await events(),key=await publish(original.slice(0,3))
    await expect(withSessionHistoryScope({userId:otherId},()=>getSessionAllEvents(pool,'cold-session'))).rejects.toThrow('not accessible')
    expect(readCount).toBe(0)
    await owned(()=>getSessionAllEvents(pool,'cold-session'));expect(readCount).toBe(1)
    await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='cold-host'",[otherId])
    await expect(owned(()=>getSessionAllEvents(pool,'cold-session'))).rejects.toThrow('not accessible')
    await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='cold-host'",[userId])
    await storage.delete(key)
    await expect(owned(()=>getSessionAllEvents(pool,'cold-session'))).rejects.toThrow()
  })
  test('revocation while object IO is in flight prevents body return',async()=>{
    await publish((await events()).slice(0,3))
    onRead=async()=>{await pool.query("UPDATE daemons SET user_id=$1 WHERE daemon_id='cold-host'",[otherId])}
    await expect(owned(()=>getSessionAllEvents(pool,'cold-session'))).rejects.toThrow('not accessible')
  })
  test('database references reject cross-owner binding and incomplete cold locations',async()=>{
    const rows=await events();await publish(rows.slice(0,3))
    await expect(pool.query('UPDATE events SET body_owner_user_id=$1 WHERE id=$2',[otherId,rows[0].id])).rejects.toThrow()
    await expect(pool.query('UPDATE events SET body_chunk_ordinal=NULL WHERE id=$1',[rows[0].id])).rejects.toThrow()
    await expect(pool.query("UPDATE events SET body_storage='cold',payload=NULL WHERE id=$1",[rows[4].id])).rejects.toThrow()
    const header=(await pool.query('SELECT body_header FROM events WHERE id=$1',[rows[0].id])).rows[0].body_header
    expect(header.text).toBeUndefined()
    expect(header).not.toHaveProperty('usage')
  })
  test('Extension snapshot returns cold content and rejects an installation paused during IO',async()=>{
    const rows=await events();await publish(rows.slice(0,3));const id=randomUUID()
    await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('cold-test-provider',1,'{}') ON CONFLICT(provider_id) DO UPDATE SET status='enabled'")
    await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
      VALUES($1,'cold-test-provider',$2,'active',ARRAY['session:snapshot:read'],'{}','{}','{}','retained_history')`,[id,userId])
    const scope={installationId:id,providerId:'cold-test-provider',ownerUserId:userId,eventFilter:{}}
    expect((await getSnapshotEventPage(pool,scope,'cold-session',{afterEventId:0,limit:20})).map(row=>row.payload)).toEqual(rows.map(row=>row.payload))
    installPostgresHistoryBodyReader(pool,adapter,limits)
    onRead=async()=>{await pool.query("UPDATE extension_installations SET status='paused' WHERE installation_id=$1",[id])}
    await expect(getSnapshotEventPage(pool,scope,'cold-session',{afterEventId:0,limit:20})).rejects.toThrow('not accessible')
  })
})
