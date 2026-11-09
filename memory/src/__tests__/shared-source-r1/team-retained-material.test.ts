import type pg from 'pg'
import {describe,test,expect,vi} from 'vitest'
import {prepareEvidenceSources} from '../../sources/evidence-sources.js'
import {bindSourcePool} from '../../sources/pool-context.js'

describe('Team retained evidence preparation',()=>{
 test.each(['team_collaboration','team_delivery','team_semantic'])('%s does not load a canonical raw body',async kind=>{
  const rows=[{episode_id:null,evidence_kind:'event',evidence_id:'evidence',version_id:'version',source_event_id:'event',artifact_id:null,resolved_event_id:'event',origin:'canonical',source_kind:kind,body_reclaimed_at:null,retention_denied:false,artifact_type:null,identity_key:null,path:null,status:null}]
  const query=vi.fn(async(sql:string)=>{
   if(sql.includes('FROM knowledge_evidence e'))return {rows}
   if(sql.includes('FROM shared.memory_source_modes'))return {rows:[{mode:'legacy-feed',generation:'1'}]}
   throw Error('unexpected_raw_body_read')
  })
  const pool={query} as unknown as pg.Pool
  bindSourcePool(pool,{namespace:'memory'})
  const prepared=await prepareEvidenceSources(pool,'installation',['evidence'])
  expect(prepared.bodyBytes).toBe(0)
  expect(prepared.material('evidence','version','event',null)).toMatchObject({sourceText:null,sourceKind:kind,origin:'canonical'})
  await prepared.assertCurrent(pool)
  expect(query.mock.calls.every(([sql])=>!sql.includes('payload'))).toBe(true)
 })
})
