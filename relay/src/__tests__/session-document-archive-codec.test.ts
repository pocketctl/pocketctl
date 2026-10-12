import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { encodeDocumentArchiveChunk, decodeDocumentArchiveChunk } from '../session-documents/archive-codec.js'
const binding={userId:1,sessionId:'session',activityEpoch:'1',manifestId:randomUUID(),ordinal:0}
const limits={maxRawBytes:1_000_000,maxCompressedBytes:1_000_000,maxRecords:1000}
describe('version-bound document archive codec',()=>{
  test.each(['# 冷文档\n正文 😀','<h1>HTML</h1><script>alert(1)</script>',''])('preserves exact bytes without changing rendering policy',async text=>{
    const bytes=Buffer.from(text),identity={documentId:'doc',versionId:'version',byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    const encoded=await encodeDocumentArchiveChunk(binding,identity,bytes,limits)
    expect(await decodeDocumentArchiveChunk(encoded.bytes,encoded.manifest,binding,identity,limits)).toEqual(bytes)
    await expect(decodeDocumentArchiveChunk(encoded.bytes,encoded.manifest,binding,{...identity,versionId:'foreign'},limits)).rejects.toThrow('binding')
    await expect(decodeDocumentArchiveChunk(encoded.bytes,encoded.manifest,{...binding,userId:2},identity,limits)).rejects.toThrow('binding')
    await expect(decodeDocumentArchiveChunk(encoded.bytes.subarray(0,10),encoded.manifest,binding,identity,limits)).rejects.toThrow()
  })
  test('rejects incorrect original digest and payloads exceeding the raw chunk budget',async()=>{
    const bytes=Buffer.alloc(800_000),identity={documentId:'doc',versionId:'version',byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
    await expect(encodeDocumentArchiveChunk(binding,identity,bytes,limits)).rejects.toThrow('byte limit')
    await expect(encodeDocumentArchiveChunk(binding,{...identity,sha256:'a'.repeat(64)},Buffer.from('bad'),limits)).rejects.toThrow('integrity')
  })
})
