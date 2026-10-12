import {createHash} from 'node:crypto'
import {wilsonInterval,evaluationClusters} from './quality-metrics.js'
export {wilsonInterval} from './quality-metrics.js'
import type pg from 'pg'
import { createSearchService, type SearchHit } from '../retrieval/search-service.js'
import type { GoldenCase, GoldenDataset } from './schema.js'
import type { EmbeddingProvider } from '../ports/embedding-provider.js'

/**
 * Deterministic Golden Set evaluator. Runs each case's query through the SAME
 * search service as REST/MCP with the case's allowed scope, then scores
 * Top-5 valid hits, evidence coverage, scope leakage, duplicate active
 * claims, latency and empty-result behavior. Output carries opaque ids and
 * aggregate metrics only — never raw private text.
 */

export interface EvalCaseResult {
  id: string
  top5ValidHit: boolean
  expectedClaimFoundAtRank: number | null
  evidenceCoverage: number
  scopeLeak: boolean
  duplicateActiveClaims: number
  latencyMs: number
  emptyResult: boolean
  degradedComponents: string[]
  currentVersionCorrect?:boolean|null
  evidenceSupport?:'supported'|'unsupported'|'ambiguous'|null
  estimatedContextTokens?:number
  embeddingTokens?:number
  costMicros?:number|null
  labelProvenance?:string|null
  reviewSeconds?:number|null
}

export interface EvalReport {
  datasetVersion: string
  runAt: string
  totalCases: number
  top5EvaluatedCases: number
  top5HitRate: number
  evidenceCoverageRate: number
  scopeLeakCount: number
  duplicateClaimCases: number
  emptyResultCases: number
  medianLatencyMs: number
  p95LatencyMs: number
  degradedCases: number
  reviewOutcomes: Record<string, number>
  cases: EvalCaseResult[]
  evaluatorVersion?:string
  datasetDigest?:string
  variant?:string
  quality?:ReturnType<typeof summarizeQuality>
  reuseAdvice?:Array<{claimId:string;advice:ReturnType<typeof reuseValueAdvice>}>
}

export interface EvalRunnerDeps {
  pool: pg.Pool
  recallEmbeddingTimeoutMs?: number
  cursorSigningKey: string
  embed?: EmbeddingProvider & { provider: string; model: string }
  embeddingConsentFingerprint?: string
  now?: () => number
  variant?:'memory_off'|'governance_v2'
}

