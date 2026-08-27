import { createHash } from 'crypto'
import type { TextGenerator, ModelJsonResult } from '../ports/text-generator.js'
import type { ExtractionRepository } from './repository.js'
import type { CandidateDeduper } from './deduper.js'
import { validateCandidate, type ValidationContext } from './validator.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'
import {
  EXTRACTION_EXTRACTOR_VERSION,
  EXTRACTION_PROMPT_VERSION,
  buildExtractionSystemPrompt,
  buildRepairSystemPrompt,
} from './prompt.js'
import {
  normalizedKeyForCandidate,
  validateExtractionOutput,
  type ExtractionCandidate,
} from './schema.js'

/**
 * Candidate extraction orchestration (plan §9). The Episode Packet is quoted
 * data; the model sees one extraction call plus at most one bounded repair
 * call; repeated or concurrent input cannot double-call the provider; and no
 * model output ever bypasses validation into an accepted or active state.
 */

export interface CandidateExtractorDeps {
  store: ExtractionRepository
  textGenerator: Pick<TextGenerator, 'generateJson'>
  provider: string
  model: string
  /** Stable hash input covering provider, origin and model configuration. */
  modelConfigFingerprint?: string
  timeoutMs: number
  /** Optional deterministic validator/deduper for enabled-mode runs. */
  deduper?: CandidateDeduper
}

export type ExtractionOutcome =
  | { kind: 'succeeded'; runId: string; candidateCount: number }
  | { kind: 'skipped_existing'; runId: string; state: string }
  | { kind: 'skipped_mode_off' }
  | { kind: 'episode_missing' }
  | { kind: 'quarantined'; runId: string }
  | { kind: 'failed'; runId: string; errorCode: string; retryable: boolean }
  | { kind: 'not_configured' }

