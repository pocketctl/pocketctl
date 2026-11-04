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
      const result = await pool.query(`
        SELECT evidence_id::text, evidence_kind, episode_id::text, source_event_id::text,
               artifact_id::text, excerpt, locator, occurred_at, ordinal
        FROM knowledge_evidence e
        WHERE installation_id = $1 AND version_id = $2
          AND EXISTS(SELECT 1 FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
            WHERE v.installation_id=e.installation_id AND v.version_id=e.version_id AND ${versionBodyPresentSql()} AND ${deliveryVersionAvailableSql()}
              AND c.state<>'revoked' AND c.consumption_hold_reason IS NULL
              AND NOT EXISTS(SELECT 1 FROM memory_claim_lifecycle l WHERE l.installation_id=c.installation_id AND l.claim_id=c.claim_id AND(l.storage_tier='cold' OR l.body_state='reclaimed')))
        ORDER BY ordinal
      `, [input.installationId, input.versionId])
      return result.rows
    },

    async evidenceById(input: {
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
      const result = await pool.query(`
        SELECT e.evidence_id::text, e.version_id::text, v.claim_id::text, e.evidence_kind,
               e.episode_id::text, e.excerpt, e.locator, e.occurred_at, e.excerpt_hash
        FROM knowledge_evidence e
        JOIN knowledge_versions v ON v.version_id = e.version_id AND v.installation_id = e.installation_id
        WHERE e.installation_id = $1 AND e.evidence_id = $2
          AND ${versionBodyPresentSql()} AND ${deliveryVersionAvailableSql()}
      `, [input.installationId, input.evidenceId])
      return result.rows[0] ?? null
    },
  }
}

/** Excerpt hash used when writing evidence rows. */
export function excerptHash(excerpt: string): Buffer {
  return createHash('sha256').update(excerpt, 'utf8').digest()
}

export type EvidenceService = ReturnType<typeof createEvidenceService>
