import { createHash } from 'crypto'
import type pg from 'pg'
import { redactSensitive } from '../logging.js'
import type { ContextRetrieval } from './retrieval.js'
import type { ScopeResolver } from './scope-resolver.js'
import type { LoadoutRepository } from './loadout-repository.js'
import { resolvedLoadoutFingerprint } from './loadout-repository.js'
import type { ContextSettingsRepository } from './settings-repository.js'
import { effectiveContextSettingsFingerprint } from './settings-repository.js'
import type { PackRepository, PackItemInput, ExternalPackItemInput } from './pack-repository.js'
import type { GenerationRunRepository } from '../generation/repository.js'
import type { PolicyResolver } from '../policies/resolver.js'
import type { ContextPolicyDocument, RankingPolicyDocument } from '../policies/schemas.js'
import { applyTokenBudget, dedupeItems, estimateTokens } from './token-budget.js'

/**
 * Deterministic synchronous Context Pack compiler (ADR-P2-03/P2-04). Same
 * inputs + policies always produce a byte-identical pack; the enabled path
 * makes no model calls; content redaction re-runs even though extraction
 * already filtered content.
 */

export type CompileOutcome =
  | { kind: 'off' }
  | { kind: 'empty'; reason: string; degradedComponents: string[] }
  | { kind: 'ready'; packId: string; stableTokens: number; dynamicTokens: number; itemCount: number }
  | { kind: 'shadow'; packId: string }
  | { kind: 'unsupported_adapter' }
  | { kind: 'degraded'; reason: string }
  | { kind: 'retrieval_failed' }

export interface CompileRequest {
  installationId: string
  sessionId: string
  clientRequestId: string
  agent: string
  adapterCapability: 'native_hidden_v1' | 'shadow_only'
  repositoryId?: string | null
  repositoryKey?: string | null
  branch?: string | null
  query: string
  requestKey: { keyId: string; hmacKey: Buffer }
  selectedReferences?: readonly SelectedContextReference[]
}

export interface SelectedContextReference {
  source_kind: 'memory_claim' | 'memory_evidence' | 'wiki_section'
  source_id: string
  source_version: string
  owner_scope_id: string
  installation_id: string
}

export type ResolvedSelectedReference =
  | {
      kind: 'claim'
      reference: SelectedContextReference
      claimId: string
      versionId: string
      claimType: string
      statement: string
      scopeKind: string
      evidenceIds: string[]
    }
  | {
      kind: 'wiki'
      reference: SelectedContextReference
      versionId: string
      statement: string
      scopeKind: string
    }