export function createEvalRunner(deps: EvalRunnerDeps) {
  let embeddingTokens=0,costMicros:number|null=0
  const trackedEmbed=deps.embed?{provider:deps.embed.provider,model:deps.embed.model,dimensions:deps.embed.dimensions,
    embed:async(input:Parameters<EmbeddingProvider['embed']>[0])=>{
      try{const result=await deps.embed!.embed(input);embeddingTokens+=result.tokens
        costMicros=result.costMicros===undefined||costMicros===null?null:costMicros+result.costMicros
        return result
      }catch(error){costMicros=null;throw error}
    }}:undefined
  const search = createSearchService({
    pool: deps.pool,
    recallEmbeddingTimeoutMs: deps.recallEmbeddingTimeoutMs ?? 500,
    cursorSigningKey: deps.cursorSigningKey,
    ...(trackedEmbed ? { embed: trackedEmbed } : {}),
    ...(deps.embeddingConsentFingerprint
      ? { embeddingConsentFingerprint: deps.embeddingConsentFingerprint }
      : {}),
  })

  return {
    async run(dataset: GoldenDataset, limit = 5): Promise<EvalReport> {
      const caseResults: EvalCaseResult[] = []
      const reviewOutcomes: Record<string, number> = {}
      for (const item of dataset.cases) {
        embeddingTokens=0;costMicros=0
        const scored=await runCase(search,deps,item,limit)
        caseResults.push({...scored,embeddingTokens,costMicros})
        if (item.review_outcome) {
          reviewOutcomes[item.review_outcome] = (reviewOutcomes[item.review_outcome] ?? 0) + 1
        }
      }
      const feedback=await deps.pool.query<{claim_id:string;used:string;incorrect:string}>(`SELECT claim_id::text,
        count(*) FILTER(WHERE action='recall_used')::text AS used,count(*) FILTER(WHERE action='recall_incorrect')::text AS incorrect
        FROM memory_feedback WHERE installation_id=ANY($1::uuid[]) AND claim_id=ANY($2::uuid[]) GROUP BY claim_id`,
        [[...new Set(dataset.cases.map(c=>c.installation_id))],[...new Set(dataset.cases.flatMap(c=>c.expected.claim_ids))]])
      const reuseAdvice=feedback.rows.map(row=>({claimId:row.claim_id,advice:reuseValueAdvice({used:Number(row.used),incorrect:Number(row.incorrect),
        evidenceSupport:dataset.cases.some(item=>item.expected.claim_ids.includes(row.claim_id)&&item.label?.evidence_support==='supported'&&item.label.provenance!=='uncalibrated')?1:0,costMicros:null})})).sort((a,b)=>b.advice.reviewPriorityScore-a.advice.reviewPriorityScore||a.claimId.localeCompare(b.claimId))
      const latencies = caseResults.map(result => result.latencyMs).sort((a, b) => a - b)
      const positiveCaseResults = caseResults.filter((_, index) =>
        dataset.cases[index].expected.claim_ids.length > 0)
      const hit = positiveCaseResults.filter(result => result.top5ValidHit).length
      const covered = caseResults.map(result => result.evidenceCoverage)
      return {
        datasetVersion: dataset.dataset_version,
        evaluatorVersion:'memory-governance-eval-v2',datasetDigest:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
        reuseAdvice,
        variant:deps.variant??'governance_v2',quality:summarizeQuality(dataset,caseResults),
        runAt: new Date().toISOString(),
        totalCases: caseResults.length,
        top5EvaluatedCases: positiveCaseResults.length,
        top5HitRate: positiveCaseResults.length > 0 ? hit / positiveCaseResults.length : 0,
        evidenceCoverageRate: covered.length > 0
          ? covered.reduce((sum, value) => sum + value, 0) / covered.length
          : 0,
        scopeLeakCount: caseResults.filter(result => result.scopeLeak).length,
        duplicateClaimCases: caseResults.filter(result => result.duplicateActiveClaims > 0).length,
        emptyResultCases: caseResults.filter(result => result.emptyResult).length,
        medianLatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        degradedCases: caseResults.filter(result => result.degradedComponents.length > 0).length,
        reviewOutcomes,
        cases: caseResults,
      }
    },
  }
}

