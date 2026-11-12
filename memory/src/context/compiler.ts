import type {PackAuthorityGrant} from './pack-repository.js'
import {sourcePoolContext} from '../sources/pool-context.js'
import {readCurrentPolicyAuthority,CurrentPolicyScopeStaleError} from '../governance/current-policy-authority.js'
import {resolveLifecycleFrame,lifecycleFrameCurrent} from './lifecycle-frame.js'
import type {CurationMode} from '../curation/contracts.js'
import type {SceneDestination} from './scene-resolver.js'
import {prepareSelectedScopeContext,selectedScopeContextCurrent} from './selected-scope-dependencies.js'
import type {V2GrantFacts} from '../governance/authorization.js'
import { createHash } from 'crypto'
import type pg from 'pg'
import {originPolicyCorpusSnapshot} from '../governance/origin-policy.js'
import {contextWikiBuildSourcesEligible,contextClaimFacts,eligibleContextFacts,ContextConsumptionChangedError,type ContextQueryFrame} from './consumption.js'
import {withdrawnDeliveryJoinSql} from '../episodes/delivery-withdrawal.js'
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
import {renderItemLine,renderPackText,stableDynamicSplit,type RenderItem} from './renderer.js'
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
  | { kind: 'ready'; packId: string; stableTokens: number; dynamicTokens: number; itemCount: number; evidenceProven?: boolean }
  | { kind: 'shadow'; packId: string }
  | { kind: 'unsupported_adapter' }
  | { kind: 'degraded'; reason: string }
  | { kind: 'retrieval_failed' }

