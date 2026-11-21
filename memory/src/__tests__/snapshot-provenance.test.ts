import {expect,test} from 'vitest'
import type {SourceHead} from '@pocketctl/session-source'
import {compactSnapshotFields} from '../sources/snapshot-provenance.js'

const proof={version:1,producer:'codex',session_id:'session',turn_id:'turn',event_id:'event',sequence:'1',
  invocation_id:'call',source_role:'assistant',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
const head:SourceHead={kind:'relay_event',rootKey:'1:session',canonicalKey:'1',sessionKey:'session',turnKey:'turn',sourceSequence:'1',
  eventType:'agent_text',contentHash:'aa'.repeat(32),hashVersion:'canonical-json-sha256-v1',storage:'hot',
  classification:{memory_source:structuredClone(proof)},provenance:{state:'known',memory:proof,reserved:{key:null}}}

test('packs validated metadata before page serialization while preserving every other key',()=>{
  expect(compactSnapshotFields(head)).toEqual({snapshot_format:1,provenance:{state:'known',reserved:{key:null}}})
  expect(head.provenance.memory).toEqual(head.classification.memory_source)
})

test('preserves legacy format for missing, null, incompatible, or unauthenticated input',()=>{
  for(const classification of [{},{memory_source:null},{memory_source:{}},{memory_source:{...proof,unknown:true}}])
    expect(compactSnapshotFields({...head,classification})).toBeNull()
  for(const overrides of [{state:'unknown'},{team:{}},{accepted_delivery:{}},{memory:null}])
    expect(compactSnapshotFields({...head,provenance:{...head.provenance,...overrides}})).toBeNull()
  for(const overrides of [{sessionKey:'other'},{turnKey:'other'},{sourceSequence:'2'}])
    expect(compactSnapshotFields({...head,...overrides})).toBeNull()
})
