import {retainedSourceRead,type SourceReadGrant} from '../sources/retained-read.js'
import {guardRetainedEvidence} from '../sources/retained-authority.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {readBoundEvidence,type EvidenceReadInput,type BoundEvidenceReadInput} from './evidence-on-demand.js'
import { createHash } from 'crypto'
import type pg from 'pg'
import {versionBodyPresentSql} from './version-selection.js'
import {deliveryVersionAvailableSql} from '../episodes/delivery-withdrawal.js'

/**
 * Evidence reads and sanitized excerpts. Evidence is immutable once written;
 * this service only reads (Task 10's REST layer uses it for get_evidence).
 */
export function createEvidenceService(pool: pg.Pool) {
  return {
    summary:(input:EvidenceReadInput)=>readBoundEvidence(pool,input,false),
    readBound:(input:BoundEvidenceReadInput)=>readBoundEvidence(pool,input,true),
    async evidenceForVersion(input: {
      authorityGrant?:SourceReadGrant
      installationId: string
      versionId: string
    }): Promise<readonly {
      evidenceId: string
      evidenceKind: string
      episodeId: string | null
      sourceEventId: string | null
      artifactId: string | null
      excerpt: string
      locator: Record<string, unknown>
      occurredAt: Date
      ordinal: number
    }[]> {
      const value=await retainedSourceRead(pool,input,async db=>{
      const result = await db.query(`
        SELECT evidence_id::text, evidence_kind, episode_id::text, source_event_id::text,
               artifact_id::text, excerpt, locator, occurred_at, ordinal
        FROM knowledge_evidence e
        JOIN knowledge_versions guarded_version ON guarded_version.installation_id=e.installation_id AND guarded_version.version_id=e.version_id
        JOIN knowledge_claims guarded_claim ON guarded_claim.installation_id=guarded_version.installation_id AND guarded_claim.claim_id=guarded_version.claim_id
        WHERE e.installation_id = $1 AND e.version_id = $2
          AND EXISTS(SELECT 1 FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
            WHERE v.installation_id=e.installation_id AND v.version_id=e.version_id AND ${versionBodyPresentSql()} AND ${deliveryVersionAvailableSql()}
              AND c.state<>'revoked' AND c.consumption_hold_reason IS NULL
              AND NOT EXISTS(SELECT 1 FROM memory_claim_lifecycle l WHERE l.installation_id=c.installation_id AND l.claim_id=c.claim_id AND(l.storage_tier='cold' OR l.body_state='reclaimed')))
        ORDER BY e.ordinal LIMIT 4097
        ${sourcePoolContext(pool).namespace==='memory'?'FOR SHARE OF e,guarded_version,guarded_claim':''}
      `, [input.installationId, input.versionId])
      await guardRetainedEvidence(db,input.installationId,result.rows)
      return result.rows
      })
      return value??[]
    },

    async evidenceById(input: {
      authorityGrant?:SourceReadGrant
      installationId: string
      evidenceId: string
    }): Promise<{
      evidenceId: string
      versionId: string
      claimId: string
      evidenceKind: string
      episodeId: string | null
      excerpt: string
      locator: Record<string, unknown>
      occurredAt: Date
      excerptHash: string
    } | null> {
      const value=await retainedSourceRead(pool,input,async db=>{
      const result = await db.query(`
        SELECT e.evidence_id::text, e.version_id::text, v.claim_id::text, e.evidence_kind,
               e.episode_id::text,e.source_event_id::text,e.artifact_id::text,e.excerpt, e.locator, e.occurred_at, e.excerpt_hash
        FROM knowledge_evidence e
        JOIN knowledge_versions v ON v.version_id = e.version_id AND v.installation_id = e.installation_id
        JOIN knowledge_claims guarded_claim ON guarded_claim.installation_id=v.installation_id AND guarded_claim.claim_id=v.claim_id
        WHERE e.installation_id = $1 AND e.evidence_id = $2
          AND ${versionBodyPresentSql()} AND ${deliveryVersionAvailableSql()}
          AND guarded_claim.state<>'revoked' AND guarded_claim.consumption_hold_reason IS NULL
          ${sourcePoolContext(pool).namespace==='memory'?'FOR SHARE OF e,v,guarded_claim':''}
      `, [input.installationId, input.evidenceId])
      const row=result.rows[0]
      if(!row)return null
      await guardRetainedEvidence(db,input.installationId,[row])
      const {source_event_id:_,artifact_id:__,...view}=row
      return view
      })
      return value??null
    },
  }
}

/** Excerpt hash used when writing evidence rows. */
export function excerptHash(excerpt: string): Buffer {
  return createHash('sha256').update(excerpt, 'utf8').digest()
}

export type EvidenceService = ReturnType<typeof createEvidenceService>
