import {z} from 'zod'
import type pg from 'pg'
import {createScopeAuthorization} from '../governance/authorization.js'
import {createTransactionBoundPool} from '../api/transaction-bound-pool.js'
import {appendSkillAudit} from './audit-repository.js'
import {changePublishedHead,type SkillPublicationDeps,type SkillPublicationResult} from './publication-service.js'
import {validateSkillPublicationTarget,publicationFailure,publicationDomainError,type SkillPublicationIdentity,type SkillPublicationErrorCode} from './publication-validation.js'
import {hasSkillFixtureCapability} from './testing-capability.js'
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)
export const SkillRollbackRequestSchema=z.object({skillId:z.uuid(),targetVersionId:z.uuid(),expectedRevision:revision,expectedPublicationRevision:revision}).strict()

/** A failed rollback must not leave delivery enabled when its actual previous target is gone.
 * This is a separate authorized CAS transaction, never an unconditional catch-path mutation. */
async function closeInvalidPrevious(client:pg.PoolClient,identity:SkillPublicationIdentity,request:z.infer<typeof SkillRollbackRequestSchema>,code:SkillPublicationErrorCode):Promise<boolean>{
  if(!['target_revoked','not_found','source_invalid'].includes(code))return false
  await client.query('BEGIN')
  try{
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))`,[identity.installationId])
    await client.query(`SELECT 1 FROM memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) ORDER BY installation_id FOR SHARE`,[identity.grant.scopeBindings.map(b=>b.installation_id)])
    await client.query(`SELECT 1 FROM memory_scope_memberships WHERE membership_id=ANY($1::uuid[]) ORDER BY membership_id FOR SHARE`,[identity.grant.scopeBindings.map(b=>b.membership_id).filter(Boolean)])
    const installation=await client.query(`SELECT 1 FROM memory_installations WHERE installation_id=$1 AND relay_status='active'
      AND local_status NOT IN('purging','purged','integrity_error') FOR SHARE`,[identity.installationId])
    if(!installation.rowCount){await client.query('COMMIT');return false}
    const authorization=createScopeAuthorization(createTransactionBoundPool(client)),grant=await authorization.validateV2Grant(identity.grant)
    const binding=grant?.scopeBindings.find(b=>b.installation_id===identity.installationId)
    if(!binding?.permissions.includes('publish')){await client.query('COMMIT');return false}
    // Lock the target's source before the Skill task. Missing rows are established again
    // by the final CAS; immutable version identities cannot be restored by normal services.
    const observed=(await client.query<{claim_version_id:string|null}>(`SELECT a.claim_version_id FROM memory_skill_versions v
      JOIN memory_skill_archives a USING(installation_id,archive_id)
      WHERE v.installation_id=$1 AND v.skill_id=$2 AND v.version_id=$3`,[identity.installationId,request.skillId,request.targetVersionId])).rows[0]
    const revoked=Boolean((await client.query(`SELECT 1 FROM memory_skill_version_revocations WHERE installation_id=$1 AND skill_id=$2 AND version_id=$3`,[identity.installationId,request.skillId,request.targetVersionId])).rowCount)
    const source=observed?.claim_version_id?(await client.query<{expired:boolean}>(`SELECT valid_until IS NOT NULL AND valid_until<=clock_timestamp() AS expired
      FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 FOR SHARE`,[identity.installationId,observed.claim_version_id])).rows[0]:undefined
    const target=(await client.query<{claim_version_id:string|null}>(`SELECT a.claim_version_id FROM memory_skill_versions v
      JOIN memory_skill_archives a USING(installation_id,archive_id)
      WHERE v.installation_id=$1 AND v.skill_id=$2 AND v.version_id=$3 FOR SHARE OF v,a`,[identity.installationId,request.skillId,request.targetVersionId])).rows[0]
    const invalid=!target||revoked||Boolean(target.claim_version_id&&(!source||source.expired))
    if(!invalid){await client.query('COMMIT');return false}
    await client.query(`SELECT 1 FROM memory_skill_tasks t JOIN memory_skills s USING(installation_id,task_id)
      WHERE t.installation_id=$1 AND s.skill_id=$2 FOR UPDATE OF t`,[identity.installationId,request.skillId])
    const head=(await client.query<{revision:string}>(`SELECT revision::text FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`,[identity.installationId,request.skillId])).rows[0]
    const published=(await client.query<{revision:string;state:string;previous_version_id:string|null;recorded_previous_version_id:string|null}>(`
      SELECT p.revision::text,p.state,p.previous_version_id,e.previous_version_id AS recorded_previous_version_id
      FROM memory_skill_publication_heads p JOIN memory_skill_publication_events e
        ON e.installation_id=p.installation_id AND e.event_id=p.publication_event_id AND e.skill_id=p.skill_id AND e.version_id=p.current_version_id
      WHERE p.installation_id=$1 AND p.skill_id=$2 FOR UPDATE OF p`,[identity.installationId,request.skillId])).rows[0]
    // The immutable current publication event preserves the actual previous identity
    // even when the previous-version FK has become NULL after content deletion.
    const previous=published?.previous_version_id??published?.recorded_previous_version_id
    if(!head||Number(head.revision)!==request.expectedRevision||!published||published.state!=='active'
      ||Number(published.revision)!==request.expectedPublicationRevision||previous!==request.targetVersionId){await client.query('COMMIT');return false}
    const changed=await client.query(`UPDATE memory_skill_publication_heads SET state='disabled',revision=revision+1,updated_at=NOW()
      WHERE installation_id=$1 AND skill_id=$2 AND revision=$3 AND state='active'`,[identity.installationId,request.skillId,request.expectedPublicationRevision])
    if(changed.rowCount!==1){await client.query('ROLLBACK');return false}
    const actor=binding.owner_scope_kind==='personal'?{actorKind:'personal' as const,actorId:binding.owner_scope_id}:{actorKind:'membership' as const,actorId:binding.membership_id!}
    await appendSkillAudit(client,{installationId:identity.installationId,...actor,action:'rollback',outcome:'denied',skillId:request.skillId,versionId:request.targetVersionId,revision:request.expectedPublicationRevision+1,code})
    await client.query('COMMIT');return true
  }catch(error){await client.query('ROLLBACK');throw error}
}
export function createSkillRollbackService(deps:SkillPublicationDeps){return {
  async execute(identity:SkillPublicationIdentity,rawRequest:unknown):Promise<SkillPublicationResult>{
    const client=await deps.pool.connect(),parsed=SkillRollbackRequestSchema.safeParse(rawRequest)
    try{
      await client.query('BEGIN');if(!parsed.success)publicationFailure('invalid_request');const r=parsed.data
      const facts=await validateSkillPublicationTarget(client,identity,{skillId:r.skillId,versionId:r.targetVersionId,expectedRevision:r.expectedRevision,mode:'manual',allowHistoricalVersion:true},deps)
      const published=(await client.query<{previous_version_id:string|null;revision:string}>(`SELECT previous_version_id,revision::text FROM memory_skill_publication_heads WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`,[identity.installationId,r.skillId])).rows[0]
      if(Number(published?.revision??0)!==r.expectedPublicationRevision)publicationFailure('revision_conflict')
      if(!published?.previous_version_id||published.previous_version_id!==r.targetVersionId)publicationFailure('no_previous_version')
      if(!hasSkillFixtureCapability(deps.fixtureCapability))publicationFailure('product_gate_closed')
      const publicationRevision=await changePublishedHead(client,{identity,skillId:r.skillId,versionId:r.targetVersionId,expectedPublicationRevision:r.expectedPublicationRevision,mode:'rollback',...facts})
      await appendSkillAudit(client,{installationId:identity.installationId,...facts.actor,action:'rollback',outcome:'allowed',skillId:r.skillId,versionId:r.targetVersionId,revision:publicationRevision,code:'ok'})
      await client.query('COMMIT');return {skillId:r.skillId,versionId:r.targetVersionId,revision:r.expectedRevision,publicationRevision,state:'active',provenance:'fixture'}
    }catch(error){await client.query('ROLLBACK');const domain=publicationDomainError(error)
      const closed=parsed.success&&await closeInvalidPrevious(client,identity,parsed.data,domain.code)
      if(!closed)await appendSkillAudit(client,{installationId:identity.installationId,actorKind:null,actorId:null,action:'rollback',outcome:'denied',skillId:parsed.success?parsed.data.skillId:null,versionId:parsed.success?parsed.data.targetVersionId:null,revision:null,code:domain.code});throw domain
    }finally{client.release()}
  },
}}
