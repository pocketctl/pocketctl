import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { redactSecrets } from '../episodes/content-policy.js'
import { appendSkillAudit, type SkillAuditInput } from './audit-repository.js'
import { loadSkillReviewPolicySnapshot } from './review-policy-binding.js'
import { resolveSkillSource, SkillWorkError, type SkillSourceContext } from './source-resolver.js'
import { archiveSourceRequest, findSkillArchive, findSkillVersion, type SkillArchiveSource, type SkillVersionRow } from './version-repository.js'
import { ReplayCaseSchema, ReplayInputError, SKILL_REPLAY_RUNNER_VERSION, replayCaseHash, replayTextHash,
  runRecordedReplayCase, type ReplayCase, type ReplayCaseResult, type SkillReplayRunner } from './replay-runner.js'

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const Subject = z.object({ skillId: z.uuid(), versionId: z.uuid(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1) }).strict()
const Request = Subject.extend({ caseIds: z.array(identifier).min(1).max(32).refine(ids => new Set(ids).size === ids.length), idempotencyKey: identifier }).strict()
type SubjectInput = z.infer<typeof Subject>
type RequestInput = z.infer<typeof Request>
type Identity = { installationId: string; grant: V2GrantFacts }
type ErrorCode = Extract<SkillAuditInput['code'], 'invalid_request' | 'forbidden' | 'not_found' | 'version_conflict' | 'policy_changed'
  | 'source_invalid' | 'case_invalid' | 'feature_disabled' | 'lease_lost' | 'runner_failed' | 'replay_cancelled'>
export class SkillReplayError extends Error {
  readonly statusCode: number
  constructor(readonly code: ErrorCode) {
    super(code); this.name = 'SkillReplayError'
    this.statusCode = code === 'forbidden' ? 403 : code === 'not_found' ? 404
      : ['invalid_request','case_invalid'].includes(code) ? 400 : code === 'feature_disabled' ? 503 : 409
  }
}
function fail(code: ErrorCode): never { throw new SkillReplayError(code) }
const domainError = (error: unknown): SkillReplayError => error instanceof SkillReplayError ? error
  : error instanceof SkillWorkError ? new SkillReplayError(error.code === 'skill_forbidden' ? 'forbidden' : error.code === 'skill_disabled' ? 'feature_disabled' : 'source_invalid')
    : new SkillReplayError(error instanceof ReplayInputError && error.code === 'replay_aborted' ? 'replay_cancelled' : 'runner_failed')
interface Prepared { version: SkillVersionRow; archive: SkillArchiveSource }
interface RunRow { run_id: string; state: 'running' | 'passed' | 'failed' | 'cancelled'; input_hash: string; attempt: number; lease_token: string; live: boolean; error_code: string | null }
interface CaseRow { case_id: string; kind: ReplayCase['kind']; provenance: ReplayCase['provenance']; state: 'pending' | 'passed' | 'failed' | 'cancelled' }
const counts = () => ({ total: 0, pending: 0, passed: 0, failed: 0, cancelled: 0 })
export interface SkillReplayEvidence {
  runId: string | null; state: RunRow['state'] | 'not_run'; eligible: boolean; errorCode: string | null
  naturalExecutionCount: 0; provenance: { fixture: number; recorded: number }
  kinds: { historical_session: ReturnType<typeof counts>; golden_task: ReturnType<typeof counts> }
}
export interface SkillReplayCaseRegistry {
  loadCases(input: { installationId: string; repositoryId: string; repoSnapshotId: string; versionId: string;
    documentHash: string; policyHash: string; caseIds: string[] }): Promise<unknown[]>
}

