import { createHmac, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { createScopeAuthorization, type V2GrantFacts, type GrantScopeBinding } from '../governance/authorization.js'
import { loadSkillReviewPolicySnapshot } from './review-policy-binding.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { skillModeForScope } from './config.js'
import { resolveSkillSource, SkillWorkError, type SkillSourceContext, type SkillPrelockedLifecycle } from './source-resolver.js'
import { archiveSourceRequest, findSkillArchive, findSkillVersion, type SkillArchiveSource, type SkillVersionRow } from './version-repository.js'
import { assessSkillRisk } from './risk-policy.js'
import type { SkillCandidateDocument } from './types.js'
import type { SkillReplayCaseRegistry } from './replay-service.js'
import { ReplayCaseSchema, replayCaseHash } from './replay-runner.js'

export interface SkillIdentity { installationId: string; grant: V2GrantFacts }
export class SkillReadError extends Error {
  readonly statusCode: number
  constructor(readonly code: 'invalid_request'|'forbidden'|'not_found'|'feature_disabled') {
    super(code); this.statusCode = code === 'invalid_request' ? 400 : code === 'forbidden' ? 403 : code === 'not_found' ? 404 : 503
  }
}
export const SkillListQuerySchema = z.object({ repository_id: z.uuid().optional(), state: z.enum(['draft','reviewed','rejected','revoked']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(), cursor: z.string().min(1).max(2048).optional() }).strict()
type ListQuery = z.infer<typeof SkillListQuerySchema>
const fail = (code: ConstructorParameters<typeof SkillReadError>[0]): never => { throw new SkillReadError(code) }
export function skillJson(value: unknown): any {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(skillJson)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`),skillJson(v)]))
  return value
}
export function createSkillReadService(deps: { pool: pg.Pool; context: SkillSourceContext; cursorSigningKey: string; cases?: SkillReplayCaseRegistry }) {
  async function transaction<T>(body: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await deps.pool.connect()
    try { await client.query('BEGIN'); const result = await body(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function authorize(client: pg.PoolClient, identity: SkillIdentity) {
    const grant = await createScopeAuthorization(createTransactionBoundPool(client)).validateV2Grant(identity.grant)
    const binding = grant?.scopeBindings.find(b => b.installation_id === identity.installationId)
    if (!binding || !binding.permissions.includes('read')) return fail('forbidden')
    const scope = await client.query(`SELECT 1 FROM memory_owner_scopes WHERE installation_id=$1 AND state='active' AND authorization_epoch=$2`, [identity.installationId,binding.authorization_epoch])
    if (!scope.rowCount) return fail('forbidden')
    const mode = skillModeForScope(deps.context.globalMode,deps.context.config.mode,deps.context.sharedMode,binding.owner_scope_kind)
    if (mode === 'off') return fail('feature_disabled')
    return { binding, mode, auto_publish_mode: deps.context.config.autoPublishMode, canary_mode: deps.context.config.canaryMode }
  }
  /** Collect the whole bounded read set before taking any repository lock. Per-source
   * validation subsequently rejects provenance that would require a new lifecycle lock. */
  async function lockReadSources(client: pg.PoolClient, identity: SkillIdentity, archives: SkillArchiveSource[]): Promise<SkillPrelockedLifecycle> {
    const provenance = await client.query<{session_id:string;repository_id:string|null}>(`
      SELECT session_id,repository_id FROM work_episodes WHERE installation_id=$1 AND episode_id=ANY($2::uuid[])
      UNION SELECT e.session_id,e.repository_id FROM knowledge_evidence k JOIN work_episodes e USING(installation_id,episode_id)
        WHERE k.installation_id=$1 AND k.version_id=ANY($3::uuid[]) LIMIT 3201`,
      [identity.installationId,archives.filter(a=>a.source_kind==='episode').map(a=>a.episode_id),archives.filter(a=>a.source_kind==='claim_version').map(a=>a.claim_version_id)])
    if(provenance.rows.length>3200)return fail('not_found')
    const sessionIds=[...new Set(provenance.rows.map(r=>r.session_id))].sort()
    const repositoryIds=[...new Set([...archives.map(a=>a.repository_id),...provenance.rows.map(r=>r.repository_id).filter((id):id is string=>id!==null)])].sort()
    for(const session of sessionIds)await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2,0))`,[identity.installationId,session])
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`,[identity.installationId])
    for(const repository of repositoryIds)await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`,[identity.installationId,repository])
    return {sessionIds,repositoryIds}
  }
  async function source(client: pg.PoolClient, identity: SkillIdentity, archive: SkillArchiveSource, prelockedLifecycle?: SkillPrelockedLifecycle) {
    try {
      const resolved = await resolveSkillSource(client,{...identity,source:archiveSourceRequest(archive),requiredPermission:'read',...(prelockedLifecycle?{prelockedLifecycle}:{})},deps.context)
      if (resolved.sourceDigest !== archive.source_digest || resolved.inputDigest !== archive.input_digest) return fail('not_found')
      return resolved.sources.map(s => ({token:s.token,handle:s.handle,excerpt_hash:s.excerptHash,event_id:s.eventId,artifact_id:s.artifactId,evidence_id:s.evidenceId}))
    } catch (error) { if (error instanceof SkillWorkError) return fail(error.code === 'skill_forbidden' ? 'forbidden' : error.code === 'skill_disabled' ? 'feature_disabled' : 'not_found'); throw error }
  }
  async function policyCurrent(client: pg.PoolClient, identity: SkillIdentity, binding: GrantScopeBinding, version: SkillVersionRow) {
    return (await loadSkillReviewPolicySnapshot(client,identity.installationId,binding,{ensure:false})).hash === version.policy_hash
  }
  function permissions(binding: GrantScopeBinding, version: SkillVersionRow, current: boolean) {
    const usable = !['rejected','revoked'].includes(version.state)
    const self = version.author_id === (binding.membership_id ?? binding.owner_scope_id)
    return {can_edit:usable && binding.permissions.includes('contribute'),can_review:usable && current && binding.permissions.includes('review') && !(self && (version.risk !== 'low' || binding.owner_scope_kind !== 'personal')),
      can_replay:usable && current && binding.permissions.includes('review'),can_publish:false,can_revoke:usable && binding.permissions.includes('publish'),can_rollback:false,can_manage_policy:binding.permissions.includes('policy_admin')}
  }
  async function detail(client: pg.PoolClient, identity: SkillIdentity, skillId: string, prelockedLifecycle?: SkillPrelockedLifecycle) {
    const {binding,...mode} = await authorize(client,identity)
    const version = await findSkillVersion(client,identity.installationId,skillId)
    if (!version) return fail('not_found')
    const archive = await findSkillArchive(client,identity.installationId,version.candidate_id)
    if (!archive) return fail('not_found')
    const sources = await source(client,identity,archive,prelockedLifecycle)
    const current = await policyCurrent(client,identity,binding,version)
    const rows = await client.query(`SELECT version_id,version_number,document_hash,policy_hash,risk,created_at FROM memory_skill_versions WHERE installation_id=$1 AND skill_id=$2 ORDER BY version_number DESC LIMIT 50`,[identity.installationId,skillId])
    const summary = rows.rows.find(r => r.version_id === version.version_id)!
    const risk = assessSkillRisk(version.document)
    return {skill_id:skillId,version_id:version.version_id,version_number:summary.version_number,revision:Number(version.revision),state:version.state,
      title:version.document.title,risk:risk.risk,repository_id:archive.repository_id,repo_snapshot_id:archive.repo_snapshot_id,created_at:summary.created_at,
      document:version.document,document_hash:version.document_hash,source_digest:version.source_digest,archive_id:archive.archive_id,policy_hash:version.policy_hash,policy_current:current,
      risk_reasons:risk.risk === 'low' ? [] : [risk.risk === 'high' ? 'high_risk_operation' : 'unknown_tool_or_permission'],sources,versions:rows.rows,
      permissions:permissions(binding,version,current),...mode}
  }
  function cursorBinding(identity: SkillIdentity, query: ListQuery, kind: string) {
    return JSON.stringify([identity.installationId,query.repository_id ?? null,query.state ?? null,kind])
  }
  function decodeCursor(identity: SkillIdentity, query: ListQuery, kind: string): string | null {
    if (!query.cursor) return null
    try { const [data,signature,...rest] = query.cursor.split('.'); if (rest.length || !data || !signature) return fail('invalid_request')
      const wanted = createHmac('sha256',deps.cursorSigningKey).update(data).digest(); const actual = Buffer.from(signature,'base64url')
      if (actual.length !== wanted.length || !timingSafeEqual(actual,wanted)) return fail('invalid_request')
      const payload = z.object({binding:z.string(),after:z.uuid()}).strict().parse(JSON.parse(Buffer.from(data,'base64url').toString('utf8')))
      if (payload.binding !== cursorBinding(identity,query,kind)) return fail('invalid_request'); return payload.after
    } catch { return fail('invalid_request') }
  }
  function encodeCursor(identity: SkillIdentity, query: ListQuery, kind: string, after: string) {
    const data = Buffer.from(JSON.stringify({binding:cursorBinding(identity,query,kind),after})).toString('base64url')
    return `${data}.${createHmac('sha256',deps.cursorSigningKey).update(data).digest('base64url')}`
  }
  return {
    authorize: (identity: SkillIdentity) => transaction(client => authorize(client,identity)),
    get: (identity: SkillIdentity, skillId: string) => transaction(client => detail(client,identity,skillId)),
    async list(identity: SkillIdentity, raw: unknown, candidates = false) {
      const parsed = SkillListQuerySchema.safeParse(raw); if (!parsed.success) return fail('invalid_request')
      const query = parsed.data, kind = candidates ? 'candidates' : 'skills', after = decodeCursor(identity,query,kind), limit = query.limit ?? 20
      return transaction(async client => {
        const {binding,...mode} = await authorize(client,identity)
        const selected = await client.query<{id:string;created_at?:Date}>(candidates
          ? `SELECT c.candidate_id AS id,c.created_at FROM memory_skill_candidates c JOIN memory_skill_archives a USING(installation_id,archive_id) JOIN memory_skill_tasks t ON t.installation_id=c.installation_id AND t.task_id=c.task_id
             WHERE c.installation_id=$1 AND ($2::uuid IS NULL OR a.repository_id=$2) AND ($3::uuid IS NULL OR c.candidate_id>$3) AND c.state='candidate' AND c.generation=t.current_generation ORDER BY c.candidate_id LIMIT $4`
          : `SELECT s.skill_id AS id FROM memory_skills s JOIN memory_skill_heads h USING(installation_id,skill_id) JOIN memory_skill_tasks t USING(installation_id,task_id)
             WHERE s.installation_id=$1 AND ($2::uuid IS NULL OR t.repository_id=$2) AND ($3::uuid IS NULL OR s.skill_id>$3) AND ($5::text IS NULL OR h.state=$5) ORDER BY s.skill_id LIMIT $4`,
          candidates ? [identity.installationId,query.repository_id ?? null,after,limit+1] : [identity.installationId,query.repository_id ?? null,after,limit+1,query.state ?? null])
        const observedArchives:SkillArchiveSource[]=[]
        for(const row of selected.rows.slice(0,limit)) {
          const version=candidates?null:await findSkillVersion(client,identity.installationId,row.id)
          const candidateId=candidates?row.id:version?.candidate_id
          if(candidateId){const archive=await findSkillArchive(client,identity.installationId,candidateId);if(archive)observedArchives.push(archive)}
        }
        const lifecycle=await lockReadSources(client,identity,observedArchives)
        const items: unknown[] = []
        for (const row of selected.rows.slice(0,limit)) {
          await client.query('SAVEPOINT skill_read_item')
          try {
            if (candidates) {
              const archive = await findSkillArchive(client,identity.installationId,row.id); if (!archive) continue
              await source(client,identity,archive,lifecycle)
              const task=(await client.query('SELECT current_generation::text FROM memory_skill_tasks WHERE installation_id=$1 AND task_id=$2',[identity.installationId,archive.task_id])).rows[0]
              if(archive.candidate_state!=='candidate'||task?.current_generation!==archive.generation)continue
              const head = (await client.query(`SELECT h.revision::text,h.state,v.candidate_id FROM memory_skill_heads h JOIN memory_skills s USING(installation_id,skill_id) JOIN memory_skill_versions v ON v.installation_id=h.installation_id AND v.version_id=h.current_version_id WHERE s.installation_id=$1 AND s.task_id=$2`,[identity.installationId,archive.task_id])).rows[0]
              const risk = assessSkillRisk(archive.document)
              items.push({candidate_id:row.id,created_at:row.created_at,task_id:archive.task_id,generation:Number(archive.generation),archive_id:archive.archive_id,document:archive.document,repository_id:archive.repository_id,risk:risk.risk,risk_reasons:risk.risk==='low'?[]:['manual_review_required'],expected_revision:Number(head?.revision ?? 0),can_draft:binding.permissions.includes('contribute')&&!['rejected','revoked'].includes(head?.state)&&head?.candidate_id!==row.id})
            } else {
              const d = await detail(client,identity,row.id,lifecycle)
              if(query.state&&d.state!==query.state)continue
              items.push({skill_id:d.skill_id,version_id:d.version_id,version_number:d.version_number,revision:d.revision,state:d.state,title:d.title,risk:d.risk,repository_id:d.repository_id,created_at:d.created_at})
            }
            await client.query('RELEASE SAVEPOINT skill_read_item')
          } catch (error) { await client.query('ROLLBACK TO SAVEPOINT skill_read_item'); if (!(error instanceof SkillReadError) || error.code !== 'not_found') throw error }
        }
        await authorize(client,identity)
        return {items,next_cursor:selected.rows.length>limit ? encodeCursor(identity,query,kind,selected.rows[limit-1]!.id) : null,...mode}
      })
    },
    async archive(identity: SkillIdentity, skillId: string) { return transaction(async client => {
      const d = await detail(client,identity,skillId)
      const row = (await client.query(`SELECT task_id,generation::text,candidate_key,policy_version,repository_id,repo_snapshot_id,source_kind,source_digest,document_hash,generated_at,content_hash,input_digest,document FROM memory_skill_archives WHERE installation_id=$1 AND archive_id=$2`,[identity.installationId,d.archive_id])).rows[0]
      return {archive_id:d.archive_id,...row,sources:d.sources}
    }) },
    async diff(identity: SkillIdentity, skillId: string, from: string, to: string) { return transaction(async client => {
      await authorize(client,identity)
      const current=await findSkillVersion(client,identity.installationId,skillId)
      if(!current)return fail('not_found')
      const observed=await client.query<{candidate_id:string}>(`SELECT candidate_id FROM memory_skill_versions WHERE installation_id=$1 AND skill_id=$2 AND version_id=ANY($3::uuid[])`,[identity.installationId,skillId,[from,to,current.version_id]])
      const archives:SkillArchiveSource[]=[]
      for(const row of observed.rows){const archive=await findSkillArchive(client,identity.installationId,row.candidate_id);if(archive)archives.push(archive)}
      const lifecycle=await lockReadSources(client,identity,archives)
      await detail(client,identity,skillId,lifecycle)
      const versions = await client.query<{version_id:string;document:SkillCandidateDocument;candidate_id:string}>(`SELECT version_id,document,candidate_id FROM memory_skill_versions WHERE installation_id=$1 AND skill_id=$2 AND version_id=ANY($3::uuid[])`,[identity.installationId,skillId,[from,to]])
      const a = versions.rows.find(v=>v.version_id===from),b=versions.rows.find(v=>v.version_id===to); if (!a || !b) return fail('not_found')
      for (const v of versions.rows) { const archive=await findSkillArchive(client,identity.installationId,v.candidate_id); if (!archive) return fail('not_found'); await source(client,identity,archive,lifecycle) }
      return {from_version_id:from,to_version_id:to,changes:Object.keys(a.document).filter(k=>JSON.stringify(a.document[k as keyof SkillCandidateDocument])!==JSON.stringify(b.document[k as keyof SkillCandidateDocument])).map(field=>({field,before:a.document[field as keyof SkillCandidateDocument],after:b.document[field as keyof SkillCandidateDocument]}))}
    }) },
    async replay(identity: SkillIdentity, skillId: string) { return transaction(async client => {
      const d=await detail(client,identity,skillId)
      const run=(await client.query(`SELECT run_id,state,error_code,head_revision::text FROM memory_skill_replay_runs WHERE installation_id=$1 AND skill_id=$2 AND version_id=$3 AND policy_hash=$4 ORDER BY sequence DESC LIMIT 1`,[identity.installationId,skillId,d.version_id,d.policy_hash])).rows[0]
      const counts=()=>({total:0,pending:0,passed:0,failed:0,cancelled:0})
      const kinds={historical_session:counts(),golden_task:counts()},provenance={fixture:0,recorded:0}
      let evidenceCurrent=d.policy_current && Number(run?.head_revision)===d.revision
      if (run) { const rows=await client.query(`SELECT case_id,input_hash,kind,provenance,state FROM memory_skill_replay_cases WHERE installation_id=$1 AND run_id=$2 LIMIT 32`,[identity.installationId,run.run_id])
        for(const c of rows.rows) { const k=kinds[c.kind as keyof typeof kinds]; k.total++; k[c.state as 'passed']++; provenance[c.provenance as keyof typeof provenance]++ }
        const raw=deps.cases ? await deps.cases.loadCases({installationId:identity.installationId,repositoryId:d.repository_id,repoSnapshotId:d.repo_snapshot_id,versionId:d.version_id,documentHash:d.document_hash,policyHash:d.policy_hash,caseIds:rows.rows.map(c=>c.case_id)}) : []
        const current= z.array(ReplayCaseSchema).max(32).safeParse(raw)
        evidenceCurrent=evidenceCurrent && current.success && current.data.length===rows.rows.length && rows.rows.length>0
        if(current.success)for(const c of current.data) {
          const recorded=rows.rows.find(r=>r.case_id===c.case_id)
          if(!recorded || recorded.input_hash!==replayCaseHash(c))evidenceCurrent=false
          if(c.kind==='historical_session') {
            const alive=await client.query(`SELECT 1 FROM source_sessions s JOIN work_episodes e USING(installation_id,session_id) WHERE s.installation_id=$1 AND s.session_id=$2 AND s.deleted_at IS NULL AND e.repository_id=$3 AND e.repo_snapshot_id=$4 AND e.state='ready' AND e.outcome='completed' AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id)`,[identity.installationId,c.reference_id,d.repository_id,d.repo_snapshot_id])
            if(!alive.rowCount)evidenceCurrent=false
          }
        }
      }
      return {run_id:run?.run_id??null,state:run?.state??'not_run',error_code:run && !evidenceCurrent?'evidence_stale':run?.error_code??null,evidence_current:!!run&&evidenceCurrent,eligible:evidenceCurrent&&run?.state==='passed'&&kinds.historical_session.total>0&&kinds.golden_task.total>0&&Object.values(kinds).every(k=>k.total===k.passed),natural_execution_count:0,kinds,provenance}
    }) },
    async resolve(identity: SkillIdentity, skillId: string) { const d=await transaction(client=>detail(client,identity,skillId)); if(d.state!=='reviewed'||!d.policy_current)return fail('not_found'); return {...d,eligible:false,execution_allowed:false,reason_codes:['product_gate_closed']} },
  }
}
