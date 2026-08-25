import type pg from 'pg'

/**
 * Per-installation automatic feature modes (plan §9.3). Missing rows mean
 * both modes are off; updates are CAS-revisioned and refuse shadow/enabled
 * until the corresponding adapter is actually configured.
 */

export interface FeatureSettings {
  installationId: string
  extractionMode: 'off' | 'shadow' | 'enabled'
  embeddingMode: 'off' | 'shadow' | 'enabled'
  extractionConsentFingerprint: string | null
  embeddingConsentFingerprint: string | null
  revision: number
  updatedAt: Date
}

export function createSettingsRepository(
  pool: pg.Pool,
  options: {
    textConfigured: boolean
    embeddingConfigured: boolean
    extractionConsentFingerprint?: string
    embeddingConsentFingerprint?: string
  },
) {
  return {
    async get(installationId: string): Promise<FeatureSettings> {
      const result = await pool.query<{
        extraction_mode: string
        embedding_mode: string
        extraction_consent_fingerprint: string | null
        embedding_consent_fingerprint: string | null
        revision: string
        updated_at: Date
      }>(`
        SELECT extraction_mode, embedding_mode, extraction_consent_fingerprint,
               embedding_consent_fingerprint, revision::text, updated_at
        FROM memory_feature_settings WHERE installation_id = $1
      `, [installationId])
      const row = result.rows[0]
      return {
        installationId,
        extractionMode: row?.extraction_mode === 'shadow' || row?.extraction_mode === 'enabled'
          ? row.extraction_mode
          : 'off',
        embeddingMode: row?.embedding_mode === 'shadow' || row?.embedding_mode === 'enabled'
          ? row.embedding_mode
          : 'off',
        extractionConsentFingerprint: row?.extraction_consent_fingerprint ?? null,
        embeddingConsentFingerprint: row?.embedding_consent_fingerprint ?? null,
        revision: row ? Number(row.revision) : 1,
        updatedAt: row?.updated_at ?? new Date(0),
      }
    },

    async update(input: {
      installationId: string
      expectedRevision: number
      extractionMode?: 'off' | 'shadow' | 'enabled'
      embeddingMode?: 'off' | 'shadow' | 'enabled'
      confirmExtractionFingerprint?: string
      confirmEmbeddingFingerprint?: string
    }): Promise<
      | { ok: true; settings: FeatureSettings }
      | { ok: false; code: 'revision_conflict' | 'extraction_unconfigured' | 'embedding_unconfigured' | 'extraction_consent_required' | 'embedding_consent_required' }
    > {
      const current = await this.get(input.installationId)
      const extractionMode = input.extractionMode ?? current.extractionMode
      const embeddingMode = input.embeddingMode ?? current.embeddingMode
      if ((extractionMode === 'shadow' || extractionMode === 'enabled') && !options.textConfigured) {
        return { ok: false, code: 'extraction_unconfigured' }
      }
      if ((embeddingMode === 'shadow' || embeddingMode === 'enabled') && !options.embeddingConfigured) {
        return { ok: false, code: 'embedding_unconfigured' }
      }
      const extractionFingerprint = options.extractionConsentFingerprint ?? null
      const embeddingFingerprint = options.embeddingConsentFingerprint ?? null
      if (extractionMode !== 'off' && extractionFingerprint
        && current.extractionConsentFingerprint !== extractionFingerprint
        && input.confirmExtractionFingerprint !== extractionFingerprint) {
        return { ok: false, code: 'extraction_consent_required' }
      }
      if (embeddingMode !== 'off' && embeddingFingerprint
        && current.embeddingConsentFingerprint !== embeddingFingerprint
        && input.confirmEmbeddingFingerprint !== embeddingFingerprint) {
        return { ok: false, code: 'embedding_consent_required' }
      }
      const confirmedExtraction = extractionMode === 'off'
        ? null
        : (input.confirmExtractionFingerprint === extractionFingerprint
            ? extractionFingerprint
            : current.extractionConsentFingerprint)
      const confirmedEmbedding = embeddingMode === 'off'
        ? null
        : (input.confirmEmbeddingFingerprint === embeddingFingerprint
            ? embeddingFingerprint
            : current.embeddingConsentFingerprint)
      const result = await pool.query<{ revision: string }>(`
        WITH updated AS (
          UPDATE memory_feature_settings SET
            extraction_mode = $2,
            embedding_mode = $3,
            extraction_consent_fingerprint = $5,
            embedding_consent_fingerprint = $6,
            revision = revision + 1,
            updated_at = NOW()
          WHERE installation_id = $1 AND revision = $4
          RETURNING revision::text
        ), inserted AS (
          INSERT INTO memory_feature_settings
            (installation_id, extraction_mode, embedding_mode, revision,
             extraction_consent_fingerprint, embedding_consent_fingerprint)
          SELECT $1, $2, $3, 2, $5, $6
          WHERE $4 = 1
            AND NOT EXISTS (
              SELECT 1 FROM memory_feature_settings WHERE installation_id = $1
            )
          ON CONFLICT (installation_id) DO NOTHING
          RETURNING revision::text
        )
        SELECT revision FROM updated
        UNION ALL
        SELECT revision FROM inserted
      `, [input.installationId, extractionMode, embeddingMode, input.expectedRevision,
          confirmedExtraction, confirmedEmbedding])
      if (!result.rows[0]) {
        return { ok: false, code: 'revision_conflict' }
      }
      return {
        ok: true,
        settings: {
          installationId: input.installationId,
          extractionMode,
          embeddingMode,
          extractionConsentFingerprint: confirmedExtraction,
          embeddingConsentFingerprint: confirmedEmbedding,
          revision: Number(result.rows[0].revision),
          updatedAt: new Date(),
        },
      }
    },

    async installationEmbeddingDefault(installationId: string): Promise<'off' | 'shadow' | 'enabled'> {
      const current = await this.get(installationId)
      return current.embeddingMode
    },
  }
}

export type SettingsRepository = ReturnType<typeof createSettingsRepository>
