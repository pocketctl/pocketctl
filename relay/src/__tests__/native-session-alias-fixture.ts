import type pg from 'pg'
import {randomUUID,createHash} from 'node:crypto'
import {MemoryArchiveStorage,archiveObjectKey,encodeArchiveChunk} from '@pocketctl/session-source'
import {encodeDocumentArchiveChunk} from '../session-documents/archive-codec.js'
import {enableSessionColdBodies} from '../session-lifecycle/cold-schema.js'
export const aliasLimits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:32}
export const aliasStorage=()=>Object.assign(new MemoryArchiveStorage(),{namespace:'native-alias-fixture'})
export async function publishAliasBody(pool:pg.Pool,storage:ReturnType<typeof aliasStorage>,owner:number,sessionId:string,kind:'event'|'document'='event',payload:any={text:'unaltered original body',turn_id:'fixture-turn'}){
 await enableSessionColdBodies(pool)
 const manifestId=randomUUID(),epoch=String((await pool.query('SELECT activity_epoch::text AS e FROM sessions WHERE session_id=$1',[sessionId])).rows[0].e)
 const binding={userId:owner,sessionId,activityEpoch:epoch,manifestId,ordinal:0}
 let row:any,encoded:any,doc:any
 if(kind==='event'){
  row=(await pool.query("INSERT INTO events(session_id,event_type,payload,event_hash,effect_status,user_id) VALUES($1,'agent_text',$2,$3,'completed',$4) RETURNING id::text,event_type,payload",[sessionId,payload,randomUUID().replaceAll('-',''),owner])).rows[0]
  encoded=await encodeArchiveChunk(binding,[{id:row.id,eventType:row.event_type,payload:row.payload}],aliasLimits)
 }else{
  const documentId=randomUUID(),versionId=randomUUID(),bytes=Buffer.from('original document bytes'),sha256=createHash('sha256').update(bytes).digest('hex')
  await pool.query("INSERT INTO session_documents(document_id,user_id,session_id,display_name,document_format,last_source_turn_id,last_source_event_id,state,captured_at) VALUES($1,$2,$3,'fixture.md','markdown','turn','event','available',NOW())",[documentId,owner,sessionId])
  await pool.query("INSERT INTO session_document_versions(version_id,user_id,session_id,document_id,source_turn_id,source_event_id,byte_size,sha256,captured_at,content_bytes) VALUES($1,$2,$3,$4,'turn','event',$5,$6,NOW(),$7)",[versionId,owner,sessionId,documentId,bytes.length,sha256,bytes])
  await pool.query('UPDATE session_documents SET latest_version_id=$2 WHERE document_id=$1',[documentId,versionId])
  doc={documentId,versionId,bytes,sha256};encoded=await encodeDocumentArchiveChunk(binding,{documentId,versionId,byteSize:bytes.length,sha256},bytes,aliasLimits)
 }
 const key=archiveObjectKey(manifestId,0),m=encoded.manifest;await storage.put(key,encoded.bytes)
 await pool.query("INSERT INTO session_archive_manifests(manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace) VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),$6)",[manifestId,owner,sessionId,epoch,kind==='event'?row.id:0,storage.namespace])
 await pool.query('INSERT INTO session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256) VALUES($1,0,$2,$3,$4,1,$5,$6,$7,$8)',[manifestId,key,m.firstEventId,m.lastEventId,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
 if(kind==='event')await pool.query("UPDATE events SET body_storage='cold',payload=NULL,body_manifest_id=$1,body_chunk_ordinal=0,body_owner_user_id=$2,body_activity_epoch=$3 WHERE id=$4",[manifestId,owner,epoch,row.id])
 else await pool.query("UPDATE session_document_versions SET body_storage='cold',content_bytes=NULL,body_manifest_id=$1,body_chunk_ordinal=0,body_activity_epoch=$2 WHERE version_id=$3",[manifestId,epoch,doc.versionId])
 return {manifestId,key,bytes:Buffer.from(encoded.bytes),row,doc,manifest:m}
}