export async function resolveSelectedContextReferences(
  pool: pg.Pool,
  installationId: string,
  references: readonly SelectedContextReference[],
): Promise<ResolvedSelectedReference[] | null> {
  const resolved: ResolvedSelectedReference[] = []
  for (const reference of references) {
    if (reference.installation_id !== installationId) return null
    if (reference.source_kind === 'wiki_section') {
      const result = await pool.query<{
        wiki_version_id: string
        heading: string
        markdown: string
        owner_scope_kind: string
        owner_scope_id: string
      }>(`
        SELECT section.wiki_version_id::text, section.heading, section.markdown,
               scope.owner_scope_kind, scope.owner_scope_id::text
        FROM memory_wiki_sections section
        JOIN memory_wiki_versions version
          ON version.installation_id = section.installation_id
         AND version.wiki_version_id = section.wiki_version_id
        JOIN memory_owner_scopes scope ON scope.installation_id = section.installation_id
        WHERE section.installation_id = $1 AND section.section_id = $2
          AND section.wiki_version_id = $3 AND version.state = 'active'
      `, [installationId, reference.source_id, reference.source_version])
      const row = result.rows[0]
      if (!row || row.owner_scope_id !== reference.owner_scope_id) return null
      resolved.push({
        kind: 'wiki', reference, versionId: row.wiki_version_id,
        statement: `${row.heading}\n${row.markdown}`.slice(0, 8_000),
        scopeKind: row.owner_scope_kind,
      })
      continue
    }
    const result = await pool.query<{
      claim_id: string
      version_id: string
      claim_type: string
      statement: string
      owner_scope_kind: string
      owner_scope_id: string
      evidence_ids: string[]
    }>(reference.source_kind === 'memory_claim' ? `
      SELECT claim.claim_id::text, version.version_id::text, claim.claim_type,
             version.statement, claim.owner_scope_kind, claim.owner_scope_id::text,
             ARRAY(SELECT evidence_id::text FROM knowledge_evidence evidence
                   WHERE evidence.installation_id = claim.installation_id
                     AND evidence.version_id = version.version_id
                   ORDER BY ordinal LIMIT 4) AS evidence_ids
      FROM knowledge_claims claim
      JOIN knowledge_versions version
        ON version.installation_id = claim.installation_id
       AND version.version_id = claim.current_version_id
      WHERE claim.installation_id = $1 AND claim.claim_id = $2
        AND version.version_id = $3 AND claim.state = 'active'
        AND EXISTS (SELECT 1 FROM knowledge_evidence evidence
                    WHERE evidence.installation_id = claim.installation_id
                      AND evidence.version_id = version.version_id)
    ` : `
      SELECT claim.claim_id::text, version.version_id::text, claim.claim_type,
             version.statement, claim.owner_scope_kind, claim.owner_scope_id::text,
             ARRAY[evidence.evidence_id::text] AS evidence_ids
      FROM knowledge_evidence evidence
      JOIN knowledge_versions version
        ON version.installation_id = evidence.installation_id
       AND version.version_id = evidence.version_id
      JOIN knowledge_claims claim
        ON claim.installation_id = version.installation_id
       AND claim.claim_id = version.claim_id
      WHERE evidence.installation_id = $1 AND evidence.evidence_id = $2
        AND version.version_id = $3 AND claim.current_version_id = version.version_id
        AND claim.state = 'active'
    `, [installationId, reference.source_id, reference.source_version])
    const row = result.rows[0]
    if (!row || row.owner_scope_id !== reference.owner_scope_id) return null
    resolved.push({
      kind: 'claim', reference, claimId: row.claim_id, versionId: row.version_id,
      claimType: row.claim_type, statement: row.statement,
      scopeKind: row.owner_scope_kind, evidenceIds: row.evidence_ids,
    })
  }
  return resolved
}

