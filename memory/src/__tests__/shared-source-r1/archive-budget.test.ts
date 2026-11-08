import {expect,test} from 'vitest'
import {SessionHistoryBodyReader,MemoryArchiveStorage,archiveObjectKey,encodeArchiveChunk} from '@pocketctl/session-source'
test('sparse cold pages enforce aggregate object/raw/transfer budgets before unbounded IO',async()=>{
 const storage=new MemoryArchiveStorage(),manifests=new Map<string,any>(),rows:any[]=[],limits={maxRawBytes:1024*1024,maxCompressedBytes:1024*1024,maxRecords:100}
 for(let i=1;i<=2;i++){
  const manifestId=`10000000-0000-0000-0000-${String(i).padStart(12,'0')}`
  const encoded=await encodeArchiveChunk({userId:1,sessionId:'s',activityEpoch:'1',manifestId,ordinal:0},[{id:String(i),eventType:'agent_text',payload:{text:'private archive fixture'}}],limits)
  const key=archiveObjectKey(manifestId,0);await storage.put(key,encoded.bytes);manifests.set(manifestId,{manifest:encoded.manifest,key,state:'published'})
  rows.push({id:String(i),sessionId:'s',bodySessionId:'s',eventType:'agent_text',bodyStorage:'cold',payload:null,manifestId,chunkOrdinal:0,activityEpoch:'1'})
 }
 for(const pageLimits of [{maxChunks:1,maxRawBytes:1024*1024,maxCompressedBytes:1024*1024},{maxChunks:2,maxRawBytes:1,maxCompressedBytes:1024*1024},{maxChunks:2,maxRawBytes:1024*1024,maxCompressedBytes:1}]){
  let reads=0
  const reader=new SessionHistoryBodyReader({storage:{read:async key=>{reads++;return storage.read(key)}},limits,cacheBytes:1024*1024,cacheTtlMs:1000,authorize:async()=>true,loadManifest:async(_u,_s,id)=>manifests.get(id),pageLimits})
  await expect(reader.hydrate({userId:1,sessionId:'s',rows})).rejects.toThrow('history page archive limit exceeded')
  expect(reads).toBe(0)
 }
})
