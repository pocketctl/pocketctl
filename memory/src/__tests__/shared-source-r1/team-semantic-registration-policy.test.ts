import {expect,test} from 'vitest'
import {memoryForwardTableRoster} from '../../migrations/shared-forward/engine.js'
import {JSON_COLUMN_POLICY} from '../../migrations/shared-source/json-reference-policy.js'
import {classifyObject} from '../../migrations/shared-source/classification.js'
test('semantic metadata is an explicit schema94 additive roster and never silently backfilled into schema93',()=>{
 const previous=memoryForwardTableRoster(93),current=memoryForwardTableRoster(94)
 expect(current.filter(t=>!previous.includes(t))).toEqual(['memory_team_semantic_groups','memory_team_semantic_witnesses'])
 expect(previous).toContain('memory_canonical_projection_progress')
 expect(memoryForwardTableRoster(84)).not.toContain('memory_canonical_projection_progress')
 expect(memoryForwardTableRoster(95)).toContain('memory_team_semantic_groups')
 expect(memoryForwardTableRoster(96)).toContain('memory_team_semantic_publications')
 expect(memoryForwardTableRoster(95)).not.toContain('memory_team_semantic_publications')
 for(const table of ['memory_native_control_observations','memory_source_delivery_receipts','memory_source_snapshot_receipts'])expect(memoryForwardTableRoster(96)).not.toContain(table)
 expect(()=>memoryForwardTableRoster(97)).toThrow('unreviewed_memory_schema_version')
})
test('semantic JSON is explicitly classified; known and unknown metadata still require exact M0 review',()=>{
 const paths=Object.keys(JSON_COLUMN_POLICY).filter(p=>p.startsWith('memory_team_semantic_'))
 expect([...paths].sort()).toEqual([
  'memory_team_semantic_groups.structured_identity',
  'memory_team_semantic_groups.classification',
  'memory_team_semantic_groups.semantic_provenance',
  'memory_team_semantic_witnesses.source_scope',
  'memory_team_semantic_witnesses.source_root',
  'memory_team_semantic_witnesses.source_version',
  'memory_team_semantic_witnesses.original_provenance',
  'memory_team_semantic_publications.legacy_relation_audit',
  'memory_team_semantic_publications.structured_identity',
  'memory_team_semantic_publications.native_publication_proof',
  'memory_team_semantic_publications.source_roster',
 ].sort())
 for(const path of paths){
  const result=classifyObject({key:'json:'+path,kind:'json-column',schema:'memory',name:path,definitionHash:'a'.repeat(64)},{})
  expect(result).toMatchObject({action:'migrate-as-is',blocked:true,reasons:['object_review_required']})
 }
 expect(classifyObject({key:'future',kind:'json-column',schema:'memory',name:'memory_team_semantic_groups.future_body',definitionHash:'a'.repeat(64)},{})).toMatchObject({action:'unclassified',blocked:true})
})
