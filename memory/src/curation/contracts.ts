export type CurationMode = 'off' | 'shadow' | 'enabled'
export type CurationAction = 'create' | 'link_evidence' | 'merge' | 'replace' | 'create_variant' | 'noop' | 'skip' | 'defer'
export type KnowledgeKind = 'fact' | 'preference' | 'constraint' | 'decision' | 'method' | 'event'
export type AssertionMode = 'user_asserted' | 'decided' | 'planned' | 'observed' | 'verified'
export type LifecycleTier = 'hot' | 'cold'
export type BodyState = 'present' | 'reclaimed'
export type CandidateSource =
 | {kind:'legacy_episode';episodeId:string;runId:string}
 | {kind:'task_bundle';bundleId:string;runId:string;revision:number}
 | {kind:'manual_entry';entryId:string}
export type CurationState = 'pending' | 'running' | 'completed' | 'deferred_semantic' | 'blocked' | 'failed' | 'skipped_unresolved'
export const CURATION_POLICY_VERSION='memory-lifecycle-v1'
