import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { appendSkillAudit } from './audit-repository.js'

export const SkillPublicationPolicySchema = z.object({
  minimumIndependentSuccesses: z.number().int().min(2).max(100),
  autoMode: z.enum(['off','shadow']),canaryMode: z.enum(['off','shadow']),
}).strict()
export type SkillPublicationPolicy = z.infer<typeof SkillPublicationPolicySchema>
export const DEFAULT_SKILL_PUBLICATION_POLICY: SkillPublicationPolicy = Object.freeze({ minimumIndependentSuccesses: 2,autoMode: 'off',canaryMode: 'off' })
const Request = z.object({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),policy: SkillPublicationPolicySchema }).strict()
type Identity = { installationId: string;grant: V2GrantFacts }
type Client = Pick<pg.PoolClient,'query'>
export class SkillPolicyError extends Error {
  readonly statusCode: number
  constructor(readonly code: 'invalid_request'|'forbidden'|'revision_conflict') {
    super(code);this.statusCode=code==='invalid_request'?400:code==='forbidden'?403:409
  }
}
/** Defaults are read-only and compatible with historical review hashes before migration 35. */
export async function loadSkillPublicationPolicy(client: Client,installationId: string,options:{write?:boolean}={}) {
  const exists = (await client.query(`SELECT to_regclass('memory_skill_publication_policy_heads') AS present`)).rows[0].present
  type Row = { version_id: string;revision: string;policy: SkillPublicationPolicy }
  const parentScope = exists ? (await client.query<{ installation_id: string }>(`SELECT p.installation_id
    FROM memory_owner_scopes s JOIN memory_owner_scopes p ON p.owner_scope_kind='organization' AND p.owner_scope_id=s.parent_organization_id
    WHERE s.installation_id=$1 FOR SHARE OF s,p`,[installationId])).rows[0] : undefined
  for(const id of [...new Set([installationId,...(parentScope?[parentScope.installation_id]:[])])].sort()) {
    const lock=options.write&&id===installationId?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'
    await client.query(`SELECT ${lock}(hashtextextended('skill:policy:'||$1,0))`,[id])
  }
  const own = exists ? (await client.query<Row>(`SELECT h.version_id,h.revision::text,v.policy
    FROM memory_skill_publication_policy_heads h JOIN memory_skill_publication_policy_versions v USING(installation_id,version_id)
    WHERE h.installation_id=$1 FOR SHARE OF h`,[installationId])).rows[0] : undefined
  const parent = parentScope ? (await client.query<Row>(`SELECT h.version_id,h.revision::text,v.policy
    FROM memory_skill_publication_policy_heads h JOIN memory_skill_publication_policy_versions v USING(installation_id,version_id)
    WHERE h.installation_id=$1 FOR SHARE OF h`,[parentScope.installation_id])).rows[0] : undefined
  const a=own?.policy ?? DEFAULT_SKILL_PUBLICATION_POLICY,b=parent?.policy
  const policy = { ...a,minimumIndependentSuccesses: Math.max(a.minimumIndependentSuccesses,b?.minimumIndependentSuccesses??2),
    autoMode: b?.autoMode==='off'?'off' as const:a.autoMode,canaryMode:b?.canaryMode==='off'?'off' as const:a.canaryMode }
  const binding = own || parent ? { versionId:own?.version_id??null,parentVersionId:parent?.version_id??null,policy } : null
  return { revision:Number(own?.revision??0),versionId:own?.version_id??null,policy,
    hash:canonicalPayloadHash(binding??policy).toString('hex'),binding }
}
export function createSkillPolicyService(deps: {pool:pg.Pool}) {
  async function authorize(client:pg.PoolClient,identity:Identity,permission:'read'|'policy_admin') {
    await client.query(`SELECT 1 FROM memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) FOR SHARE`,[identity.grant.scopeBindings.map(b=>b.installation_id)])
    await client.query(`SELECT 1 FROM memory_scope_memberships WHERE membership_id=ANY($1::uuid[]) FOR SHARE`,[identity.grant.scopeBindings.map(b=>b.membership_id).filter(Boolean)])
    const auth=createScopeAuthorization(createTransactionBoundPool(client)),grant=await auth.validateV2Grant(identity.grant)
    const binding=grant?.scopeBindings.find(b=>b.installation_id===identity.installationId)
    if(!binding||!binding.permissions.includes(permission))throw new SkillPolicyError('forbidden')
    return binding.owner_scope_kind==='personal'?{actorKind:'personal' as const,actorId:binding.owner_scope_id}:{actorKind:'membership' as const,actorId:binding.membership_id!}
  }
  return {
    async getPolicy(identity:Identity) {
      const client=await deps.pool.connect()
      try {await client.query('BEGIN');await authorize(client,identity,'read');const result=await loadSkillPublicationPolicy(client,identity.installationId);await client.query('COMMIT');return result}
      catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    },
    async execute(identity:Identity,rawRequest:unknown) {
      const client=await deps.pool.connect()
      try {
        await client.query('BEGIN')
        const parsed=Request.safeParse(rawRequest);if(!parsed.success)throw new SkillPolicyError('invalid_request')
        const actor=await authorize(client,identity,'policy_admin')
        // Serialize absent heads as well as existing rows; no policy mutation can pass a reader's snapshot lock.
        const current=await loadSkillPublicationPolicy(client,identity.installationId,{write:true})
        if(current.revision!==parsed.data.expectedRevision)throw new SkillPolicyError('revision_conflict')
        const versionId=randomUUID(),revision=current.revision+1,policy=parsed.data.policy
        await client.query(`INSERT INTO memory_skill_publication_policy_versions(version_id,installation_id,revision,policy,policy_hash,actor_kind,actor_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[versionId,identity.installationId,revision,policy,canonicalPayloadHash(policy).toString('hex'),actor.actorKind,actor.actorId])
        await client.query(`INSERT INTO memory_skill_publication_policy_heads(installation_id,version_id,revision) VALUES($1,$2,$3)
          ON CONFLICT(installation_id) DO UPDATE SET version_id=EXCLUDED.version_id,revision=EXCLUDED.revision`,[identity.installationId,versionId,revision])
        await appendSkillAudit(client,{installationId:identity.installationId,...actor,action:'policy',outcome:'allowed',skillId:null,versionId:null,revision,code:'ok'})
        const result=await loadSkillPublicationPolicy(client,identity.installationId)
        await client.query('COMMIT');return result
      }catch(error){await client.query('ROLLBACK');if(error instanceof SkillPolicyError)await appendSkillAudit(client,{installationId:identity.installationId,actorKind:null,actorId:null,action:'policy',outcome:'denied',skillId:null,versionId:null,revision:null,code:error.code});throw error}
      finally{client.release()}
    },
  }
}