export interface CompileRequest {
  authorityGrant?:PackAuthorityGrant
  installationId: string
  sessionId: string
  clientRequestId: string
  agent: string
  evidenceReadCapability?:'bounded_excerpt_v1'|'on_demand_v1'
  adapterCapability: 'native_hidden_v1' | 'shadow_only'
  repositoryId?: string | null
  repositoryKey?: string | null
  branch?: string | null
  repoSnapshotId?:string|null
  commitSha?:string|null
  taskScopeKey?:string|null
  sceneId?:string|null
  destination?:SceneDestination
  factAt?:string|null
  knownAt?:string|null
  query: string
  requestKey: { keyId: string; hmacKey: Buffer }
  selectedReferences?: readonly SelectedContextReference[]
  selectedScopeGrant?: V2GrantFacts
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
  frame?:ContextQueryFrame,
): Promise<ResolvedSelectedReference[] | null> {
  const resolved: ResolvedSelectedReference[] = []
  for (const reference of references) {
    if (reference.installation_id !== installationId) return null
    if (reference.source_kind === 'wiki_section') {
      // Metadata preparation only. Caller grants and final pack/source CAS
      // still authorize consumption; a lagging owner mirror cannot do so.
      let nativeOwner: {scopeKind:string;ownerScopeId:string}|undefined
      if(sourcePoolContext(pool).namespace==='memory'){
        const state=(await pool.query<{state:{owner_scope_kind:string;owner_scope_id:string;status:string;provider_enabled:boolean;owner_exists:boolean;authorization_epoch:string}}>(
          'SELECT state FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[installationId],[]])).rows[0]?.state
        if(!state)return null
        if(state.owner_scope_kind==='personal'){
          if(state.status!=='active'||!state.provider_enabled||!state.owner_exists)return null
          const local=await pool.query(`SELECT 1 FROM memory_installations i WHERE i.installation_id=$1
            AND i.local_status NOT IN ('purging','purged','integrity_error')
            AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind='personal'
              AND t.owner_scope_id=$2 AND t.authorization_epoch>=$3::bigint)`,[installationId,state.owner_scope_id,state.authorization_epoch])
          if(!local.rowCount)return null
          nativeOwner={scopeKind:'personal',ownerScopeId:state.owner_scope_id}
        }else{
          try{nativeOwner=await readCurrentPolicyAuthority(pool,installationId,{readOnly:true})}
          catch(error){if(error instanceof CurrentPolicyScopeStaleError)return null;throw error}
          if(!nativeOwner)return null
        }
      }
      const result = await pool.query<{
        wiki_version_id: string
        build_run_id:string|null
        heading: string
        markdown: string
        owner_scope_kind: string
        owner_scope_id: string
      }>(`
        SELECT section.wiki_version_id::text, version.build_run_id::text, section.heading, section.markdown,
               ${nativeOwner?'$8::text':'scope.owner_scope_kind'} AS owner_scope_kind,
               ${nativeOwner?'$9::text':'scope.owner_scope_id::text'} AS owner_scope_id
        FROM memory_wiki_sections section
        JOIN memory_wiki_versions version
          ON version.installation_id = section.installation_id
         AND version.wiki_version_id = section.wiki_version_id
        ${nativeOwner?'':'JOIN memory_owner_scopes scope ON scope.installation_id = section.installation_id'}
        JOIN memory_wikis wiki ON wiki.installation_id=version.installation_id AND wiki.wiki_id=version.wiki_id
        JOIN memory_wiki_heads head ON head.installation_id=wiki.installation_id AND head.repository_id=wiki.repository_id AND head.active_version_id=version.wiki_version_id
        JOIN memory_source_snapshots snapshot ON snapshot.installation_id=version.installation_id AND snapshot.snapshot_id=version.source_snapshot_id AND snapshot.repository_id=wiki.repository_id
        WHERE section.installation_id = $1 AND section.section_id = $2
          AND section.wiki_version_id = $3 AND version.state = 'active'
          ${nativeOwner?'':"AND scope.state='active'"} AND snapshot.state NOT IN ('failed','purged')
          AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=wiki.installation_id AND t.repository_id=wiki.repository_id)
          AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=snapshot.installation_id AND t.repository_id=snapshot.repository_id AND t.commit_sha=snapshot.commit_sha)
          AND (NOT $4::boolean OR wiki.repository_id=$5::uuid)
          AND ($7::text IS NULL OR snapshot.commit_sha=$7)
          AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM repo_snapshots requested WHERE requested.installation_id=wiki.installation_id AND requested.repository_id=wiki.repository_id AND requested.repo_snapshot_id=$6 AND requested.commit_sha=snapshot.commit_sha))
      `, [installationId, reference.source_id, reference.source_version,frame!==undefined,frame?.repositoryId??null,frame?.repoSnapshotId??null,frame?.commitSha??null,...(nativeOwner?[nativeOwner.scopeKind,nativeOwner.ownerScopeId]:[])])
      const row = result.rows[0]
      if (!row || row.owner_scope_id !== reference.owner_scope_id) return null
      if(!await contextWikiBuildSourcesEligible(pool,installationId,row.build_run_id,frame??{repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null}))return null
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
    const fact=(await contextClaimFacts(pool,installationId,[row.version_id])).get(row.version_id)
    if(!fact||!eligibleContextFacts(fact,frame??{repositoryId:fact.repositoryId,repoSnapshotId:fact.snapshotId,branch:fact.branch,taskScopeKey:fact.scopeKey}))return null
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

export async function readContextCorpusFingerprint(pool:Pick<pg.Pool,'query'>,installationId:string):Promise<string>{
  // Freeze the existing digest format while aggregating all evidence for a
  // current Version once, including withdrawal status.
  const result=await pool.query<{fingerprint:string}>(`
    WITH current_versions AS MATERIALIZED (
      SELECT DISTINCT current_version_id AS version_id
      FROM knowledge_claims WHERE installation_id=$1 AND current_version_id IS NOT NULL
    ), evidence AS MATERIALIZED (
      SELECT e.version_id, md5(string_agg(e.evidence_id::text, ',' ORDER BY e.evidence_id)) AS fingerprint,
             bool_or(w.team_id IS NOT NULL) AS withdrawn
      FROM current_versions c JOIN knowledge_evidence e ON e.installation_id=$1 AND e.version_id=c.version_id
      LEFT JOIN memory_team_delivery_withdrawals w
        ON ${withdrawnDeliveryJoinSql('e','w')}
      GROUP BY e.version_id
    )
    SELECT md5(COALESCE(string_agg(
      c.claim_id::text || ':' || c.state || ':' || COALESCE(c.current_version_id::text, '')
      || ':' || (NOT COALESCE(e.withdrawn, false))::text
      || ':' || COALESCE(e.fingerprint, ''), ',' ORDER BY c.claim_id), '')) AS fingerprint
    FROM knowledge_claims c LEFT JOIN evidence e ON e.version_id=c.current_version_id
    WHERE c.installation_id=$1
  `,[installationId])
  return result.rows[0]?.fingerprint??''
}

export type ContextCompilePhase = 'scope' | 'inputs' | 'configuration' | 'reserve' | 'retrieve' | 'assemble' | 'persist'

export function createContextCompiler(deps: {
  pool: pg.Pool
  retrieval: ContextRetrieval
  scope: ScopeResolver
  loadouts: LoadoutRepository
  settings: ContextSettingsRepository
  packs: PackRepository
  generation: GenerationRunRepository
  lifecycleMode?:CurationMode
  policyResolver: PolicyResolver
}) {
  return {
    async compile(input: CompileRequest, observe?: (phase: ContextCompilePhase, ms: number) => void): Promise<CompileOutcome> {
      let checkpoint = performance.now()
      const mark = (phase: ContextCompilePhase) => {
        if (!observe) return
        const now = performance.now()
        observe(phase, Math.round(now - checkpoint))
        checkpoint = now
      }
      // Scope resolution samples the fence before snapshot-dependent inputs.
      const resolvedScope = await deps.scope.resolve({
        installationId: input.installationId,
        sessionId: input.sessionId,
        repositoryIdHint: input.repositoryId ?? null,
        repositoryKeyHint: input.repositoryKey ?? null,
      })
      const generation = resolvedScope.consumptionGeneration
      mark('scope')
      const repositoryId = resolvedScope.repositoryId
      const [lifecycle, snapshots, effectiveSettings] = await Promise.all([
        resolveLifecycleFrame(deps.pool,{installationId:input.installationId,sessionId:input.sessionId,repositoryId,spaceId:input.sceneId,destination:input.destination,mode:deps.lifecycleMode??'off',authorityGrant:input.authorityGrant}),
        !input.factAt && !input.knownAt && repositoryId && (input.repoSnapshotId || input.commitSha)
          ? deps.pool.query<{repo_snapshot_id:string;commit_sha:string}>(`SELECT s.repo_snapshot_id::text,s.commit_sha FROM repo_snapshots s
            WHERE s.installation_id=$1 AND s.repository_id=$2
             AND ($3::uuid IS NULL OR s.repo_snapshot_id=$3) AND ($4::text IS NULL OR s.commit_sha=$4)
             AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)
            ORDER BY s.repo_snapshot_id LIMIT 2`,[input.installationId,repositoryId,input.repoSnapshotId??null,input.commitSha?.toLowerCase()??null])
          : null,
        deps.settings.resolve({ installationId: input.installationId, repositoryId, sessionId: input.sessionId, agent: input.agent }),
      ])
      // Historical hints cannot silently broaden an automatic current-context request.
      if(input.factAt||input.knownAt)return{kind:'empty',reason:'historical_context_requires_explicit_read',degradedComponents:[]}
      const queryContext:ContextQueryFrame={...(lifecycle?{lifecycle}:{}),repositoryId,repoSnapshotId:null,branch:repositoryId?input.branch??null:null,taskScopeKey:input.taskScopeKey??null,commitSha:repositoryId?input.commitSha?.toLowerCase()??null:null}
      if(snapshots){
        if(snapshots.rows.length===1){queryContext.repoSnapshotId=snapshots.rows[0].repo_snapshot_id;queryContext.commitSha=snapshots.rows[0].commit_sha}
        else if(input.repoSnapshotId)return{kind:'empty',reason:'snapshot_context_unavailable',degradedComponents:[]}
      }
      mark('inputs')
      if (effectiveSettings.mode === 'off') return { kind: 'off' }
      const mode: 'shadow' | 'enabled' =
        effectiveSettings.mode === 'enabled' && input.adapterCapability === 'native_hidden_v1'
          ? 'enabled'
          : 'shadow'

      const [[policy, rankingPolicy], loadout, corpus, originSnapshot] = await Promise.all([
        deps.policyResolver.resolveContext({ installationId: input.installationId, repositoryId }),
        deps.loadouts.resolve({ installationId: input.installationId, repositoryId, agent: input.agent }),
        readContextCorpusFingerprint(deps.pool,input.installationId),
        originPolicyCorpusSnapshot(deps.pool, input.installationId),
      ])
      mark('configuration')
      const policyDoc = policy.document as ContextPolicyDocument
      const settingsFingerprint = effectiveContextSettingsFingerprint(effectiveSettings)
      const loadoutFingerprint = resolvedLoadoutFingerprint(loadout)
      if(originSnapshot.stamp!==null)queryContext.originPolicyStamp=originSnapshot.stamp
      const corpusFingerprint = corpus
      const effectivePolicyHash = createHash('sha256')
        .update(policy.effectivePolicyHash)
        .update(rankingPolicy.effectivePolicyHash)
        .digest()
      const minimizedQuery = redactSensitive(input.query).trim()
      const selectedReferences = input.selectedReferences ?? []
      let foreignSelected:ResolvedSelectedReference[]|undefined
      if(selectedReferences.some(r=>r.installation_id!==input.installationId)){
        if(!input.selectedScopeGrant)return{kind:'empty',reason:'missing_source',degradedComponents:[]}
        const prepared=await prepareSelectedScopeContext(deps.pool,{installationId:input.installationId,references:selectedReferences,frame:queryContext,grant:input.selectedScopeGrant})
        if(!prepared)return{kind:'empty',reason:'missing_source',degradedComponents:[]}
        queryContext.selectedScopeProof=prepared.proof;foreignSelected=prepared.resolved
      }
      const compileNow = new Date()
      const freshnessEpochDay = compileNow.toISOString().slice(0, 10)
      const freshnessAsOf = new Date(`${freshnessEpochDay}T00:00:00.000Z`)

      const inputDigest = createHash('sha256')
        .update([input.installationId, input.sessionId, input.clientRequestId,
          input.agent, input.adapterCapability, mode,
          repositoryId ?? '', repositoryId ? (input.branch ?? '') : '', minimizedQuery,
          settingsFingerprint.toString('hex'), loadoutFingerprint.toString('hex'),
          corpusFingerprint,
          generation,JSON.stringify(queryContext),
          JSON.stringify(selectedReferences),selectedReferences.length?'selected-reference-budget-v2':'',
          freshnessEpochDay,
        ].join('\n')+(input.evidenceReadCapability==='on_demand_v1'?'\nevidence-on-demand-v1':''))
        .digest()
      const run = await deps.generation.reserve({
        installationId: input.installationId,
        operation: 'compile_context',
        subjectKind: 'session',
        subjectKeyHash: createHash('md5').update(input.sessionId).digest(),
        inputDigest,
        effectivePolicyHash,
        policyVersionIds: [...policy.policyVersionIds, ...rankingPolicy.policyVersionIds],
      })
	  if (!run.owner) {
		if (run.state === 'succeeded' && run.outputKind === 'context_pack' && run.outputId) {
		  const stored = await deps.packs.get(run.outputId)
		  if (stored?.state === 'ready' && await lifecycleFrameCurrent(deps.pool,input.installationId,lifecycle) && (!queryContext.selectedScopeProof || await selectedScopeContextCurrent(deps.pool,queryContext.selectedScopeProof))) {
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
      const persona = selectedReferences.length || (!resolvedScope.repositoryKnown && policyDoc.unknown_repository_behavior === 'empty')
        ? [] : await deps.scope.personaVersions({ installationId: input.installationId })
      mark('reserve')
      // A native turn shares the daemon deadline with grant, admission and
      // consumption. Keep remote embedding off that synchronous path and
      // apply the configured degradation policy to the local retrieval pools.
      const retrieval = selectedReferences.length === 0 && (resolvedScope.repositoryKnown||lifecycle?.spaceId) && minimizedQuery.length > 0
        ? await deps.retrieval.retrieve({
        authorityGrant:input.authorityGrant,
            installationId: input.installationId,
            query: minimizedQuery,
            localOnly: mode === 'enabled',
            lifecycle,
            repositoryId,
            repoSnapshotId:queryContext.repoSnapshotId,taskScopeKey:queryContext.taskScopeKey,
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
      mark('retrieve')
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
      const selectedItemReferences=new Map<string,SelectedContextReference>()

      if (selectedReferences.length > 0) {
        const selected = foreignSelected ?? await resolveSelectedContextReferences(deps.pool, input.installationId, selectedReferences,queryContext)
        if (!selected) {
          await deps.generation.complete({ runId: run.runId, state: 'failed', errorCode: 'missing_source' })
          return { kind: 'empty', reason: 'missing_source', degradedComponents: [] }
        }
        for (const entry of selected) {
          const itemId=deterministicItemId([inputDigest.toString('hex'),entry.reference.installation_id,entry.reference.source_kind,entry.reference.source_id,entry.versionId])
          selectedItemReferences.set(itemId,entry.reference)
          if (entry.kind === 'wiki' || entry.reference.installation_id!==input.installationId) {
            externalItems.push({
              itemId,
              versionId: entry.versionId,
              statement: redactSensitive(entry.statement),
              scopeKind: entry.scopeKind,
              ownerScopeId:entry.reference.owner_scope_id,installationId:entry.reference.installation_id,
              section: 'stable',
              evidenceIds: entry.kind==='claim'?entry.evidenceIds:[],
            })
            continue
          }
          drafts.push({
            itemId,
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
          evidenceIds: [],
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
          evidenceIds: [],
          normalizedKey: `${candidate.claimType}:${candidate.claimId}`,
          rank: candidate.fusedScore,
        })
      }

      // Deduplicate by identity and near-identical text before budgeting.
      const versionIds = [...new Set(drafts.map(draft => draft.versionId))]
      const [facts, evidence] = await Promise.all([
        contextClaimFacts(deps.pool, input.installationId, versionIds),
        selectedReferences.length || !versionIds.length ? null : deps.pool.query<{ version_id: string; evidence_ids: string[] }>(`
          SELECT wanted.version_id::text, ARRAY(
            SELECT e.evidence_id::text FROM knowledge_evidence e
            WHERE e.installation_id=$1 AND e.version_id=wanted.version_id
            ORDER BY e.ordinal ASC LIMIT 4
          ) AS evidence_ids
          FROM unnest($2::uuid[]) AS wanted(version_id)
        `, [input.installationId, versionIds]),
      ])
      const evidenceByVersion = new Map(evidence?.rows.map(row => [row.version_id, row.evidence_ids]))
      const eligibleDrafts = drafts.filter(draft => {
        const source = facts.get(draft.versionId)
        // Recalled work methods require a Scene. Persona and explicit references
        // have their own selection rules.
        const needsScene = draft.claimType === 'work_method' && draft.layer === 'L2' && !selectedItemReferences.has(draft.itemId)
        return source && (!needsScene || (lifecycle?.consume && source.lifecycle?.spaceId))
          && eligibleContextFacts(source,queryContext)
      }).map(draft => ({ ...draft, evidenceIds: evidenceByVersion.get(draft.versionId) ?? draft.evidenceIds }))
      const deduped = dedupeItems(eligibleDrafts.map(draft => ({
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
      // Explicit external references share the same ceilings as owned items.
      // Account for rendered identifiers and the frozen stable-only footer.
      const boundedExternal=[...new Map(externalItems.map(item=>[item.itemId,item])).values()]
      const renderProbe:RenderItem={itemId:'',claimId:'',versionId:'',statement:'',scopeKind:'',section:'stable',evidenceIds:[]}
      const reserve=selectedReferences.length?estimateTokens(stableDynamicSplit(renderPackText({packId:'',stable:[renderProbe],dynamic:[]})).stable.slice(renderItemLine(renderProbe).length)):0
      const budget = applyTokenBudget({
        items: [
          ...deduped.map(draft => ({
            key: draft.itemId,section:draft.section,
            estimatedTokens: selectedReferences.length?estimateTokens(renderItemLine(draft))+1:estimateTokens(draft.statement),
            rank:draft.rank,pinned:pinnedVersions.has(draft.versionId),
          })),
          ...boundedExternal.map((item,index)=>({key:item.itemId,section:item.section,
            estimatedTokens:estimateTokens(renderItemLine({...item,claimId:item.itemId}))+1,rank:1000-index,pinned:false})),
        ],
        stableTokens:Math.max(0,stableTokens-reserve),
        dynamicTokens: Math.min(policyDoc.dynamic_tokens, Math.max(0, totalTokens - stableTokens)),
        maxItems: Math.min(policyDoc.max_items, 10),
      })
      const keptItems = deduped.filter(draft => budget.kept.includes(draft.itemId))
      const keptExternal=boundedExternal.filter(item=>budget.kept.includes(item.itemId))
      const keptReferences=new Set(budget.kept.map(id=>selectedItemReferences.get(id)).filter((r):r is SelectedContextReference=>!!r))
      const renderedReferences=selectedReferences.filter(reference=>keptReferences.has(reference))
      mark('assemble')

      try {
      if (keptItems.length === 0 && keptExternal.length === 0) {
        const emptyReason = budget.kept.length === 0 && (eligibleDrafts.length > 0 || boundedExternal.length > 0)
          ? 'token_budget' : 'no_candidates'
        const packId = await deps.packs.persist({
          installationId: input.installationId,
          authorityGrant:input.authorityGrant,
          queryContext,consumptionGeneration:generation,
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
          selectedReferences:renderedReferences,
          state: 'empty',
          errorCode: emptyReason,
        })
        mark('persist')
        void packId
        return {
          kind: 'empty',
          reason: emptyReason,
          degradedComponents: retrieval.degradedComponents,
        }
      }

      const { packId, stableTokens: storedStableTokens, dynamicTokens, evidenceProven } = await deps.packs.persistWithSummary({
        installationId: input.installationId,
        authorityGrant:input.authorityGrant,
        queryContext,consumptionGeneration:generation,
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
        externalItems:keptExternal,
        selectedReferences:renderedReferences,
        state: mode === 'enabled' ? 'ready' : 'shadow',
      })

      mark('persist')
      if (mode === 'shadow') return { kind: 'shadow', packId }
      return {
        kind: 'ready',
        packId,
        stableTokens: storedStableTokens,
        dynamicTokens,
        evidenceProven,
        itemCount: keptItems.length + keptExternal.length,
      }
      }catch(error){
        if(!(error instanceof ContextConsumptionChangedError))throw error
        await deps.generation.complete({runId:run.runId,state:'failed',errorCode:'context_consumption_changed'})
        return{kind:'degraded',reason:'context_consumption_changed'}
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
