import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { lockSessionMaterializationFence,deleteSessionInTransaction } from '../db.js'
import { AttentionNotificationRepository } from '../attention-inbox/notification-repository.js'
import { archiveObjectKey,readArchiveObject,type ArchiveStorage } from '../session-archive/storage.js'
import { encodeArchiveChunk,decodeArchiveChunk } from '../session-archive/codec.js'
import { encodeDocumentArchiveChunk,decodeDocumentArchiveChunk } from '../session-documents/archive-codec.js'
import type { ArchiveChunkManifest,ArchiveEventBody } from '../session-archive/manifest.js'
import { inspectLifecycleEligibility,type LifecycleEligibility } from './eligibility.js'
import { LifecycleJobRepository,type LifecycleJob } from './repository.js'
import type { SessionLifecycleConfig } from './types.js'
import { sessionLifecycleReadiness } from './readiness.js'

class Superseded extends Error {}
interface StagedChunk {manifest:ArchiveChunkManifest;events?:ArchiveEventBody[];document?:Record<string,any>}

/** External transfer runs without session/SQL locks. Every authoritative
 * mutation rechecks the lease, epoch, dependency closure and current owner. */
export class SessionLifecycleExecutor {
  readonly jobs:LifecycleJobRepository
  private readonly notifications:AttentionNotificationRepository
  private readonly leaseMs=300000
  constructor(private readonly pool:pg.Pool,private readonly config:SessionLifecycleConfig,private readonly storage:ArchiveStorage,secret:string,private readonly onError?:(error:unknown)=>void){
    if(!storage.namespace)throw new Error('archive provider namespace required')
    this.jobs=new LifecycleJobRepository(pool)
    this.notifications=new AttentionNotificationRepository(pool,secret)
  }
  private async transaction<T>(work:(db:pg.PoolClient)=>Promise<T>):Promise<T>{
    const db=await this.pool.connect()
    try{await db.query('BEGIN');await db.query("SET LOCAL lock_timeout='2s'");const value=await work(db);await db.query('COMMIT');return value}
    catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
  }
  private async fenced(db:pg.PoolClient,lease:LifecycleJob,expected?:LifecycleEligibility):Promise<LifecycleEligibility>{
    const preliminary=expected??await inspectLifecycleEligibility(db,lease.sessionId,this.config)
    await db.query('SELECT pg_advisory_xact_lock($1)',[lease.userId])
    await db.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE',[lease.userId])
    await db.query('SELECT daemon_id FROM daemons WHERE daemon_id=ANY($1::varchar[]) ORDER BY daemon_id FOR SHARE',[preliminary.members.map(row=>row.daemon_id)])
    for(const id of preliminary.sessionIds)await lockSessionMaterializationFence(db,id)
    await db.query('SELECT session_id FROM sessions WHERE session_id=ANY($1::varchar[]) ORDER BY session_id FOR UPDATE',[preliminary.sessionIds])
    const valid=(await db.query(`SELECT 1 FROM session_lifecycle_jobs WHERE operation_id=$1 AND state='running'
      AND lease_token=$2 AND attempt=$3 AND lease_owner=$4 AND lease_until>NOW() FOR UPDATE`,[lease.operationId,lease.leaseToken,lease.attempt,lease.leaseOwner])).rows[0]
    if(!valid)throw new Superseded()
    const marker=(await db.query('SELECT cooling_operation_id FROM sessions WHERE session_id=$1',[lease.sessionId])).rows[0]?.cooling_operation_id
    const current=await inspectLifecycleEligibility(db,lease.sessionId,this.config,{ownCoolingEpochs:marker===lease.operationId?new Map([[lease.sessionId,lease.activityEpoch]]):undefined})
    if(!current.root||current.root.user_id!==lease.userId||current.root.epoch!==lease.activityEpoch
      ||JSON.stringify(current.sessionIds)!==JSON.stringify(preliminary.sessionIds)
      ||(expected&&current.members.some(row=>expected.members.find(old=>old.session_id===row.session_id)?.epoch!==row.epoch)))throw new Superseded()
    if(current.prediction.blockedReasons.length)throw new Superseded()
    const action=current.prediction.action
    if(action!==lease.action&&!(lease.action==='archive'&&action==='cool'&&current.root.archive_reason==='inactivity'))throw new Superseded()
    if((await db.query('SELECT 1 FROM daemons WHERE daemon_id=$1 AND user_id=$2',[current.root.daemon_id,lease.userId])).rows.length!==1)throw new Superseded()
    return current
  }
  private async record(db:pg.PoolClient,lease:LifecycleJob,snapshot:LifecycleEligibility,state:'running'|'succeeded'|'partial'|'failed'|'cancelled',reason:string,stages:Record<string,'pending'|'succeeded'|'failed'|'not_applicable'>,notificationId=randomUUID()){
    const root=snapshot.root!
    await this.notifications.recordResultInTransaction(db,{operationId:lease.operationId,notificationId,userId:lease.userId,
      sessionId:lease.sessionId,daemonId:root.daemon_id,titleSnapshot:root.title??'',daemonNameSnapshot:root.daemon_name??root.daemon_id,
      action:lease.action,state,activityAt:snapshot.prediction.activityAt!,effectivePurgeAt:snapshot.prediction.purgeAt,
      reasonCode:reason,retentionDays:this.config.notificationRetentionDays,stages})
  }
  async execute(lease:LifecycleJob,deleteOptions:NonNullable<Parameters<typeof deleteSessionInTransaction>[2]>={}):Promise<'succeeded'|'partial'|'cancelled'>{
    const readiness = sessionLifecycleReadiness(this.config, this.storage)
    if (!readiness.execution_ready) throw new Error(`lifecycle execution blocked: ${readiness.blockers.join(',')}`)
    if(lease.action==='purge')return this.purge(lease,deleteOptions)
    if(!['archive','cool'].includes(lease.action))throw new Error('unsupported archive executor action')
    let snapshot:LifecycleEligibility|undefined,manifestId:string|undefined,archived=false
    try{
      snapshot=await this.transaction(async db=>{
        const current=await this.fenced(db,lease)
        if(lease.action==='archive'){
          await db.query(`UPDATE sessions SET archived_at=COALESCE(archived_at,NOW()),archive_reason=COALESCE(archive_reason,'inactivity'),
            organization_revision=organization_revision+1,updated_at=NOW() WHERE session_id=$1`,[lease.sessionId])
          archived=true
          await this.record(db,lease,current,'running','inactivity_60_days',{archive:'succeeded',cool:'pending'})
        }
        await db.query("UPDATE sessions SET content_state='cooling',cooling_operation_id=$2 WHERE session_id=$1",[lease.sessionId,lease.operationId])
        return current
      })
      manifestId=randomUUID()
      await this.pool.query(`INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,storage_namespace,operation_id,upload_deadline)
        SELECT $1::uuid,$2::int,$3::varchar,$4::bigint,1,'gzip','uploading',COALESCE(max(id),0),$5::text,$6::uuid,NOW()+interval '10 minutes' FROM events WHERE session_id=$3::varchar`,
        [manifestId,lease.userId,lease.sessionId,lease.activityEpoch,this.storage.namespace,lease.operationId])
      const limits={maxRawBytes:this.config.maxChunkBytes,maxCompressedBytes:this.config.maxCompressedBytes,maxRecords:1000},chunks:StagedChunk[]=[]
      let bytesTransferred=0,after='0',ordinal=0,budgetReached=false,publishedPartial=false
      const deadline=Date.now()+this.config.runBudgetMs
      const check=async()=>{
        if(!await this.jobs.renew(lease,this.leaseMs))throw new Superseded()
        if(!(await this.pool.query(`SELECT 1 FROM sessions s JOIN daemons d USING(daemon_id) WHERE s.session_id=$1 AND s.user_id=$2
          AND d.user_id=$2 AND s.activity_epoch=$3 AND s.content_state='cooling'`,[lease.sessionId,lease.userId,lease.activityEpoch])).rows[0])throw new Superseded()
      }
      const upload=async(encoded:{bytes:Buffer;manifest:ArchiveChunkManifest},data:Omit<StagedChunk,'manifest'>)=>{
        const m=encoded.manifest,key=archiveObjectKey(m.manifestId,m.ordinal)
        if(chunks.length&&(bytesTransferred+m.rawBytes>this.config.batchBytes||Date.now()>=deadline)){budgetReached=true;return}
        if(m.rawBytes>this.config.batchBytes)throw new Error('chunk exceeds transfer budget')
        await check()
        // Journal the key before upload: an interrupted/account-deleted transfer
        // remains collectable, including a crash immediately after PUT.
        await this.pool.query(`INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[m.manifestId,m.ordinal,key,m.firstEventId,m.lastEventId,m.eventCount,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
        await this.storage.put(key,encoded.bytes)
        const read=await readArchiveObject(this.storage,key,limits.maxCompressedBytes)
        if(data.document){const d=data.document;await decodeDocumentArchiveChunk(read,m,m,{documentId:d.document_id,versionId:d.version_id,byteSize:Number(d.byte_size),sha256:d.sha256},limits)}
        else await decodeArchiveChunk(read,m,m,limits)
        bytesTransferred+=m.rawBytes;await check()
        chunks.push({manifest:m,...data})
      }
      for(;!budgetReached;){
        const page=(await this.pool.query(`SELECT id::text,event_type,payload FROM events WHERE session_id=$1 AND body_storage='hot' AND id>$2 ORDER BY events.id LIMIT 100`,[lease.sessionId,after])).rows
        if(!page.length)break
        let records:ArchiveEventBody[]=[],size=2048
        const flush=async()=>{if(records.length&&!budgetReached){await upload(await encodeArchiveChunk({userId:lease.userId,sessionId:lease.sessionId,activityEpoch:lease.activityEpoch,manifestId:manifestId!,ordinal:ordinal++},records,limits),{events:records});records=[];size=2048}}
        for(const row of page){
          const record={id:row.id,eventType:row.event_type,payload:row.payload},length=Buffer.byteLength(JSON.stringify(record))+1
          if(size+length>limits.maxRawBytes)await flush()
          if(budgetReached)break
          records.push(record);size+=length
        }
        await flush();after=page.at(-1)!.id
      }
      let documentAfter=''
      for(;!budgetReached;){
        const page=(await this.pool.query(`SELECT * FROM session_document_versions WHERE session_id=$1 AND body_storage='hot' AND version_id>$2 ORDER BY version_id LIMIT 1`,[lease.sessionId,documentAfter])).rows
        if(!page.length)break
        const d=page[0]
        await upload(await encodeDocumentArchiveChunk({userId:lease.userId,sessionId:lease.sessionId,activityEpoch:lease.activityEpoch,manifestId,ordinal:ordinal++},
          {documentId:d.document_id,versionId:d.version_id,byteSize:Number(d.byte_size),sha256:d.sha256},d.content_bytes,limits),{document:d})
        documentAfter=d.version_id
      }
      await this.transaction(async db=>{
        const current=await this.fenced(db,lease,snapshot)
        await db.query("UPDATE session_archive_manifests SET state='published',published_at=NOW(),upload_deadline=NULL WHERE manifest_id=$1 AND state='uploading'",[manifestId])
        for(const chunk of chunks){
          const m=chunk.manifest
          if(chunk.events){
            // Check every exported logical body and all projected selector/usage
            // fields before removing any payload. Oversized/unsupported header
            // shapes fail closed and leave the entire hot transaction intact.
            const rows=chunk.events.map(e=>({id:e.id,type:e.eventType,payload:e.payload}))
            const moved=await db.query(`UPDATE events e SET body_storage='cold',payload=NULL,body_manifest_id=$1,body_chunk_ordinal=$2,body_owner_user_id=$3,body_activity_epoch=$4
              FROM jsonb_to_recordset($5::jsonb) r(id bigint,type text,payload jsonb)
              WHERE e.id=r.id AND e.session_id=$6 AND e.event_type=r.type AND e.payload=r.payload AND e.body_storage='hot'
                AND NOT EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(e.payload)='object' THEN e.payload ELSE '{}' END) p
                  WHERE p.key=ANY(ARRAY['agent','agent_id','event_id','message_id','part_id','revision','streaming','model','effort','turn_id','usage'])
                    AND p.value IS DISTINCT FROM session_event_body_header(e.payload)->p.key)
              RETURNING e.id`,[manifestId,m.ordinal,lease.userId,lease.activityEpoch,JSON.stringify(rows),lease.sessionId])
            if(moved.rowCount!==rows.length)throw new Error('body changed or header projection incomplete')
          }else if(chunk.document){
            const d=chunk.document
            const moved=await db.query(`UPDATE session_document_versions SET body_storage='cold',content_bytes=NULL,body_manifest_id=$1,body_chunk_ordinal=$2,body_activity_epoch=$3
              WHERE version_id=$4 AND user_id=$5 AND session_id=$6 AND body_storage='hot' AND content_bytes=$7 RETURNING version_id`,
              [manifestId,m.ordinal,lease.activityEpoch,d.version_id,lease.userId,lease.sessionId,d.content_bytes])
            if(moved.rowCount!==1)throw new Error('document version changed')
          }
        }
        const hot=(await db.query(`SELECT EXISTS(SELECT 1 FROM events WHERE session_id=$1 AND body_storage='hot') OR EXISTS(SELECT 1 FROM session_document_versions WHERE session_id=$1 AND body_storage='hot') AS remaining`,[lease.sessionId])).rows[0].remaining
        if(hot&&!budgetReached)throw new Superseded()
        publishedPartial=hot
        await db.query("UPDATE sessions SET content_state=$2,cooling_operation_id=NULL,updated_at=NOW() WHERE session_id=$1",[lease.sessionId,hot?'mixed':'cold'])
        await this.record(db,lease,current,hot?'partial':'succeeded',hot?'transfer_budget_reached':'inactivity_60_days',{archive:archived?'succeeded':'not_applicable',cool:hot?'pending':'succeeded'})
        if(!await new LifecycleJobRepository(db).finish(lease,hot?'partial':'succeeded',{reason:hot?'transfer_budget_reached':'inactivity_60_days',chunks:chunks.length,bytes:bytesTransferred}))throw new Superseded()
      })
      return publishedPartial?'partial':'succeeded'
    }catch(error){
      this.onError?.(error)
      const cancelled=error instanceof Superseded,state=cancelled?'cancelled':'partial'
      await this.transaction(async db=>{
        await lockSessionMaterializationFence(db,lease.sessionId)
        const valid=(await db.query(`SELECT 1 FROM session_lifecycle_jobs WHERE operation_id=$1 AND lease_token=$2 AND attempt=$3 AND state='running' AND lease_until>NOW() FOR UPDATE`,[lease.operationId,lease.leaseToken,lease.attempt])).rows[0]
        if(!valid)return
        await db.query(`UPDATE sessions s SET content_state=CASE WHEN EXISTS(SELECT 1 FROM events e WHERE e.session_id=s.session_id AND body_storage='cold')
          OR EXISTS(SELECT 1 FROM session_document_versions v WHERE v.session_id=s.session_id AND body_storage='cold') THEN 'mixed' ELSE 'hot' END,cooling_operation_id=NULL
          WHERE cooling_operation_id=$1 AND content_state='cooling'`,[lease.operationId])
        if(snapshot&&!cancelled)await this.record(db,lease,snapshot,state,'cold_transfer_failed',{archive:archived?'succeeded':'not_applicable',cool:'failed'})
        await new LifecycleJobRepository(db).finish(lease,state,{reason:cancelled?'superseded':'cold_transfer_failed'})
      })
      // Deferred collector, rather than synchronous remote deletion, is the
      // durable failure path. Published references are never removed here.
      if(manifestId)await this.pool.query("DELETE FROM session_archive_manifests WHERE manifest_id=$1 AND state='uploading'",[manifestId])
      return state
    }
  }
  private async purge(lease:LifecycleJob,options:NonNullable<Parameters<typeof deleteSessionInTransaction>[2]>):Promise<'partial'|'cancelled'>{
    try{
      await this.transaction(async db=>{
        const current=await this.fenced(db,lease),notificationId=randomUUID(),operations:LifecycleJob[]=[]
        // One component transaction: removing a parent cannot strand children
        // behind an unknown-ancestor guard. Adopt only unclaimed sibling jobs.
        for(const member of current.members){
          const operation=member.session_id===lease.sessionId?lease:await new LifecycleJobRepository(db).enqueue({userId:lease.userId,
            sessionId:member.session_id,action:'purge',activityEpoch:member.epoch,policyVersion:lease.policyVersion})
          if(operation.operationId!==lease.operationId&&operation.state==='running')throw new Superseded()
          operations.push(operation)
        }
        for(let index=0;index<current.members.length;index++){
          const member=current.members[index],operation=operations[index]
          await deleteSessionInTransaction(db,member.session_id,options)
          await db.query('UPDATE session_lifecycle_deletions SET operation_id=$2 WHERE session_id=$1',[member.session_id,operation.operationId])
          const stages={database:'succeeded',objects:'pending',memory:'pending'} as const
          await this.record(db,operation,{...current,root:member},'partial','inactivity_90_days',stages,notificationId)
          if(operation.operationId===lease.operationId){
            if(!await new LifecycleJobRepository(db).finish(lease,'partial',{reason:'external_cleanup_pending'},86400000))throw new Superseded()
          }else await db.query(`UPDATE session_lifecycle_jobs SET state='partial',result='{"reason":"external_cleanup_pending"}',
            next_attempt_at=NOW()+interval '1 day',lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=NOW() WHERE operation_id=$1`,[operation.operationId])
        }
      })
      return 'partial'
    }catch(error){
      this.onError?.(error)
      const state=error instanceof Superseded?'cancelled':'partial'
      await this.jobs.finish(lease,state,{reason:state==='cancelled'?'superseded':'database_purge_failed'})
      return state
    }
  }
}