async function runCase(
  search: ReturnType<typeof createSearchService>,
  deps: EvalRunnerDeps,
  item: GoldenCase,
  limit: number,
): Promise<EvalCaseResult> {
  const started = deps.now?.() ?? Date.now()
  const result=deps.variant==='memory_off'?{hits:[],degradedComponents:[]}:await searchAllowedScopes(search,item,limit)
  const latencyMs = (deps.now?.() ?? Date.now()) - started

  const ranks = result.hits
    .map((hit, index) => ({ hit, rank: index + 1 }))
    .filter(entry => isValidExpectedHit(entry.hit, item))
  const bestRank = ranks.length > 0 ? Math.min(...ranks.map(entry => entry.rank)) : null

  // Gate coverage against every active current Version in the installation,
  // not only claims that happened to appear in this query's result set.
  const coverage = await deps.pool.query<{ total: string; covered: string }>(`
    WITH target_claims AS (
      SELECT claim_id
      FROM knowledge_claims
      WHERE installation_id = $1 AND state = 'active'
        AND current_version_id IS NOT NULL
      UNION
      SELECT unnest($2::uuid[]) AS claim_id
    )
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (
             WHERE c.state = 'active' AND c.current_version_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM knowledge_evidence e
                 WHERE e.installation_id = c.installation_id
                   AND e.version_id = c.current_version_id
               )
           )::text AS covered
    FROM target_claims t
    LEFT JOIN knowledge_claims c
      ON c.installation_id = $1 AND c.claim_id = t.claim_id
  `, [item.installation_id, item.expected.evidence_claim_ids])
  const totalRequired = Number(coverage.rows[0]?.total ?? '0')
  const coveredRequired = Number(coverage.rows[0]?.covered ?? '0')

  // Scope leakage: any hit outside the case's allowed repository/snapshot/
  // branch sets (when the case constrains them).
  const scopeLeak = result.hits.some(hit => isScopeLeak(hit, item.allowed))

  // Duplicate active claims sharing an identical normalized identity.
  const duplicates = await deps.pool.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM (
          SELECT claim_type, scope_key, normalized_key
          FROM knowledge_claims
          WHERE installation_id = $1 AND state = 'active'
          GROUP BY claim_type, scope_key, normalized_key HAVING COUNT(*) > 1
        ) d
      `, [item.installation_id])

  return {
    id: item.id,
    currentVersionCorrect:item.expected.current_version_ids?.length?
      result.hits.some(hit=>item.expected.claim_ids.includes(hit.claimId))&&result.hits.filter(hit=>item.expected.claim_ids.includes(hit.claimId)).every(hit=>item.expected.current_version_ids!.includes(hit.versionId)):null,
    evidenceSupport:item.label?.evidence_support??null,labelProvenance:item.label?.provenance??null,
    estimatedContextTokens:result.hits.reduce((sum,hit)=>sum+Math.ceil(hit.statement.length/4),0),reviewSeconds:item.label?.review_seconds??null,
    top5ValidHit: item.expected.claim_ids.length > 0
      ? bestRank !== null
      : result.hits.length === 0,
    expectedClaimFoundAtRank: bestRank,
    evidenceCoverage: totalRequired > 0 ? coveredRequired / totalRequired : 1,
    scopeLeak,
    duplicateActiveClaims: Number(duplicates.rows[0]?.count ?? '0'),
    latencyMs,
    emptyResult: result.hits.length === 0,
    degradedComponents: result.degradedComponents,
  }
}

async function searchAllowedScopes(
  search: ReturnType<typeof createSearchService>,
  item: GoldenCase,
  limit: number,
): Promise<{ hits: SearchHit[]; degradedComponents: string[] }> {
  const repositoryIds: Array<string | undefined> = item.allowed.repository_ids.length > 0
    ? [...new Set(item.allowed.repository_ids)]
    : [undefined]
  const snapshotIds: Array<string | undefined> = item.allowed.repo_snapshot_ids.length > 0
    ? [...new Set(item.allowed.repo_snapshot_ids)]
    : [undefined]
  const branches: Array<string | undefined> = item.allowed.branches.length > 0
    ? [...new Set(item.allowed.branches)]
    : [undefined]
  const accumulated = new Map<string, { hit: SearchHit; score: number }>()
  const degraded = new Set<string>()

  for (const repositoryId of repositoryIds) {
    for (const repoSnapshotId of snapshotIds) {
      for (const branch of branches) {
        const result = await search.search({
          installationId: item.installation_id,
          query: item.query,
          limit,
          ...(repositoryId ? { repositoryId } : {}),
          ...(repoSnapshotId ? { repoSnapshotId } : {}),
          ...(branch ? { branch } : {}),
        })
        for (const component of result.degradedComponents) degraded.add(component)
        for (const [index, hit] of result.hits.entries()) {
          const score = 1 / (60 + index + 1)
          const previous = accumulated.get(hit.versionId)
          if (previous) previous.score += score
          else accumulated.set(hit.versionId, { hit, score })
        }
      }
    }
  }

  return {
    hits: [...accumulated.values()]
      .sort((a, b) => b.score - a.score || (a.hit.versionId < b.hit.versionId ? -1 : 1))
      .slice(0, limit)
      .map(entry => entry.hit),
    degradedComponents: [...degraded].sort(),
  }
}

export function isScopeLeak(
  hit: { repositoryId: string | null; repoSnapshotId: string | null; branch: string | null },
  allowed: { repository_ids: readonly string[]; repo_snapshot_ids: readonly string[]; branches: readonly string[] },
): boolean {
  const repositorySet = new Set(allowed.repository_ids)
  const snapshotSet = new Set(allowed.repo_snapshot_ids)
  const branchSet = new Set(allowed.branches)
  if (repositorySet.size > 0 && (!hit.repositoryId || !repositorySet.has(hit.repositoryId))) return true
  if (snapshotSet.size > 0 && (!hit.repoSnapshotId || !snapshotSet.has(hit.repoSnapshotId))) return true
  if (branchSet.size > 0 && (!hit.branch || !branchSet.has(hit.branch))) return true
  return false
}

export function isValidExpectedHit(
  hit: { claimId: string; repositoryId: string | null; repoSnapshotId: string | null; branch: string | null },
  item: Pick<GoldenCase, 'expected' | 'allowed'>,
): boolean {
  return item.expected.claim_ids.includes(hit.claimId) && !isScopeLeak(hit, item.allowed)
}

/** Test-visible percentile helper (median/p95 over sorted values). */
export function percentileOf(sorted: number[], fraction: number): number {
  return percentile(sorted, fraction)
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))
  return sorted[index]
}

export function summarizeQuality(dataset:GoldenDataset,results:readonly EvalCaseResult[]){
 const holdout=dataset.cases.map((item,i)=>({item,result:results[i]})).filter(row=>row.item.split==='holdout'&&row.result)
 const eligible=holdout.filter(row=>row.item.label?.evidence_support!=='ambiguous'&&row.item.label?.provenance!=='uncalibrated')
 const groups=evaluationClusters(eligible.map(row=>row.item))
 const successes=groups.filter(group=>group.every(i=>eligible[i].result.top5ValidHit&&!eligible[i].result.scopeLeak
   &&eligible[i].result.currentVersionCorrect!==false)).length
 const labelled=holdout.filter(row=>!row.result.emptyResult&&row.item.label?.evidence_support!=='ambiguous'&&row.item.label?.provenance!=='uncalibrated')
 return{holdoutCases:holdout.length,correlationGroups:groups.length,groupSuccesses:successes,
   groupHitInterval95:wilsonInterval(successes,groups.length),
   partitions:Object.fromEntries(['suggestions','calibration','holdout'].map(split=>[split,dataset.cases.filter(c=>c.split===split).length])),
   evidenceSupportRate:labelled.length?labelled.filter(r=>r.item.label?.evidence_support==='supported'&&r.result.evidenceCoverage===1).length/labelled.length:null,
   currentVersionCorrectRate:holdout.filter(r=>r.result.currentVersionCorrect!==null).length?
     holdout.filter(r=>r.result.currentVersionCorrect===true).length/holdout.filter(r=>r.result.currentVersionCorrect!==null).length:null,
   scopeErrorRate:holdout.length?holdout.filter(r=>r.result.scopeLeak).length/holdout.length:null,
   ambiguousCases:holdout.filter(r=>r.item.label?.evidence_support==='ambiguous'||r.item.label?.provenance==='uncalibrated').length,
   labelProvenance:Object.fromEntries(['synthetic_curated','human_calibrated','uncalibrated'].map(label=>[label,dataset.cases.filter(c=>c.label?.provenance===label).length])),
   embeddingTokens:results.reduce((sum,r)=>sum+(r.embeddingTokens??0),0),
   costMicros:results.some(r=>r.costMicros===null)?null:results.reduce((sum,r)=>sum+(r.costMicros??0),0),
   reviewSeconds:results.some(r=>r.reviewSeconds===null)?null:results.reduce((sum,r)=>sum+(r.reviewSeconds??0),0),
   automaticAcceptanceEligible:false as const,calibrationTrust:'declared_labels_only' as const,
   baselineComparison:'NOT_RUN' as const,
 }
}

export function reuseValueAdvice(input:{used:number;incorrect:number;evidenceSupport:number;costMicros:number|null}){
 if(!Number.isInteger(input.used)||input.used<0||!Number.isInteger(input.incorrect)||input.incorrect<0
   ||!Number.isFinite(input.evidenceSupport)||input.evidenceSupport<0||input.evidenceSupport>1
   ||(input.costMicros!==null&&(!Number.isFinite(input.costMicros)||input.costMicros<0)))throw new Error('invalid_reuse_signal')
 const interval=wilsonInterval(input.used,input.used+input.incorrect),confidence=interval?.low??0
 const score=confidence*input.evidenceSupport/(1+(input.costMicros??0)/1000000)
 return{recommendation:input.incorrect>input.used?'needs_correction':input.used>=10&&confidence>.7&&input.evidenceSupport===1&&input.costMicros!==null?'reuse_candidate':'keep_reviewing',
   reviewPriorityScore:score,costKnown:input.costMicros!==null,basis:'observed_feedback' as const,automaticTraining:false,thresholdChanges:false}
}
