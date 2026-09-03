import type pg from 'pg'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { requireGitPermission, type GitPermission } from './authorization.js'
import { createGitRepository, type GitConnection, type GitTargetRegistry } from './repository.js'
import { createGitExportService, type RegisteredGitBaseContext } from './export-service.js'
import type { GitQueueDeps } from './inbox-service.js'
import type { AssetSnapshot, SkillAsset } from './types.js'
import { snapshotDigest } from './merge.js'
import { MemoryApiError } from '../api/errors.js'
import { createGitImportService } from './import-service.js'
import { requireCanonicalImportRun, type ImportProposalRow } from './governance-adapter.js'

export interface GitIdentity { installationId: string; grant: V2GrantFacts }
export type GitReadDeps = GitQueueDeps & Partial<Pick<Parameters<typeof createGitExportService>[0], 'keys'>> & Pick<Parameters<typeof createGitExportService>[0], 'skill'> & { targets: GitTargetRegistry }
export const GitListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.uuid().optional() }).strict()
const errorCodes = {
  invalid_request:400, signature_invalid:400, forbidden:403, not_found:404, conflict:409,
  source_invalid:409, policy_changed:409, authorization_stale:409, size_limit:413,
  budget_limit:429, feature_disabled:503, external_write_disabled:503, internal_error:500,
} as const
export class GitApiError extends Error {
  constructor(readonly code: keyof typeof errorCodes) { super(code) }
  get statusCode() { return errorCodes[this.code] }
}
export function gitApiError(error: unknown): GitApiError {
  if (error instanceof GitApiError) return error
  if(error instanceof MemoryApiError&&['unauthorized','forbidden'].includes(error.code))return new GitApiError('forbidden')
  const code = error instanceof Error ? error.message : ''
  if (error instanceof z.ZodError || ['git_invalid_request','git_target_unregistered'].includes(code)) return new GitApiError('invalid_request')
  if (['git_forbidden','forbidden','unauthorized'].includes(code)) return new GitApiError('forbidden')
  if (['git_not_found','git_export_unregistered'].includes(code)) return new GitApiError('not_found')
  if (code === 'webhook_invalid') return new GitApiError('signature_invalid')
  if (['git_feature_disabled','git_connection_disabled','read_not_authorized'].includes(code)) return new GitApiError('feature_disabled')
  if (code === 'external_write_disabled') return new GitApiError('external_write_disabled')
  if (code === 'git_authorization_stale') return new GitApiError('authorization_stale')
  if (code === 'git_policy_changed') return new GitApiError('policy_changed')
  if (['git_generation_conflict','git_revision_conflict','git_event_collision','git_input_changed','git_resolution_conflict','git_proposal_terminal'].includes(code)) return new GitApiError('conflict')
  if (['git_poll_too_soon','request_budget_exceeded','failure_budget_exceeded'].includes(code)) return new GitApiError('budget_limit')
  if (['git_source_limit','size_limit','file_limit'].includes(code)) return new GitApiError('size_limit')
  if (/^(?:git_|skill_|source_|attestation_|base_|immutable_|unmanaged_|invalid_)/.test(code)) return new GitApiError('source_invalid')
  return new GitApiError('internal_error')
}
export function publicGitVersion(snapshot: AssetSnapshot) {
  const a=snapshot.asset
  return { key:a.key, revision:a.baseRevision, version_id:a.baseVersionId, path:a.path,
    content_hash:snapshot.contentHash, source_digest:a.sourceDigest, deleted:snapshot.deleted, editable:a.editable }
}
export function createGitReadService(deps: GitReadDeps) {
  const repository=createGitRepository(deps)
  async function transaction<T>(id:GitIdentity, permission:GitPermission, action:(client:pg.PoolClient)=>Promise<T>) {
    const client=await deps.pool.connect()
    try {await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await requireGitPermission(client,id.grant,id.installationId,permission)
      const result=await action(client);await requireGitPermission(client,id.grant,id.installationId,permission);await client.query('COMMIT');return result}
    catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  const authorize=(id:GitIdentity,permission:GitPermission='read')=>transaction(id,permission,async()=>undefined)
  const mode=async(c:GitConnection)=>{const modes=[deps.config.mode,c.syncMode,await deps.scopeMode(c)];return c.state!=='active'||modes.includes('off')?'off':modes.includes('shadow')?'shadow':'enabled'}
  async function connection(id:GitIdentity,connectionId:string) {
    const c=await repository.getConnection(id.grant,{installationId:id.installationId,connectionId})
    if(!c)throw new GitApiError('not_found')
    return c
  }
  function allowed(id:GitIdentity,permission:GitPermission) { return id.grant.scopeBindings.find(b=>b.installation_id===id.installationId)?.permissions.includes(permission)===true }
  async function capabilities(id:GitIdentity,c:GitConnection) {
    const effective=await mode(c),on=effective!=='off'
    return {mode:effective,can_configure:allowed(id,'scope_admin')&&deps.config.mode!=='off',can_preview:on&&allowed(id,'contribute')&&!!deps.keys,
      can_sync:on&&allowed(id,'contribute'),can_review:on&&allowed(id,'review'),can_resolve:on&&allowed(id,'contribute'),
      can_apply:effective==='enabled'&&allowed(id,'publish'),can_pull_request:false,external_write_reason:'external_write_disabled' as const}
  }
  async function base<T>(id:GitIdentity,c:GitConnection,exportId:string,action:(context:RegisteredGitBaseContext)=>Promise<T>) {
    if(await mode(c)==='off'||!deps.keys)throw new GitApiError('feature_disabled')
    return createGitExportService({...deps,keys:deps.keys}).withReadBase(id.grant,{installationId:id.installationId,connectionId:c.connectionId,expectedGeneration:c.generation,exportId},action)
  }
  async function proposalIdentity(id:GitIdentity,proposalId:string) {
    return transaction(id,'read',async client=>{
      const row=(await client.query<{connection_id:string;export_id:string}>(`SELECT connection_id,export_id FROM memory_git_proposal_identities WHERE installation_id=$1 AND proposal_id=$2`,[id.installationId,proposalId])).rows[0]
      if(!row)throw new GitApiError('not_found');return row
    })
  }
  async function childPage(client:pg.PoolClient,id:GitIdentity,connectionId:string,kind:'proposals'|'cleanup',query:z.infer<typeof GitListQuery>) {
    const table=kind==='proposals'?'memory_git_import_proposals':'memory_git_remote_cleanup',key=kind==='proposals'?'proposal_id':'export_id'
    const columns=kind==='proposals'?'proposal_id,revision::text,state,export_id':'export_id,old_run_id,cleanup_pending,recognized_at'
    const counts=(await client.query(`SELECT count(*)::int AS total${kind==='cleanup'?',count(*) FILTER(WHERE cleanup_pending)::int AS pending_count':''}
      FROM ${table} WHERE installation_id=$1 AND connection_id=$2`,[id.installationId,connectionId])).rows[0]
    const rows=(await client.query(`SELECT ${columns} FROM ${table} WHERE installation_id=$1 AND connection_id=$2
      AND ($3::uuid IS NULL OR ${key}>$3) ORDER BY ${key} LIMIT $4`,[id.installationId,connectionId,query.cursor??null,query.limit+1])).rows
    return {...counts,...(kind==='cleanup'?{cleanup_pending:counts.pending_count>0}:{}),items:rows.slice(0,query.limit),next_cursor:rows.length>query.limit?rows[query.limit-1][key] as string:null}
  }
  return {
    authorize,connection,mode,capabilities,proposalIdentity,
    async children(id:GitIdentity,connectionId:string,kind:'proposals'|'cleanup',raw:unknown={}) {
      const query=GitListQuery.parse(raw)
      return transaction(id,'read',async client=>{
        const c=(await client.query('SELECT generation::text FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2 FOR SHARE',[id.installationId,connectionId])).rows[0]
        if(!c)throw new GitApiError('not_found')
        return {connection_id:connectionId,generation:c.generation,...await childPage(client,id,connectionId,kind,query)}
      })
    },
    async connections(id:GitIdentity,raw:unknown={}) {
      const query=GitListQuery.parse(raw)
      const page=await transaction(id,'read',async client=>(await client.query<{connection_id:string}>(`SELECT connection_id FROM memory_git_connections
        WHERE installation_id=$1 AND ($2::uuid IS NULL OR connection_id>$2) ORDER BY connection_id LIMIT $3`,[id.installationId,query.cursor??null,query.limit+1])).rows)
      const items=[]
      for(const pointer of page.slice(0,query.limit)) {
        const c=await connection(id,pointer.connection_id)
        const state=await transaction(id,'read',async client=>{
          const runs=(await client.query(`SELECT run_id,state,eligible,unfinished,failures,reason_code,updated_at FROM memory_git_run_receipts
            WHERE installation_id=$1 AND connection_id=$2 ORDER BY updated_at DESC,run_id DESC LIMIT 20`,[id.installationId,c.connectionId])).rows
          const proposals=await childPage(client,id,c.connectionId,'proposals',{limit:20})
          const exports=(await client.query(`SELECT export_id,generation::text,base_commit,created_at FROM memory_git_snapshots WHERE installation_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 20`,[id.installationId,c.connectionId])).rows
          const cleanup=await childPage(client,id,c.connectionId,'cleanup',{limit:50})
          const success=(await client.query(`SELECT max(created_at) AS last_success FROM memory_git_audit_events WHERE installation_id=$1 AND connection_id=$2 AND action='apply' AND outcome='allowed'`,[id.installationId,c.connectionId])).rows[0]
          return {runs,proposals:proposals.items,proposals_next_cursor:proposals.next_cursor,proposal_total:proposals.total,exports,
            cleanup:cleanup.items,cleanup_next_cursor:cleanup.next_cursor,cleanup_total:cleanup.total,cleanup_pending_count:cleanup.pending_count,
            last_success:success?.last_success??null,current_error:runs.find(r=>r.reason_code)?.reason_code??null,cleanup_pending:cleanup.cleanup_pending}
        })
        items.push({...c,...state,capabilities:await capabilities(id,c)})
      }
      return {items,next_cursor:page.length>query.limit?page[query.limit-1].connection_id:null}
    },
    async preview(id:GitIdentity,connectionId:string,exportId:string) {
      const c=await connection(id,connectionId)
      return base(id,c,exportId,async context=>({export_id:exportId,connection_id:connectionId,generation:c.generation,
        base_commit:context.base.baseCommit,assets:context.base.assets.map(publicGitVersion),capabilities:await capabilities(id,c)}))
    },
    async proposal(id:GitIdentity,proposalId:string) {
      const pointer=await proposalIdentity(id,proposalId),c=await connection(id,pointer.connection_id)
      return base(id,c,pointer.export_id,async context=>{
        // Same run-before-proposal order as apply. The unlocked lookup is only
        // an identity hint; the protected row must still match afterwards.
        const observed=(await context.client.query('SELECT run_id FROM memory_git_import_proposals WHERE installation_id=$1 AND proposal_id=$2',[id.installationId,proposalId])).rows[0]
        if(observed?.run_id)await context.client.query('SELECT 1 FROM memory_git_runs WHERE installation_id=$1 AND run_id=$2 FOR SHARE',[id.installationId,observed.run_id])
        const p=(await context.client.query<ImportProposalRow>(`SELECT *,revision::text,base_revision::text,generation::text,authorization_epoch::text FROM memory_git_import_proposals
          WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3 FOR SHARE`,[id.installationId,c.connectionId,proposalId])).rows[0]
        if(!p)throw new GitApiError('not_found')
        if(p.run_id!==observed?.run_id)throw new GitApiError('source_invalid')
        await requireCanonicalImportRun(context,p)
        const doc=p.proposed_document,wire=context.base.assets.find(a=>a.asset.key.id===doc.key.id),memory=context.current.find(a=>a.asset.key.id===doc.key.id),git=doc.gitSnapshot
        if(!wire||!memory||!git)throw new GitApiError('source_invalid')
        const b=context.confirmedBases.get(doc.key.id)??wire,currentPolicy=memory.asset.key.kind==='skill'?(memory.asset as SkillAsset).immutable.policyHash:context.reviewPolicyHash
        const current=snapshotDigest(b)===doc.inputs.base&&snapshotDigest(memory)===doc.inputs.memory&&snapshotDigest(git)===doc.inputs.git
        const reasons:string[]=[]
        if(!current)reasons.push('source_invalid')
        if(currentPolicy!==p.policy_hash)reasons.push('policy_changed')
        if(doc.result.kind==='conflict')reasons.push('conflict')
        if(!p.provider_actor_id&&doc.result.kind==='proposal')reasons.push('identity_unknown')
        const cap=await capabilities(id,c),reviewable=['awaiting_review','awaiting_identity'].includes(p.state)
        const eligibility=await createGitImportService({...deps,keys:deps.keys!}).eligibility(context,p)
        const gateReasons=[...new Set([...reasons,...eligibility.reasons])]
        return {proposal_id:proposalId,connection_id:c.connectionId,export_id:pointer.export_id,generation:c.generation,revision:p.revision,state:p.state,
          key:doc.key,head_commit:p.head_commit,proposed_hash:p.proposed_hash,policy_hash:p.policy_hash,current_policy_hash:currentPolicy,expected_inputs:doc.inputs,
          expected_asset_revision:memory.asset.baseRevision,versions:{base:publicGitVersion(b),memory:publicGitVersion(memory),git:publicGitVersion(git)},
          proposed_result:doc.result.kind==='conflict'?null:publicGitVersion(doc.result.asset),
          conflicts:doc.result.kind==='conflict'?doc.result.conflicts:[],gate_reasons:gateReasons,review_reset:!!doc.resolvedDocumentHash,
          source:{kind:'git',author_status:p.provider_actor_id?'mapped_identity_requires_current_review':'unknown'},
          capabilities:{...cap,can_review:cap.can_review&&reviewable&&eligibility.canReview&&!reasons.length,can_apply:cap.can_apply&&eligibility.canApply&&['awaiting_review','planned','noop'].includes(p.state)&&!reasons.length,
            can_resolve:cap.can_resolve&&['conflicted','awaiting_review'].includes(p.state)&&current&&currentPolicy===p.policy_hash}}
      })
    },
    async run(id:GitIdentity,runId:string) {
      return transaction(id,'read',async client=>{
        const row=(await client.query(`SELECT p.run_id,p.connection_id,p.generation::text,p.canonical_run_id,p.state,p.eligible,p.unfinished,p.attempts,p.failures,p.reason_code,p.outcome_kind,
          r.state AS current_state,r.export_id,r.recovery_export_id,r.change_number,r.merge_commit,r.tree_sha,p.updated_at,
          EXISTS(SELECT 1 FROM memory_git_remote_cleanup c WHERE c.installation_id=p.installation_id AND (c.old_run_id=p.run_id OR c.recognized_run_id=p.run_id) AND c.cleanup_pending) AS cleanup_pending
          FROM memory_git_run_receipts p LEFT JOIN memory_git_runs r USING(installation_id,run_id) WHERE p.installation_id=$1 AND p.run_id=$2`,[id.installationId,runId])).rows[0]
        if(!row)throw new GitApiError('not_found');return row
      })
    },
  }
}
export type GitReadService=ReturnType<typeof createGitReadService>