/** Internal offline boundary: the caller supplies case IDs, never tool responses or success labels. */
export function createSkillReplayService(deps: { pool: pg.Pool; context: SkillSourceContext; cases: SkillReplayCaseRegistry; runner?: SkillReplayRunner }) {
  const runner = deps.runner ?? { version: SKILL_REPLAY_RUNNER_VERSION, run: runRecordedReplayCase }
  if (runner.version !== SKILL_REPLAY_RUNNER_VERSION) throw new Error('unsupported_skill_replay_runner')
  async function transaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect()
    try { await client.query('BEGIN'); const result = await body(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function prepare(identity: Identity, request: SubjectInput): Promise<Prepared> {
    const auth = createScopeAuthorization(deps.pool), grant = await auth.validateV2Grant(identity.grant)
    if (!grant || !auth.hasPermission(grant, identity.installationId, 'review')) fail('forbidden')
    const version = await findSkillVersion(deps.pool, identity.installationId, request.skillId)
    if (!version) fail('not_found')
    checkVersion(version, request)
    const archive = await findSkillArchive(deps.pool, identity.installationId, version.candidate_id)
    if (!archive) fail('source_invalid')
    return { version, archive }
  }
  function checkVersion(version: SkillVersionRow | null, request: SubjectInput): asserts version is SkillVersionRow {
    if (!version || version.version_id !== request.versionId || Number(version.revision) !== request.expectedRevision
      || !['draft','reviewed'].includes(version.state)) fail('version_conflict')
  }
  async function loadCases(identity: Identity, prepared: Prepared, caseIds: string[]): Promise<ReplayCase[]> {
    const { version: v, archive: a } = prepared
    const raw = await deps.cases.loadCases({ installationId: identity.installationId, repositoryId: a.repository_id,
      repoSnapshotId: a.repo_snapshot_id, versionId: v.version_id, documentHash: v.document_hash, policyHash: v.policy_hash, caseIds: [...caseIds] })
    const parsed = z.array(ReplayCaseSchema).max(32).safeParse(raw)
    if (!parsed.success || parsed.data.length !== caseIds.length || new Set(parsed.data.map(c => c.case_id)).size !== caseIds.length) fail('case_invalid')
    const serialized = canonicalJsonString(parsed.data)
    if (serialized.length > 256_000 || redactSecrets(serialized) !== serialized) fail('case_invalid')
    const cases: ReplayCase[] = JSON.parse(serialized)
    if (cases.some(c => !caseIds.includes(c.case_id) || c.installation_id !== identity.installationId || c.repository_id !== a.repository_id
      || c.repo_snapshot_id !== a.repo_snapshot_id || c.version_id !== v.version_id || c.document_hash !== v.document_hash || c.policy_hash !== v.policy_hash)) fail('case_invalid')
    return cases.sort((a, b) => a.case_id.localeCompare(b.case_id))
  }
  function inputHash(prepared: Prepared, cases: ReplayCase[], request: SubjectInput): string {
    return replayTextHash(canonicalJsonString({ ...request, sourceDigest: prepared.version.source_digest,
      policyHash: prepared.version.policy_hash, runnerVersion: runner.version, cases: cases.map(c => [c.case_id, replayCaseHash(c)]) }))
  }
  async function lockContext(client: pg.PoolClient, identity: Identity, prepared: Prepared, request: SubjectInput, cases: ReplayCase[]) {
    const archive = prepared.archive
    const sessions = [...new Set(cases.filter(c => c.kind === 'historical_session').map(c => c.reference_id))].sort()
    const source = await resolveSkillSource(client, { ...identity, source: archiveSourceRequest(archive), requiredPermission: 'review', additionalSessionIds: sessions }, deps.context)
    if (source.sourceDigest !== archive.source_digest || source.inputDigest !== archive.input_digest) fail('source_invalid')
    for (const sessionId of sessions) {
      const history = await client.query(`SELECT 1 FROM source_sessions s JOIN work_episodes e USING(installation_id,session_id)
        WHERE s.installation_id=$1 AND s.session_id=$2 AND s.deleted_at IS NULL
          AND e.repository_id=$3 AND e.repo_snapshot_id=$4 AND e.state='ready' AND e.outcome='completed'
          AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id)
        FOR SHARE OF s,e`, [identity.installationId,sessionId,archive.repository_id,archive.repo_snapshot_id])
      if (!history.rowCount) fail('source_invalid')
    }
    await client.query(`SELECT 1 FROM memory_skill_tasks WHERE installation_id=$1 AND task_id=$2 FOR UPDATE`, [identity.installationId,archive.task_id])
    const version = await findSkillVersion(client, identity.installationId, request.skillId, true)
    checkVersion(version, request)
    const grant = await createScopeAuthorization(createTransactionBoundPool(client)).validateV2Grant(identity.grant)
    const binding = grant?.scopeBindings.find(b => b.installation_id === identity.installationId)
    if (!binding || !binding.permissions.includes('review')) fail('forbidden')
    if ((await loadSkillReviewPolicySnapshot(client, identity.installationId, binding)).hash !== version.policy_hash) fail('policy_changed')
    return binding.owner_scope_kind === 'personal' ? { actorKind: 'personal' as const, actorId: binding.owner_scope_id }
      : { actorKind: 'membership' as const, actorId: binding.membership_id! }
  }
  async function summary(client: Pick<pg.PoolClient, 'query'>, identity: Identity, run: RunRow | null): Promise<SkillReplayEvidence> {
    const result: SkillReplayEvidence = { runId: run?.run_id ?? null, state: run?.state ?? 'not_run', eligible: false,
      errorCode: run?.error_code ?? null, naturalExecutionCount: 0, provenance: { fixture: 0, recorded: 0 },
      kinds: { historical_session: counts(), golden_task: counts() } }
    if (!run) return result
    const rows = await client.query<CaseRow>(`SELECT case_id,kind,provenance,state FROM memory_skill_replay_cases WHERE installation_id=$1 AND run_id=$2`, [identity.installationId,run.run_id])
    for (const c of rows.rows) { result.kinds[c.kind].total++; result.kinds[c.kind][c.state]++; result.provenance[c.provenance]++ }
    result.eligible = run.state === 'passed' && Object.values(result.kinds).every(c => c.total > 0 && c.passed === c.total)
    return result
  }
  async function cancel(client: pg.PoolClient, identity: Identity, runId: string, token: string, code: string) {
    const owned = await client.query(`SELECT 1 FROM memory_skill_replay_runs WHERE installation_id=$1 AND run_id=$2 AND lease_token=$3 AND state='running' FOR UPDATE`, [identity.installationId,runId,token])
    if (!owned.rowCount) return
    await client.query(`UPDATE memory_skill_replay_cases SET state='cancelled',error_code=$3 WHERE installation_id=$1 AND run_id=$2 AND state='pending'`, [identity.installationId,runId,code])
    await client.query(`UPDATE memory_skill_replay_runs SET state='cancelled',error_code=$3,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2`, [identity.installationId,runId,code])
  }
  async function auditDenied(identity: Identity, request: SubjectInput | undefined, error: SkillReplayError) {
    await appendSkillAudit(deps.pool, { installationId: identity.installationId, actorKind: null, actorId: null,
      action: 'replay', outcome: 'denied', skillId: request?.skillId ?? null, versionId: request?.versionId ?? null,
      revision: request?.expectedRevision ?? null, code: error.code })
  }
  return {
    async execute(identity: Identity, rawRequest: unknown, signal: AbortSignal = new AbortController().signal): Promise<SkillReplayEvidence> {
      let request: RequestInput | undefined, owned: { runId: string; token: string } | undefined
      try {
        const parsed = Request.safeParse(rawRequest)
        if (!parsed.success) fail('invalid_request')
        request = parsed.data
        if (signal.aborted) fail('replay_cancelled')
        const subject = Subject.parse({ skillId: request.skillId, versionId: request.versionId, expectedRevision: request.expectedRevision })
        const prepared = await prepare(identity, subject), cases = await loadCases(identity, prepared, request.caseIds)
        const hash = inputHash(prepared, cases, subject), token = randomUUID()
        const start = await transaction(async client => {
          const actor = await lockContext(client, identity, prepared, subject, cases)
          const prior = (await client.query<RunRow>(`SELECT *,lease_expires_at>clock_timestamp() AS live FROM memory_skill_replay_runs
            WHERE installation_id=$1 AND skill_id=$2 AND idempotency_key=$3 FOR UPDATE`, [identity.installationId,subject.skillId,request!.idempotencyKey])).rows[0]
          if (prior) {
            if (prior.input_hash !== hash) fail('case_invalid')
            if (prior.state !== 'running' || prior.live) return { evidence: await summary(client, identity, prior) }
            if (prior.attempt >= 3) {
              await cancel(client, identity, prior.run_id, prior.lease_token, 'attempts_exhausted')
              return { evidence: await summary(client, identity, { ...prior, state: 'cancelled', error_code: 'attempts_exhausted' }) }
            }
            await client.query(`UPDATE memory_skill_replay_runs SET attempt=attempt+1,lease_token=$3,lease_expires_at=clock_timestamp()+interval '30 seconds'
              WHERE installation_id=$1 AND run_id=$2`, [identity.installationId,prior.run_id,token])
            return { runId: prior.run_id }
          }
          const runId = randomUUID(), { archive: a, version: v } = prepared
          await client.query(`INSERT INTO memory_skill_replay_runs(run_id,installation_id,skill_id,version_id,repository_id,repo_snapshot_id,
            head_revision,idempotency_key,document_hash,source_digest,policy_hash,input_hash,runner_version,actor_kind,actor_id,state,lease_token,lease_expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'running',$16,clock_timestamp()+interval '30 seconds')`,
          [runId,identity.installationId,subject.skillId,subject.versionId,a.repository_id,a.repo_snapshot_id,subject.expectedRevision,request!.idempotencyKey,
            v.document_hash,v.source_digest,v.policy_hash,hash,runner.version,actor.actorKind,actor.actorId,token])
          for (const c of cases) await client.query(`INSERT INTO memory_skill_replay_cases(installation_id,run_id,case_id,kind,provenance,reference_id,session_id,input_hash)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [identity.installationId,runId,c.case_id,c.kind,c.provenance,c.reference_id,c.kind === 'historical_session' ? c.reference_id : null,replayCaseHash(c)])
          await appendSkillAudit(client, { installationId: identity.installationId, ...actor, action: 'replay', outcome: 'allowed',
            skillId: subject.skillId, versionId: subject.versionId, revision: subject.expectedRevision, code: 'ok' })
          return { runId }
        })
        if (start.evidence) return start.evidence
        owned = { runId: start.runId!, token }
        const results: ReplayCaseResult[] = []
        const runSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        for (const replayCase of cases) {
          runSignal.throwIfAborted()
          // Port receives copies: a runner cannot mutate the identity used for the completion fence.
          const input = { replayCase: structuredClone(replayCase), document: structuredClone(prepared.version.document), installationId: identity.installationId,
            repositoryId: prepared.archive.repository_id, repoSnapshotId: prepared.archive.repo_snapshot_id, versionId: subject.versionId, policyHash: prepared.version.policy_hash }
          const result = await new Promise<ReplayCaseResult>((resolve, reject) => {
            const abort = () => reject(new SkillReplayError('replay_cancelled'))
            runSignal.addEventListener('abort', abort, { once: true })
            runner.run(input, runSignal).then(resolve, reject).finally(() => runSignal.removeEventListener('abort', abort))
          })
          // Compare deterministic assertions, not a port-supplied success boolean.
          const expected = await runRecordedReplayCase({ ...input, replayCase, document: prepared.version.document }, runSignal)
          if (canonicalJsonString(result) !== canonicalJsonString(expected)) fail('runner_failed')
          results.push(expected)
        }
        const refreshed = await loadCases(identity, prepared, request.caseIds)
        if (inputHash(prepared, refreshed, subject) !== hash) fail('case_invalid')
        return await transaction(async client => {
          const actor = await lockContext(client, identity, prepared, subject, cases)
          if (runSignal.aborted) fail('replay_cancelled')
          const run = (await client.query<RunRow>(`SELECT *,lease_expires_at>clock_timestamp() AS live FROM memory_skill_replay_runs
            WHERE installation_id=$1 AND run_id=$2 FOR UPDATE`, [identity.installationId,owned!.runId])).rows[0]
          if (!run || run.state !== 'running' || run.lease_token !== token || !run.live) fail('lease_lost')
          for (const result of results) {
            const updated = await client.query(`UPDATE memory_skill_replay_cases SET state=$4,error_code=$5,assertion_results=$6::jsonb
              WHERE installation_id=$1 AND run_id=$2 AND case_id=$3 AND state='pending' AND input_hash=$7`,
            [identity.installationId,run.run_id,result.caseId,result.state,result.errorCode,JSON.stringify(result.assertions),result.inputHash])
            if (updated.rowCount !== 1) fail('lease_lost')
          }
          const bothKinds = (['historical_session','golden_task'] as const).every(kind => results.some(r => r.kind === kind))
          const passed = bothKinds && results.every(r => r.state === 'passed')
          const state = passed ? 'passed' : 'failed', errorCode = passed ? 'ok' : bothKinds ? 'assertion_failed' : 'missing_case_kind'
          const updated = await client.query(`UPDATE memory_skill_replay_runs SET state=$4,error_code=$5,lease_expires_at=NULL,completed_at=clock_timestamp()
            WHERE installation_id=$1 AND run_id=$2 AND lease_token=$3 AND state='running' AND lease_expires_at>clock_timestamp()`,
          [identity.installationId,run.run_id,token,state,errorCode])
          if (updated.rowCount !== 1) fail('lease_lost')
          await appendSkillAudit(client, { installationId: identity.installationId, ...actor, action: 'replay', outcome: 'allowed',
            skillId: subject.skillId, versionId: subject.versionId, revision: subject.expectedRevision, code: passed ? 'ok' : 'replay_failed' })
          return summary(client, identity, { ...run, state, error_code: errorCode })
        })
      } catch (error) {
        const domain = signal.aborted ? new SkillReplayError('replay_cancelled') : domainError(error)
        if (owned) await transaction(client => cancel(client, identity, owned!.runId, owned!.token, domain.code))
        await auditDenied(identity, request, domain)
        throw domain
      }
    },
    async getEvidence(identity: Identity, rawRequest: unknown): Promise<SkillReplayEvidence> {
      const parsed = Subject.safeParse(rawRequest)
      if (!parsed.success) fail('invalid_request')
      const request = parsed.data
      try {
        const prepared = await prepare(identity, request)
        const observed = (await deps.pool.query<RunRow>(`SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND skill_id=$2 ORDER BY sequence DESC LIMIT 1`, [identity.installationId,request.skillId])).rows[0] ?? null
        const ids = observed ? (await deps.pool.query<{ case_id: string }>(`SELECT case_id FROM memory_skill_replay_cases WHERE installation_id=$1 AND run_id=$2 ORDER BY case_id`, [identity.installationId,observed.run_id])).rows.map(c => c.case_id) : []
        const cases = observed ? await loadCases(identity, prepared, ids) : []
        return await transaction(async client => {
          await lockContext(client, identity, prepared, request, cases)
          const latest = (await client.query<RunRow>(`SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND skill_id=$2 ORDER BY sequence DESC LIMIT 1 FOR SHARE`, [identity.installationId,request.skillId])).rows[0] ?? null
          if (latest?.run_id !== observed?.run_id) fail('version_conflict')
          if (latest && latest.input_hash !== inputHash(prepared, cases, request)) fail('case_invalid')
          return summary(client, identity, latest)
        })
      } catch (error) { const domain = domainError(error); await auditDenied(identity, request, domain); throw domain }
    },
  }
}
