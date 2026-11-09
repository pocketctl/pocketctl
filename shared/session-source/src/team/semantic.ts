/** Memory-owned semantic references deliberately do not widen native reader
 * SourceKind. Their body is reconstructed through an explicit Memory resolver. */
export interface TeamSemanticProvenance {
 source_kind:'team_semantic';source_version:1;normalization_version:'team-semantic-v1'
 native_kind:'team_collaboration'|'team_delivery';structured_identity:string[]
 receiving_installation_id:string;owner_scope_kind:string;owner_scope_id:string
 binding_id:string;binding_revision:string;semantic_session_id:string;semantic_turn_id:string
 role:'goal'|'reply'|'outcome';business_digest:string;native:Record<string,unknown>
}
export function parseTeamSemanticProvenance(value:unknown):TeamSemanticProvenance|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const p=value as Record<string,unknown>,identity=p.structured_identity
 if(p.source_kind!=='team_semantic'||p.source_version!==1||p.normalization_version!=='team-semantic-v1'
  ||!['team_collaboration','team_delivery'].includes(p.native_kind as string)||!['goal','reply','outcome'].includes(p.role as string)
  ||!Array.isArray(identity)||identity.length!==(p.native_kind==='team_collaboration'?6:7)||identity.some(x=>typeof x!=='string'||!x||x.length>1024)
  ||identity[0]!==p.native_kind||identity.at(-1)!==p.role
  ||typeof p.business_digest!=='string'||!/^[a-f0-9]{64}$/.test(p.business_digest)
  ||!p.native||typeof p.native!=='object'||Array.isArray(p.native))return null
 for(const key of ['receiving_installation_id','owner_scope_kind','owner_scope_id','binding_id','binding_revision','semantic_session_id','semantic_turn_id']){
  if(typeof p[key]!=='string'||!(p[key] as string).length||(p[key] as string).length>1024)return null
 }
 return structuredClone(p) as unknown as TeamSemanticProvenance
}
