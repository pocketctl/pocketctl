export type FindingCertainty='recoverable'|'unknown'|'confirmed_violation'|'unproven'
export interface MigrationInventoryItem {
  kind: string
  id: string
  installationId: string
  reason: string
  action: 'quarantine' | 'review' | 'recover' | 'unchanged' | 'hold'
  certainty?:FindingCertainty
  sourceRecordId?:string
  sourceVersionId?:string
}
export interface ScopeObservation {installationId:string;ownerKind:string;ownerId:string;epoch:string;state:string}
export interface TeamSourceObservation {id:string;installationId:string;bindingId:string;bindingRevision:string;teamId:string;sessionId:string;participantId:string;participantRevision:string;targetInstallationId:string;targetOwnerKind:string;targetOwnerId:string}
export interface MigrationInventoryManifest {
  schemaVersion: number
  compatible: boolean
  blockers: string[]
  runId: string
  createdAt: string
  environmentFingerprint: string
  codeSchemaVersion: number
  counts: Record<string, number>
  items: MigrationInventoryItem[]
  itemLimit: number
  itemsTruncated: boolean
  tableBytes: Record<string, number>
  limitations: string[]
  findingCounts:Record<FindingCertainty,number>
  watermarks:{snapshotAt:string;feedId?:string}
  queryElapsedMs:number
  scopes:ScopeObservation[]
  scopesTruncated:boolean
  teamSources:Array<{id:string;installationId:string;participantFingerprint:string}>
  teamSourcesTruncated:boolean
}
