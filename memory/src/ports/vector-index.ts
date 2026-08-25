/**
 * Phase 1 port: the vector projection behind the claim search projections.
 * ADR-P1-04: PostgreSQL exact vectors — same provider/model/dimension only,
 * scoring happens over a metadata/lexical-prefiltered pool, and the index is
 * a rebuildable projection, never an authority.
 */

export interface ClaimVector {
  installationId: string
  versionId: string
  provider: string
  model: string
  dimensions: number
  /** Normalized vector; length must equal `dimensions`. */
  vector: number[]
}

export interface VectorSearch {
  installationId: string
  provider: string
  model: string
  dimensions: number
  /** Normalized query vector; length must equal `dimensions`. */
  vector: number[]
  limit: number
  /** When present, scoring considers only these version ids. */
  candidateVersionIds?: readonly string[]
}

export interface VectorHit {
  versionId: string
  score: number
}

export interface VectorIndex {
  upsert(input: ClaimVector): Promise<void>
  search(input: VectorSearch): Promise<VectorHit[]>
  deleteVersion(installationId: string, versionId: string): Promise<void>
}
