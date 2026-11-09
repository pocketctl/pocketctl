import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import {canonicalJsonString} from '@pocketctl/session-source'
import type { Snapshot } from './database.js'
// The same pure package ships in both services. Maintenance no longer reaches
// across a checkout into Relay TypeScript or depends on a second app tree.
export async function relayPureModule(relative:string):Promise<any> {
  if(!['codec','delivery'].includes(relative))throw new Error('invalid_relay_pure_module')
  return import('@pocketctl/session-source')
}
export interface ArchiveOptions {directory:string;namespace:string}
export class ArchiveVerifier {
  private cacheKey=''
  private records:Map<string,{eventType:string;payload:unknown}>=new Map()
  constructor(private snapshot:Snapshot,private options?:ArchiveOptions){}
  private async authorize(head:Record<string,any>):Promise<unknown>{
    if(!head.native_identity_contract)return null
    if(head.owner_retired!==false&&head.owner_retired!=='false')throw Error('archive_original_owner_retired_or_unknown')
    if(!this.snapshot.currentNativeSessionAuthority)throw Error('native_current_authority_unavailable')
    const native=await this.snapshot.currentNativeSessionAuthority(head.session_id,Number(head.user_id),String(head.id))
    if(native.state!=='current'||native.sessionId!==head.current_session_id)throw Error('archive_current_authority_denied')
    return native
  }
  async body(head:Record<string,any>):Promise<unknown> {
    if(!this.options)throw new Error('archive_unconfigured')
    const native=await this.authorize(head)
    const bodySession=head.native_identity_contract?head.body_session_id:head.session_id
    if(typeof bodySession!=='string'||!bodySession)throw new Error('archive_binding_invalid')
    const {body_manifest_id:manifestId,body_chunk_ordinal:ordinal,body_activity_epoch:epoch,body_owner_user_id:owner}=head
    if(typeof manifestId!=='string' || !/^[a-f0-9-]{36}$/.test(manifestId) || !Number.isSafeInteger(Number(ordinal)) || Number(ordinal)<0
      || typeof epoch!=='string' || !/^[0-9]+$/.test(epoch) || String(owner)!==String(head.user_id))throw new Error('archive_binding_invalid')
    const rows=(await this.snapshot.client.query(`SELECT m.user_id,m.session_id,m.activity_epoch::text,m.manifest_id::text,m.schema_version,m.codec,m.state,m.storage_namespace,
      c.ordinal,c.object_key,c.first_event_id::text,c.last_event_id::text,c.event_count,c.raw_bytes::text,c.compressed_bytes::text,c.raw_sha256,c.compressed_sha256
      FROM public.session_archive_manifests m JOIN public.session_archive_chunks c USING(manifest_id)
      WHERE m.manifest_id=$1 AND c.ordinal=$2`,[manifestId,ordinal])).rows
    const m=rows[0]
    if(rows.length!==1 || m.state!=='published' || m.storage_namespace!==this.options.namespace || String(m.user_id)!==String(owner)
      || m.session_id!==bodySession || m.activity_epoch!==epoch || m.object_key!==`session-archive/v1/${manifestId.toLowerCase()}/${ordinal}.gz`)
      throw new Error('archive_binding_invalid')
    const key=JSON.stringify([head.user_id,head.session_id,head.current_session_id,bodySession,native,manifestId,ordinal,epoch,m.storage_namespace,m.raw_sha256,m.compressed_sha256])
    if(this.cacheKey!==key){
      this.records.clear();this.cacheKey=''
      const base=await realpath(resolve(this.options.directory)),file=resolve(base,m.object_key)
      if((await lstat(resolve(this.options.directory))).isSymbolicLink() || !file.startsWith(base+sep))throw new Error('archive_path_invalid')
      let component=base
      for(const part of m.object_key.split('/').slice(0,-1)){
        component=resolve(component,part)
        if((await lstat(component)).isSymbolicLink())throw new Error('archive_path_invalid')
      }
      const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
      let bytes:Buffer
      try{
        const s=await f.stat()
        if(!s.isFile() || s.size>16*1024*1024)throw new Error('archive_size_limit')
        bytes=await f.readFile()
        if(bytes.length>16*1024*1024)throw new Error('archive_size_limit')
      }finally{await f.close()}
      const binding={userId:Number(owner),sessionId:bodySession,activityEpoch:epoch,manifestId,ordinal:Number(ordinal)}
      const manifest={...binding,schemaVersion:m.schema_version,codec:m.codec,firstEventId:m.first_event_id,lastEventId:m.last_event_id,eventCount:m.event_count,
        rawBytes:Number(m.raw_bytes),compressedBytes:Number(m.compressed_bytes),rawSha256:m.raw_sha256,compressedSha256:m.compressed_sha256}
      const {decodeArchiveChunk}=await relayPureModule('codec')
      const records=await decodeArchiveChunk(bytes,manifest,binding,{maxRawBytes:32*1024*1024,maxCompressedBytes:16*1024*1024,maxRecords:10000})
      this.records=new Map(records.map((r:any)=>[r.id,{eventType:r.eventType,payload:r.payload}]))
      this.cacheKey=key
    }
    if(canonicalJsonString(await this.authorize(head))!==canonicalJsonString(native))throw new Error('archive_current_authority_changed')
    const record=this.records.get(head.id)
    if(!record || record.eventType!==head.event_type)throw new Error('archive_event_mismatch')
    return record.payload
  }
}
