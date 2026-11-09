import {expect,test} from 'vitest'
import {createSearchService} from '../retrieval/search-service.js'
const at=new Date('2026-11-01T00:00:00.000Z')
const records=[1,2].map(n=>({version_id:`10000000-0000-0000-0000-${String(n).padStart(12,'0')}`,claim_id:`20000000-0000-0000-0000-${String(n).padStart(12,'0')}`,claim_type:'test_invariant',statement:`fixture rule ${n}`,scope_kind:'installation',scope_key:'global',valid_from:null,freshness_at:at,authority:'user_accepted',repository_id:null,repo_snapshot_id:null,branch:null,search_as_of:at.toISOString(),consumption_hold_reason:null,canonical_repository_key:null,applicability:null}))
const pool={async query(sql:string){return {rows:sql.includes('WITH search_clock')?records:sql.includes('WITH candidate_documents')?records.map(r=>({version_id:r.version_id})):[],rowCount:0}}}
test('current federated inner pages preserve a server snapshot clock without becoming historical',async()=>{
 const service=createSearchService({pool:pool as never,recallEmbeddingTimeoutMs:10,cursorSigningKey:'unit'})
 const input={installationId:'installation',query:'fixture',limit:1,asOf:at,selectionHistorical:false}
 const first=await service.search(input)
 expect(first.nextCursor).toBeTruthy()
 const second=await service.search({...input,cursor:first.nextCursor})
 expect(second.hits).toHaveLength(1);expect(second.hits[0].versionId).not.toBe(first.hits[0].versionId)
 // A direct historical request cannot repurpose the signed current cursor.
 await expect(service.search({...input,selectionHistorical:undefined,cursor:first.nextCursor})).rejects.toThrow('invalid_cursor')
 await expect(service.search({...input,selectionHistorical:true,cursor:first.nextCursor})).rejects.toThrow('invalid_cursor')
})