export function createCandidateExtractor(deps: CandidateExtractorDeps) {
  const modelConfigHash = createHash('sha256')
    .update(`${deps.modelConfigFingerprint ?? `${deps.provider}\n${deps.model}`}\n${EXTRACTION_EXTRACTOR_VERSION}`)
    .digest()

  return {
    async extract(input: {
      installationId: string
      turnId: string
      signal: AbortSignal
    }): Promise<ExtractionOutcome> {
      const episode = await deps.store.loadEpisodeForExtraction(input.installationId, input.turnId)
      if (!episode) return { kind: 'episode_missing' }
      if (episode.extractionMode === 'off') return { kind: 'skipped_mode_off' }

      const reserved = await deps.store.reserveRun({
        installationId: input.installationId,
        episodeId: episode.episodeId,
        sourceDigest: episode.sourceDigest,
        extractorVersion: EXTRACTION_EXTRACTOR_VERSION,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        modelConfigHash,
        mode: episode.extractionMode,
        provider: deps.provider,
        model: deps.model,
        staleAfterMs: deps.timeoutMs * 3 + 70_000,
      })
      if (!reserved.owner) {
        if (reserved.existingState === 'running') {
          return { kind: 'failed', runId: reserved.runId, errorCode: 'run_in_progress', retryable: true }
        }
        return { kind: 'skipped_existing', runId: reserved.runId, state: reserved.existingState ?? 'running' }
      }

      const manifestHandles = Object.entries(episode.manifest)
        .filter(([, raw]) => !(raw !== null && typeof raw === 'object'
          && (raw as Record<string, unknown>).omitted === true))
        .map(([handle]) => handle)
      const systemPrompt = buildExtractionSystemPrompt(manifestHandles, episode.turnId)
      let usage = { inputTokens: 0, outputTokens: 0 }
      let totalCostMicros = 0

      const attempt = async (
        operation: 'candidate_extract' | 'candidate_repair',
        system: string,
      ): Promise<
        { ok: true; candidates: ExtractionCandidate[] } | { ok: false; errorCode: string; retryable: boolean }
      > => {
        const result: ModelJsonResult<unknown> = await deps.textGenerator.generateJson({
          operation,
          system,
          document: episode.document,
          schema: { type: 'object', properties: { candidates: { type: 'array' } } },
          timeoutMs: deps.timeoutMs,
          signal: input.signal,
        })
        if (!result.ok) {
          if (result.usage) {
            usage = {
              inputTokens: usage.inputTokens + result.usage.inputTokens,
              outputTokens: usage.outputTokens + result.usage.outputTokens,
            }
            totalCostMicros += result.usage.costMicros ?? 0
          }
          // Adapter-level JSON failures are still invalid model output and
          // earn exactly one bounded repair call.
          if (result.code === 'invalid_json' || result.code === 'empty_content') {
            return { ok: false, errorCode: `invalid_output:${result.code}`, retryable: false }
          }
          return { ok: false, errorCode: result.code, retryable: result.retryable }
        }
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
        }
        totalCostMicros += result.usage.costMicros ?? 0
        const validated = validateExtractionOutput(result.value)
        if (validated.ok && candidatesReferenceKnownHandles(validated.value.candidates, manifestHandles)) {
          return { ok: true, candidates: validated.value.candidates }
        }
        const codes = validated.ok
          ? ['evidence_handles:unknown_handle']
          : validated.failure.codes
        return { ok: false, errorCode: `invalid_output:${codes.slice(0, 4).join('|')}`, retryable: false }
      }

      let outcome = await attempt('candidate_extract', systemPrompt)
      if (!outcome.ok && !outcome.retryable && outcome.errorCode.startsWith('invalid_output')) {
        // Exactly one repair call carrying only bounded validation codes.
        const failureCodes = outcome.errorCode.slice('invalid_output:'.length).split('|')
        outcome = await attempt(
          'candidate_repair',
          buildRepairSystemPrompt(failureCodes, manifestHandles, episode.turnId),
        )
      }

      if (!outcome.ok) {
        const quarantined = outcome.errorCode.startsWith('invalid_output')
        await deps.store.markRun({
          runId: reserved.runId,
          state: quarantined ? 'quarantined' : 'failed',
          errorCode: outcome.errorCode.slice(0, 128),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicros: totalCostMicros,
        })
        return quarantined
          ? { kind: 'quarantined', runId: reserved.runId }
          : { kind: 'failed', runId: reserved.runId, errorCode: outcome.errorCode, retryable: outcome.retryable }
      }

      const manifestHandleSet = new Set(manifestHandles)
      const baseRows = outcome.candidates.map((candidate, index) => {
        const normalizedKey = normalizedClaimKey({
          claimType: candidate.claim_type,
          scopeKey: candidate.scope_key,
          statement: candidate.statement,
        })
        return {
          index,
          candidate,
          normalizedKey,
          repositoryId: typeof candidate.repository_id === 'string' ? candidate.repository_id : null,
          repoSnapshotId: typeof candidate.repo_snapshot_id === 'string' ? candidate.repo_snapshot_id : null,
          branch: typeof candidate.branch === 'string' ? candidate.branch : null,
          validFrom: candidate.valid_from ? new Date(candidate.valid_from) : null,
          validUntil: candidate.valid_until ? new Date(candidate.valid_until) : null,
        }
      })

      // Enabled mode runs deterministic validation and duplicate/conflict
      // classification; shadow mode keeps raw shadow candidates for metrics.
      const verdicts = new Map<number, ReturnType<typeof validateCandidate>>()
      if (episode.extractionMode === 'enabled' && deps.deduper) {
        const tombstonedKeys = await deps.deduper.tombstonedKeys({
          installationId: input.installationId,
          candidateKeys: baseRows.map(row => row.normalizedKey),
        })
        for (const row of baseRows) {
          const family = await deps.deduper.activeFamilyFor({
            installationId: input.installationId,
            claimType: row.candidate.claim_type,
            scopeKey: row.candidate.scope_key,
            statement: row.candidate.statement,
          })
          const context: ValidationContext = {
            manifestHandles: manifestHandleSet,
            episode: {
              turnId: episode.turnId,
              repositoryId: episode.repositoryId,
              repoSnapshotId: episode.repoSnapshotId,
              branch: episode.branch,
            },
            now: new Date(),
            tombstonedKeys,
            activeFamily: family.exactClaimId
              ? [{ claimId: family.exactClaimId, statement: row.candidate.statement }, ...family.family]
              : family.family,
          }
          verdicts.set(row.index, validateCandidate({
            claimType: row.candidate.claim_type,
            statement: row.candidate.statement,
            scopeKind: row.candidate.scope_kind,
            scopeKey: row.candidate.scope_key,
            repositoryId: row.repositoryId,
            repoSnapshotId: row.repoSnapshotId,
            branch: row.branch,
            validUntil: row.validUntil,
            evidenceHandles: row.candidate.evidence_handles,
            normalizedKey: row.normalizedKey,
          }, context))
        }
      }

      const candidateStatus = episode.extractionMode === 'enabled' && deps.deduper
        ? 'validated'
        : 'shadow'
      const rows = baseRows.map(row => {
        const verdict = verdicts.get(row.index)
        return {
          ordinal: row.index,
          claimType: row.candidate.claim_type,
          statement: row.candidate.statement,
          structuredContent: row.candidate.structured_content ?? {},
          normalizedKey: row.normalizedKey,
          scopeKind: row.candidate.scope_kind,
          scopeKey: row.candidate.scope_key,
          repositoryId: row.repositoryId,
          repoSnapshotId: row.repoSnapshotId,
          branch: row.branch,
          evidenceHandles: row.candidate.evidence_handles,
          confidence: row.candidate.confidence.toFixed(4),
          freshnessAt: row.candidate.freshness_at ? new Date(row.candidate.freshness_at) : new Date(),
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          status: (verdict ? verdict.status : candidateStatus) as 'shadow' | 'validated' | 'duplicate' | 'conflict' | 'rejected_by_validator',
          validation: verdict ? verdict.validation : {},
          duplicateOfClaimId: verdict && 'duplicateOfClaimId' in verdict && verdict.duplicateOfClaimId
            ? verdict.duplicateOfClaimId
            : null,
        }
      })
      await deps.store.persistCandidates({
        runId: reserved.runId,
        installationId: input.installationId,
        episodeId: episode.episodeId,
        candidateStatus,
        candidates: rows,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros: totalCostMicros },
      })
      return { kind: 'succeeded', runId: reserved.runId, candidateCount: rows.length }
    },
  }
}

function candidatesReferenceKnownHandles(
  candidates: readonly ExtractionCandidate[],
  manifestHandles: readonly string[],
): boolean {
  const known = new Set(manifestHandles)
  return candidates.every(candidate =>
    candidate.evidence_handles.length > 0
    && candidate.evidence_handles.every(handle => known.has(handle)),
  )
}
