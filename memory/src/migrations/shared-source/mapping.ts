/** Proof evaluation only. This module grants neither deletion nor source access. */
export type SourceKind = 'relay_event' | 'team_collaboration' | 'team_delivery' | 'legacy_archive' | 'team_semantic'
export const MAPPING_STATES=['unique-hot','unique-cold','team-collaboration','accepted-delivery','known-deleted','revoked','verified-legacy-only','conflict','ambiguous','unproven'] as const
export type MappingState=typeof MAPPING_STATES[number]
export interface Link { kind: SourceKind; id: string; via: 'inbox' | 'feed' | 'journal' | 'snapshot' | 'producer' | 'ingress'; version?: string }
export interface Source {
  id: string; installationId: string; ownerKey: string; sessionId: string; turnId: string | null; eventType: string
  classificationHash?: string; hash: string; actualHash: string; links: Link[]; provenance: 'known' | 'unknown'; sequence?: string
  originalSourceHash?:string;originalHashVersion?:'canonical-json-sha256-v1'|'snapshot-envelope-sha256-v1'
  bodyReclaimed?: boolean
  tombstone?: { verified: boolean; ownerKey: string; sessionId: string; revoked?: boolean }
  legacyProof?: { identityVerified: boolean; completeTargetSearch: boolean; archiveVerified: boolean;manifestHash?:string }
}
export interface Candidate {
  kind: SourceKind; id: string; installationId: string; ownerKey: string; sessionId: string; turnId: string | null
  eventType: string; classificationHash?: string; hash: string; version: string; sequence?: string; storage: 'hot' | 'cold'
  authorityVerified: boolean; provenance: 'known' | 'unknown'; archiveVerified?: boolean; teamVerified?: boolean
  originalIdentityProof?:{kind:'retained-feed-v1'|'retained-inbox-v1'|'retained-ingress-key-v1';manifestHash:string}
}
export interface MappingResult {
  sourceEventId: string; installationId: string; state: MappingState; reasons: string[]; replacementProven: boolean
  originalSourceHash:string;originalHashVersion:'canonical-json-sha256-v1'|'snapshot-envelope-sha256-v1'|'unproven'
  originalIdentityManifestHash?:string;originalIdentityManifest?:Record<string,unknown>;legacyManifestHash?:string;legacyCustody?:Record<string,unknown>;deletionEligible: false; contentHash:string; classificationHash?:string; sourceVersion?:string; sourceSequence?:string; provenanceState:'known'|'unknown'; identityRelations:Link[]; canonicalId?: string; sourceKind?: SourceKind; hashVersion: 'canonical-json-sha256-v1'
}
export function mapSource(source: Source, candidates: Candidate[]): MappingResult {
  const result = (state: MappingState, reasons: string[], candidate?: Candidate): MappingResult => ({
    sourceEventId: source.id, installationId: source.installationId, state, reasons,
    originalSourceHash:source.originalSourceHash??source.hash,originalHashVersion:source.originalHashVersion??(source.hash===source.actualHash?'canonical-json-sha256-v1':'unproven'),
    replacementProven: ['unique-hot','unique-cold','team-collaboration','accepted-delivery','verified-legacy-only'].includes(state),
    deletionEligible: false, hashVersion: 'canonical-json-sha256-v1',contentHash:source.hash,classificationHash:source.classificationHash,
    sourceSequence:source.sequence,provenanceState:source.provenance,identityRelations:source.links.map(l=>({kind:l.kind,id:l.id,via:l.via,...(l.version?{version:l.version}:{})})),
    ...(candidate ? {canonicalId:candidate.id,sourceKind:candidate.kind,...(candidate.version?{sourceVersion:candidate.version}:{}),...(candidate.originalIdentityProof?{originalIdentityManifestHash:candidate.originalIdentityProof.manifestHash}:{})} : {}),
  })
  if (source.tombstone?.verified) {
    if (source.tombstone.ownerKey !== source.ownerKey || source.tombstone.sessionId !== source.sessionId)
      return result('conflict',['tombstone_scope_mismatch'])
  }
  if (source.bodyReclaimed) return result('unproven',['memory_body_reclaimed'])
  if (!/^[a-f0-9]{64}$/.test(source.hash) || source.hash !== source.actualHash) return result('conflict',['stored_hash_mismatch'])
  const manifestVerified=/^[a-f0-9]{64}$/.test(source.legacyProof?.manifestHash??'')
  const legacyVerified=source.legacyProof?.identityVerified&&source.legacyProof.completeTargetSearch&&source.legacyProof.archiveVerified&&manifestVerified
  // Original transport identity is independent of producer lineage. This
  // narrow snapshot proof supplies neither Journal order nor runtime access.
  const originalIdentity=(c:Candidate)=>source.provenance==='unknown'&&source.sequence===undefined&&c.provenance==='unknown'&&c.sequence===undefined&&!c.version
    &&c.kind==='relay_event'&&c.authorityVerified&&!!c.originalIdentityProof&&['retained-feed-v1','retained-inbox-v1','retained-ingress-key-v1'].includes(c.originalIdentityProof.kind)&&/^[a-f0-9]{64}$/.test(c.originalIdentityProof.manifestHash)
    &&(c.storage==='hot'||c.originalIdentityProof.kind==='retained-ingress-key-v1'&&c.archiveVerified===true)
    &&source.links.some(l=>l.kind===c.kind&&l.id===c.id&&l.via===(c.originalIdentityProof!.kind==='retained-ingress-key-v1'?'ingress':c.originalIdentityProof!.kind==='retained-inbox-v1'?'inbox':'feed')&&l.version===undefined)
  if (source.provenance !== 'known'&&!(legacyVerified&&candidates.length===0)&&!candidates.some(originalIdentity)) return result('unproven',['provenance_unknown'])
  if (!source.ownerKey || !source.sessionId) return result('unproven',['scope_unknown'])
  const linked = candidates.filter(c => source.links.some(l => l.kind === c.kind && l.id === c.id))
  const unique = new Map<string,Candidate>()
  for (const c of linked) {
    const key=JSON.stringify([c.kind,c.id]), existing=unique.get(key)
    if (existing && JSON.stringify(existing) !== JSON.stringify(c)) return result('conflict',['duplicate_identity_conflict'])
    unique.set(key,c)
    for (const field of ['installationId','ownerKey','sessionId','turnId','eventType','hash','classificationHash'] as const)
      if (c[field] !== source[field]) return result('conflict',[field+'_mismatch'])
    const versions=source.links.filter(l=>l.kind===c.kind && l.id===c.id && l.version!==undefined).map(l=>l.version)
    if (versions.some(v=>v!==c.version) || (source.sequence!==undefined && source.sequence!==c.sequence))
      return result('conflict',['source_version_mismatch'])
  }
  if (unique.size>1) return result('ambiguous',['multiple_canonical_identities'])
  if(source.tombstone?.verified)return result(source.tombstone.revoked?'revoked':'known-deleted',['authority_tombstone'])
  const c=unique.values().next().value as Candidate | undefined
  if (!c) {
    if (legacyVerified) return {...result('verified-legacy-only',['verified_archive_required_before_retirement',...(source.provenance==='unknown'?['provenance_unknown']:[])]),sourceKind:'legacy_archive',canonicalId:source.id,
      ...(manifestVerified?{legacyManifestHash:source.legacyProof!.manifestHash,sourceVersion:'legacy-in-place-v1:'+source.legacyProof!.manifestHash}:{})}
    return result('unproven',[source.links.length ? 'authoritative_source_unavailable' : 'missing_identity_relation'])
  }
  if (!originalIdentity(c)&&(!c.authorityVerified || c.provenance!=='known' || !c.version)) return result('unproven',['authority_or_version_unverified'])
  if (c.storage==='cold' && !c.archiveVerified) return result('unproven',['archive_unverified'])
  if (c.kind==='team_collaboration' || c.kind==='team_delivery') {
    if (!c.teamVerified) return result('unproven',['team_authority_unverified'])
    return result(c.kind==='team_delivery'?'accepted-delivery':'team-collaboration',[],c)
  }
  return result(c.storage==='cold'?'unique-cold':'unique-hot',[],c)
}
