import { createHash } from 'node:crypto'
import { encodeArchiveChunk, decodeArchiveChunk } from '../session-archive/codec.js'
import type { ArchiveBinding, ArchiveChunkManifest, ArchiveLimits } from '../session-archive/manifest.js'

export interface DocumentBodyIdentity {
  documentId: string
  versionId: string
  byteSize: number
  sha256: string
}
function validateDocument(bytes: Buffer, expected: DocumentBodyIdentity) {
  if (!expected.documentId || expected.documentId.length>128 || !expected.versionId || expected.versionId.length>128
    || !Number.isSafeInteger(expected.byteSize) || expected.byteSize<0 || bytes.length!==expected.byteSize
    || !/^[a-f0-9]{64}$/.test(expected.sha256) || createHash('sha256').update(bytes).digest('hex')!==expected.sha256) throw new Error('document archive integrity mismatch')
}
export async function encodeDocumentArchiveChunk(binding: ArchiveBinding, identity: DocumentBodyIdentity, bytes: Buffer, limits: ArchiveLimits) {
  if(Math.ceil(bytes.length/3)*4>limits.maxRawBytes) throw new Error('document archive byte limit exceeded')
  validateDocument(bytes,identity)
  // One independent, version-bound record. Numeric record 1 is local to this
  // document chunk; it never becomes a canonical events table ID.
  return encodeArchiveChunk(binding,[{id:'1',eventType:'document_body_v1',payload:{...identity,contentBase64:bytes.toString('base64')}}],limits)
}
export async function decodeDocumentArchiveChunk(bytes: Buffer, manifest: ArchiveChunkManifest, binding: ArchiveBinding, identity: DocumentBodyIdentity, limits: ArchiveLimits): Promise<Buffer> {
  const records=await decodeArchiveChunk(bytes,manifest,binding,limits)
  if(records.length!==1||records[0].id!=='1'||records[0].eventType!=='document_body_v1') throw new Error('document archive record mismatch')
  const payload=records[0].payload as Record<string,unknown> | null
  if(!payload || typeof payload!=='object' || payload.documentId!==identity.documentId || payload.versionId!==identity.versionId
    || payload.byteSize!==identity.byteSize || payload.sha256!==identity.sha256 || typeof payload.contentBase64!=='string') throw new Error('document archive binding mismatch')
  const content=Buffer.from(payload.contentBase64,'base64')
  if(content.toString('base64')!==payload.contentBase64) throw new Error('document archive encoding mismatch')
  validateDocument(content,identity)
  return content
}
