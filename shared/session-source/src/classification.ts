import {parseMemorySourceProvenance,type MemorySourceProvenance} from './provenance.js'
export interface SourceClassification {
 memory_source?:MemorySourceProvenance
 actor_scope?:string;flow_scope?:string;content_class?:string;classifier_version?:string
}
/** Frozen Feed v1 mapping. The caller establishes the trusted Journal relation;
 * shape validation alone does not authenticate raw producer payloads. */
export function canonicalSourceClassification(row:{source_kind:string;session_id:string|null;source_seq:number|string;payload:Record<string,unknown>}):SourceClassification {
 const payload=row.payload??{},classification:SourceClassification={}
 const turnId=typeof payload.turn_id==='string'&&payload.turn_id?payload.turn_id:typeof payload.source_turn_id==='string'&&payload.source_turn_id?payload.source_turn_id:undefined
 for(const key of ['actor_scope','flow_scope','content_class','classifier_version'] as const)if(typeof payload[key]==='string')classification[key]=payload[key]
 if(row.source_kind==='canonical_event'){
  const proof=parseMemorySourceProvenance(payload.memory_source)
  if(proof&&proof.session_id===row.session_id&&proof.turn_id===turnId&&/^[1-9][0-9]{0,19}$/.test(String(row.source_seq)))classification.memory_source={...proof,sequence:String(row.source_seq)}
 }
 return classification
}