function deterministicItemId(parts: readonly string[]): string {
  const bytes = createHash('sha256').update(parts.join('\n')).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createContextCompiler(deps: {
  pool: pg.Pool
  retrieval: ContextRetrieval
  scope: ScopeResolver
  loadouts: LoadoutRepository
  settings: ContextSettingsRepository
  packs: PackRepository
  generation: GenerationRunRepository
  policyResolver: PolicyResolver
}) {
  return {
    async compile(input: CompileRequest): Promise<CompileOutcome> {
      const resolvedScope = await deps.scope.resolve({
        installationId: input.installationId,
        sessionId: input.sessionId,
        repositoryIdHint: input.repositoryId ?? null,
        repositoryKeyHint: input.repositoryKey ?? null,
      })
      const repositoryId = resolvedScope.repositoryId
      const effectiveSettings = await deps.settings.resolve({
        installationId: input.installationId,
        repositoryId,
        sessionId: input.sessionId,
        agent: input.agent,
      })
      if (effectiveSettings.mode === 'off') return { kind: 'off' }
      const mode: 'shadow' | 'enabled' =
        effectiveSettings.mode === 'enabled' && input.adapterCapability === 'native_hidden_v1'
          ? 'enabled'
          : 'shadow'

      const policy = await deps.policyResolver.resolve({
        installationId: input.installationId,
        kind: 'context',
        repositoryId,
      })
      const rankingPolicy = await deps.policyResolver.resolve({
        installationId: input.installationId,
        kind: 'ranking',
        repositoryId,
      })
      const policyDoc = policy.document as ContextPolicyDocument
      const loadout = await deps.loadouts.resolve({
        installationId: input.installationId,
        repositoryId,
        agent: input.agent,
      })

      const settingsFingerprint = effectiveContextSettingsFingerprint(effectiveSettings)
      const loadoutFingerprint = resolvedLoadoutFingerprint(loadout)
      const corpus = await deps.pool.query<{ fingerprint: string }>(`
        SELECT md5(COALESCE(string_agg(
          c.claim_id::text || ':' || c.state || ':' || COALESCE(c.current_version_id::text, '')
          || ':' || COALESCE((
            SELECT md5(string_agg(e.evidence_id::text, ',' ORDER BY e.evidence_id))
            FROM knowledge_evidence e
            WHERE e.installation_id = c.installation_id
              AND e.version_id = c.current_version_id
          ), ''), ',' ORDER BY c.claim_id), '')) AS fingerprint
        FROM knowledge_claims c
        WHERE c.installation_id = $1
      `, [input.installationId])
      const corpusFingerprint = corpus.rows[0]?.fingerprint ?? ''
      const effectivePolicyHash = createHash('sha256')
        .update(policy.effectivePolicyHash)
        .update(rankingPolicy.effectivePolicyHash)
        .digest()
      const minimizedQuery = redactSensitive(input.query).trim()
      const selectedReferences = input.selectedReferences ?? []
      const compileNow = new Date()
      const freshnessEpochDay = compileNow.toISOString().slice(0, 10)
      const freshnessAsOf = new Date(`${freshnessEpochDay}T00:00:00.000Z`)

      const inputDigest = createHash('sha256')
        .update([input.installationId, input.sessionId, input.clientRequestId,
          input.agent, input.adapterCapability, mode,
          repositoryId ?? '', repositoryId ? (input.branch ?? '') : '', minimizedQuery,
          settingsFingerprint.toString('hex'), loadoutFingerprint.toString('hex'),
          corpusFingerprint,
          JSON.stringify(selectedReferences),
          freshnessEpochDay,
        ].join('\n'))
        .digest()
      const run = await deps.generation.reserve({
        installationId: input.installationId,
        operation: 'compile_context',
        subjectKind: 'session',
        subjectKeyHash: createHash('md5').update(input.sessionId).digest(),
        inputDigest,
        effectivePolicyHash,
      })
	  if (!run.owner) {
		if (run.state === 'succeeded' && run.outputKind === 'context_pack' && run.outputId) {
		  const stored = await deps.packs.get(run.outputId)
		  if (stored?.state === 'ready') {
			return {
			  kind: 'ready', packId: run.outputId,
				  stableTokens: stored.stable_tokens, dynamicTokens: stored.dynamic_tokens,
          itemCount: stored.item_count,
			}
		  }
		  if (stored?.state === 'shadow') return { kind: 'shadow', packId: run.outputId }
			  if (stored?.state === 'empty') {
				return {
          kind: 'empty',
          reason: stored.error_code ?? 'no_candidates',
          degradedComponents: stored.degraded_components ?? [],
        }
		  }
		}
		return { kind: 'degraded', reason: 'compile_in_progress' }
	  }
      await deps.generation.attachPolicies({
        runId: run.runId,
        policyVersionIds: [...policy.policyVersionIds, ...rankingPolicy.policyVersionIds],
      })

      // L3 Persona stable pool: active user-reviewed work_method only.
      const persona = selectedReferences.length > 0 ? [] : !resolvedScope.repositoryKnown
        && policyDoc.unknown_repository_behavior === 'empty'
        ? []
        : await deps.scope.personaVersions({ installationId: input.installationId })
      // Dynamic pool: replayable retrieval over the transient query.
      const retrieval = selectedReferences.length === 0 && resolvedScope.repositoryKnown && minimizedQuery.length > 0
        ? await deps.retrieval.retrieve({
            installationId: input.installationId,
            query: minimizedQuery,
            repositoryId,
            branch: input.branch ?? null,
            limit: policyDoc.max_items * 3,
            claimTypes: policyDoc.allowed_claim_types,
            pinnedVersionIds: loadout.items
              .filter(item => item.status === 'resolved')
              .map(item => item.versionId ?? ''),
            requestKey: input.requestKey,
            rankingPolicyVersionId: rankingPolicy.policyVersionIds[0] ?? null,
            rankingPolicy: rankingPolicy.document as RankingPolicyDocument,
          })
        : { outcome: 'empty' as const, degradedComponents: [], candidates: [], trajectoryId: '' }
      if (retrieval.outcome === 'retrieval_failed') {
        await deps.generation.complete({
          runId: run.runId, state: 'failed', errorCode: 'retrieval_failed',
        })
        return { kind: 'retrieval_failed' }
      }

      const personaVersionIds = new Set(persona.map(entry => entry.versionId))
      const pinnedVersions = new Set(loadout.items
        .filter(item => item.status === 'resolved')
        .map(item => item.versionId ?? ''))

      interface DraftItem extends PackItemInput {
        normalizedKey: string
        rank: number
      }
      const drafts: DraftItem[] = []
      const externalItems: ExternalPackItemInput[] = []

      if (selectedReferences.length > 0) {
        const selected = await resolveSelectedContextReferences(deps.pool, input.installationId, selectedReferences)
        if (!selected) {
          await deps.generation.complete({ runId: run.runId, state: 'failed', errorCode: 'missing_source' })
          return { kind: 'empty', reason: 'missing_source', degradedComponents: [] }
        }
        for (const entry of selected) {
          if (entry.kind === 'wiki') {
            externalItems.push({
              itemId: deterministicItemId([inputDigest.toString('hex'), entry.reference.source_id, entry.versionId, 'wiki']),
              versionId: entry.versionId,
              statement: redactSensitive(entry.statement),
              scopeKind: entry.scopeKind,
              section: 'stable',
              evidenceIds: [],
            })
            continue
          }
          drafts.push({
            itemId: deterministicItemId([
              inputDigest.toString('hex'), entry.claimId, entry.versionId,
              entry.reference.source_kind, entry.reference.source_id,
            ]),
            claimId: entry.claimId,
            versionId: entry.versionId,
            claimType: entry.claimType,
            layer: 'L2',
            section: 'stable',
            representation: 'reference',
            statement: redactSensitive(entry.statement),
            scopeKind: entry.scopeKind,
            reasonCodes: ['team_context_selected', entry.reference.source_kind],
            evidenceIds: entry.evidenceIds,
            normalizedKey: `selected:${entry.claimId}`,
            rank: 1_000,
          })
        }
      }

      const evidenceFor = async (versionId: string): Promise<string[]> => {
        const rows = await deps.pool.query<{ evidence_id: string }>(`
          SELECT evidence_id::text FROM knowledge_evidence
          WHERE installation_id = $1 AND version_id = $2
          ORDER BY ordinal ASC LIMIT 4
        `, [input.installationId, versionId])
        return rows.rows.map(row => row.evidence_id)
      }

      for (const entry of persona) {
        const statement = redactSensitive(await statementFor(deps.pool, input.installationId, entry.versionId))
        drafts.push({
          itemId: deterministicItemId([
            inputDigest.toString('hex'), policy.effectivePolicyHash.toString('hex'),
            entry.claimId, entry.versionId, 'L3', 'stable',
          ]),
          claimId: entry.claimId,
          versionId: entry.versionId,
          claimType: 'work_method',
          layer: 'L3',
          section: 'stable',
          representation: 'summary',
          statement,
          scopeKind: 'installation',
          reasonCodes: ['persona', 'l3_stable'],
          evidenceIds: await evidenceFor(entry.versionId),
          normalizedKey: `persona:${entry.claimId}`,
          rank: 100,
        })
      }

      const retrievalCandidates = retrieval.outcome !== 'degraded'
        ? retrieval.candidates
        : policyDoc.degraded_behavior === 'empty'
          ? []
          : retrieval.candidates.filter(candidate => policyDoc.degraded_behavior === 'metadata_only'
            ? candidate.sourcePools?.includes('metadata')
            : candidate.sourcePools?.some(pool => pool === 'metadata' || pool === 'lexical'))
      for (const candidate of retrievalCandidates) {
        if (personaVersionIds.has(candidate.versionId)) continue
        const freshnessDays = policyDoc.freshness_days[candidate.claimType]
        if (freshnessDays !== undefined && candidate.freshnessAt
          && freshnessAsOf.getTime() - candidate.freshnessAt.getTime() > freshnessDays * 86_400_000) continue
        const isL3 = candidate.claimType === 'work_method'
        if (isL3) continue // only the reviewed persona path creates L3 items
        const section: 'stable' | 'dynamic' = pinnedVersions.has(candidate.versionId)
          ? 'stable'
          : 'dynamic'
        drafts.push({
          itemId: deterministicItemId([
            inputDigest.toString('hex'), policy.effectivePolicyHash.toString('hex'),
            candidate.claimId, candidate.versionId, 'L2', section,
          ]),
          claimId: candidate.claimId,
          versionId: candidate.versionId,
          claimType: candidate.claimType,
          layer: 'L2',
          section,
          representation: pinnedVersions.has(candidate.versionId) ? 'summary' : 'on_demand',
          statement: redactSensitive(candidate.statement),
          scopeKind: candidate.scopeKind,
          reasonCodes: candidate.reasonCodes,
          evidenceIds: await evidenceFor(candidate.versionId),
          normalizedKey: `${candidate.claimType}:${candidate.claimId}`,
          rank: candidate.fusedScore,
        })
      }

      // Deduplicate by identity and near-identical text before budgeting.
      const deduped = dedupeItems(drafts.map(draft => ({
        ...draft,
        renderedText: draft.statement,
      }))).map(entry => {
        const { renderedText, ...rest } = entry
        void renderedText
        return rest as DraftItem
      })

      const totalTokens = Math.min(
        policyDoc.max_total_tokens,
        effectiveSettings.maxTokens ?? policyDoc.max_total_tokens,
      )
      const stableTokens = Math.min(
        totalTokens,
        Math.max(policyDoc.stable_tokens, policyDoc.loadout_reserve_tokens),
      )
      const budget = applyTokenBudget({
        items: deduped.map(draft => ({
          key: draft.itemId,
          section: draft.section,
          estimatedTokens: estimateTokens(draft.statement),
          rank: draft.rank,
          pinned: pinnedVersions.has(draft.versionId),
        })),
        stableTokens,
        dynamicTokens: Math.min(policyDoc.dynamic_tokens, Math.max(0, totalTokens - stableTokens)),
        maxItems: Math.min(policyDoc.max_items, 10),
      })
      const keptItems = deduped.filter(draft => budget.kept.includes(draft.itemId))

      if (keptItems.length === 0 && externalItems.length === 0) {
        const emptyReason = budget.kept.length === 0 && drafts.length > 0
          ? 'token_budget' : 'no_candidates'
        const packId = await deps.packs.persist({
          installationId: input.installationId,
          generationRunId: run.runId,
          trajectoryId: retrieval.trajectoryId || null,
          sessionId: input.sessionId,
          clientRequestId: input.clientRequestId,
          agent: input.agent,
          repositoryId,
          mode,
          effectivePolicyHash,
          settingsFingerprint,
          loadoutFingerprint,
          inputDigest,
          policyRevision: policy.policyRevision,
          settingsRevision: effectiveSettings.revisions[0] ?? 1,
          loadoutRevision: loadout.revision,
          items: [],
          selectedReferences,
          state: 'empty',
          errorCode: emptyReason,
        })
        void packId
        return {
          kind: 'empty',
          reason: emptyReason,
          degradedComponents: retrieval.degradedComponents,
        }
      }

      const packId = await deps.packs.persist({
        installationId: input.installationId,
        generationRunId: run.runId,
        trajectoryId: retrieval.trajectoryId || null,
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        agent: input.agent,
        repositoryId,
        mode,
        effectivePolicyHash,
        settingsFingerprint,
        loadoutFingerprint,
        inputDigest,
        policyRevision: policy.policyRevision,
        settingsRevision: effectiveSettings.revisions[0] ?? 1,
        loadoutRevision: loadout.revision,
        items: keptItems,
        externalItems,
        selectedReferences,
        state: mode === 'enabled' ? 'ready' : 'shadow',
      })

      if (mode === 'shadow') return { kind: 'shadow', packId }
      const stored = await deps.packs.get(packId)
      return {
        kind: 'ready',
        packId,
        stableTokens: stored?.stable_tokens ?? 0,
        dynamicTokens: stored?.dynamic_tokens ?? 0,
        itemCount: keptItems.length + externalItems.length,
      }
    },
  }
}

async function statementFor(pool: pg.Pool, installationId: string, versionId: string): Promise<string> {
  const result = await pool.query<{ statement: string }>(`
    SELECT statement FROM knowledge_versions
    WHERE installation_id = $1 AND version_id = $2
  `, [installationId, versionId])
  return result.rows[0]?.statement ?? ''
}

export type ContextCompiler = ReturnType<typeof createContextCompiler>
