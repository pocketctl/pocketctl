import { createHash } from 'node:crypto'
import type { ArchiveStorage } from '../session-archive/storage.js'
import { archiveObjectKey, readArchiveObject } from '../session-archive/storage.js'
import type { ArchiveChunkManifest, ArchiveLimits } from '../session-archive/manifest.js'
import { decodeDocumentArchiveChunk } from './archive-codec.js'

interface Database { query<T=any>(sql:string,params?:any[]):Promise<{rows:T[]}> }
interface Reader { storage:ArchiveStorage; limits:ArchiveLimits }
const readers=new WeakMap<Database,Reader>()
export class DocumentBodyAccessError extends Error {}
export function installDocumentBodyReader(db:Database,storage:ArchiveStorage,limits:ArchiveLimits) { readers.set(db,{storage,limits}) }

/** No persistent document-body cache. Version and current ownership are
 * checked after external IO, including quota pruning and daemon transfer. */
export async function readDocumentBody(db:Database,input:{userId:number;sessionId:string;documentId:string;versionId:string},row:Record<string,any>):Promise<Buffer> {
  let bytes:Buffer
  if((row.body_storage??'hot')==='hot') {
    if(row.content_bytes==null) throw new Error('hot document body unavailable')
    bytes=Buffer.from(row.content_bytes)
  } else {
    const reader=readers.get(db)
    if(row.body_storage!=='cold'||!reader||!row.body_manifest_id||row.body_chunk_ordinal==null||row.body_activity_epoch==null) throw new Error('cold document reader unavailable')
    const authorize=async()=>{
      const current=await db.query(`SELECT 1 FROM session_document_versions v JOIN sessions s ON s.session_id=v.session_id AND s.user_id=v.user_id
        JOIN daemons d ON d.daemon_id=s.daemon_id AND d.user_id=s.user_id
        WHERE v.version_id=$4 AND v.document_id=$3 AND v.session_id=$2 AND v.user_id=$1 AND v.sha256=$5
          AND s.content_state NOT IN ('deleting','deleted') AND NOT EXISTS(SELECT 1 FROM deleted_sessions t WHERE t.session_id=s.session_id)`,
        [input.userId,input.sessionId,input.documentId,input.versionId,row.sha256])
      if(!current.rows[0]) throw new DocumentBodyAccessError('document no longer accessible')
    }
    await authorize()
    const m=(await db.query(`SELECT m.user_id,m.session_id,m.activity_epoch::text,m.manifest_id::text,m.schema_version,m.codec,m.state,m.storage_namespace,
      c.ordinal,c.object_key,c.first_event_id::text,c.last_event_id::text,c.event_count,c.raw_bytes::text,c.compressed_bytes::text,c.raw_sha256,c.compressed_sha256
      FROM session_archive_manifests m JOIN session_archive_chunks c USING(manifest_id)
      WHERE m.manifest_id=$1 AND m.user_id=$2 AND m.session_id=$3 AND c.ordinal=$4 AND m.state='published'`,
      [row.body_manifest_id,input.userId,input.sessionId,row.body_chunk_ordinal])).rows[0]
    if(!m || (reader.storage.namespace && m.storage_namespace!==reader.storage.namespace)
      || m.object_key!==archiveObjectKey(row.body_manifest_id,row.body_chunk_ordinal)) throw new Error('document archive manifest unavailable')
    const manifest:ArchiveChunkManifest={userId:m.user_id,sessionId:m.session_id,activityEpoch:m.activity_epoch,manifestId:m.manifest_id,ordinal:m.ordinal,
      schemaVersion:m.schema_version,codec:m.codec,firstEventId:m.first_event_id,lastEventId:m.last_event_id,eventCount:m.event_count,
      rawBytes:Number(m.raw_bytes),compressedBytes:Number(m.compressed_bytes),rawSha256:m.raw_sha256,compressedSha256:m.compressed_sha256}
    bytes=await decodeDocumentArchiveChunk(await readArchiveObject(reader.storage,m.object_key,reader.limits.maxCompressedBytes),manifest,
      {userId:input.userId,sessionId:input.sessionId,activityEpoch:String(row.body_activity_epoch),manifestId:row.body_manifest_id,ordinal:row.body_chunk_ordinal},
      {documentId:input.documentId,versionId:input.versionId,byteSize:Number(row.byte_size),sha256:row.sha256},reader.limits)
    await authorize()
  }
  if(bytes.length!==Number(row.byte_size)||createHash('sha256').update(bytes).digest('hex')!==row.sha256) throw new Error('document body integrity mismatch')
  return bytes
}
