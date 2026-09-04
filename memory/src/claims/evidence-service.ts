import { createHash } from 'crypto'
import type pg from 'pg'

/**
 * Evidence reads and sanitized excerpts. Evidence is immutable once written;
 * this service only reads (Task 10's REST layer uses it for get_evidence).
 */
export function createEvidenceService(pool: pg.Pool) {
  return {
    async evidenceForVersion(input: {
      installationId: string
      versionId: string
    }): Promise<readonly {
      evidenceId: string
      evidenceKind: string
      episodeId: string
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
        FROM knowledge_evidence
        WHERE installation_id = $1 AND version_id = $2
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
      episodeId: string
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
