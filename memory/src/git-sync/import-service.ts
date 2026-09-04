import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { createClaimRevisionService,prepareClaimRevision } from '../governance/revision-service.js'
import { createSkillReviewService, SkillReviewError } from '../skills/review-service.js'
import { appendSkillAudit } from '../skills/audit-repository.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { createGitExportService } from './export-service.js'
import { lockImportProposal,prepareGovernedImport,requireImportQuorum,requireImportActor,type ImportSubject } from './governance-adapter.js'
import { insertGitRevisionLink,lockGitConnection,type GitConnection } from './repository.js'
import { lockGitPolicyScopes,requireGitPermission,requireCurrentGitAuthorization } from './authorization.js'
import { RevisionSchema, type SkillAsset, type WikiAsset } from './types.js'
import type { GitSyncMode } from './config.js'
import { snapshotDigest } from './merge.js'

const subject=z.object({installationId:z.uuid(),connectionId:z.uuid(),expectedGeneration:RevisionSchema.refine(v=>v!=='0'),
  exportId:z.uuid(),proposalId:z.uuid(),expectedRevision:RevisionSchema.refine(v=>v!=='0'),
  expectedPolicyHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),expectedProposedHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedAssetRevision:RevisionSchema.refine(v=>v!=='0').optional()}).strict()
const decision=subject.extend({decision:z.enum(['approve','request_changes','reject'])})
export interface GitImportOutcome {proposalId:string;outcome:'published'|'draft_appended'|'linked'|'revoked';versionId:string;linkId:string}
export function createGitImportService(deps:Parameters<typeof createGitExportService>[0]&{
  applicationMode?:(connection:GitConnection)=>Promise<GitSyncMode>
  /** Internal API composition only: caller records denial after its outer rollback. */
  deferDenied?:boolean
}) {
  const exports=createGitExportService(deps)
  function parse<T>(schema:z.ZodType<T>,value:unknown):T {const r=schema.safeParse(value);if(!r.success)throw new Error('git_invalid_request');return r.data}
  function expected(context:import('./export-service.js').RegisteredGitBaseContext,p:import('./governance-adapter.js').ImportProposalRow,input:z.infer<typeof subject>) {
    const current=context.current.find(a=>a.asset.key.id===p.proposed_document.key.id)
    const policy=current?.asset.key.kind==='skill'?(current.asset as SkillAsset).immutable.policyHash:context.reviewPolicyHash
    if(input.expectedPolicyHash!==undefined&&(p.policy_hash!==input.expectedPolicyHash||policy!==input.expectedPolicyHash))throw new Error('git_policy_changed')
    if(input.expectedProposedHash!==undefined&&p.proposed_hash!==input.expectedProposedHash)throw new Error('git_revision_conflict')
    if(input.expectedAssetRevision!==undefined&&current?.asset.baseRevision!==input.expectedAssetRevision)throw new Error('git_revision_conflict')
  }
  /** Metadata-only retry. It never reads portable documents or asks an already
   * revoked asset to become active to rediscover its successful operation.
   * Task8 extends this lookup for retained metadata after lifecycle cascades. */
  async function confirmedOutcome(grant:V2GrantFacts,input:ImportSubject):Promise<GitImportOutcome|null> {
    const seen=await deps.pool.query(`SELECT 1 FROM memory_git_import_outcomes WHERE installation_id=$1 AND proposal_id=$2
      UNION ALL SELECT 1 FROM memory_git_retained_outcomes WHERE installation_id=$1 AND proposal_id=$2`,[input.installationId,input.proposalId])
    const client=await deps.pool.connect()
    try {
      await client.query('BEGIN')
      await lockGitPolicyScopes(client,grant,input.installationId)
      const stamp=await requireGitPermission(client,grant,input.installationId,'publish')
      if(!seen.rowCount){await client.query('COMMIT');return null}
      const observed=(await client.query('SELECT repository_id FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2',[input.installationId,input.connectionId])).rows[0]
      if(!observed)throw new Error('git_not_found')
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`,[input.installationId,observed.repository_id])
      const connection=await lockGitConnection(client,input.installationId,input.connectionId,input.expectedGeneration)
      if(connection.state!=='active'||connection.syncMode!=='enabled'||await deps.applicationMode?.(connection)!=='enabled')throw new Error('git_feature_disabled')
      const retained=(await client.query(`SELECT * FROM memory_git_retained_outcomes WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3`,
        [input.installationId,input.connectionId,input.proposalId])).rows[0]
      if(retained) {
        if(retained.export_id!==input.exportId||retained.proposal_revision!==input.expectedRevision)throw new Error('git_revision_conflict')
        await requireCurrentGitAuthorization(client,stamp,'publish');await client.query('COMMIT')
        return {proposalId:input.proposalId,outcome:retained.outcome,versionId:retained.version_id,linkId:retained.link_id}
      }
      const row=(await client.query(`SELECT o.outcome,l.version_id,l.link_id,p.export_id,p.revision::text,p.generation::text,p.state,p.head_commit,l.commit_sha
        FROM memory_git_import_outcomes o JOIN memory_git_import_proposals p ON p.installation_id=o.installation_id AND p.proposal_id=o.proposal_id
        JOIN memory_git_revision_links l ON l.installation_id=o.installation_id AND l.connection_id=o.connection_id AND l.link_id=o.link_id
        WHERE o.installation_id=$1 AND o.connection_id=$2 AND o.proposal_id=$3 AND o.proposal_revision=p.revision FOR SHARE OF p`,
      [input.installationId,input.connectionId,input.proposalId])).rows[0]
      if(!row)throw new Error('git_not_found')
      if(row.export_id!==input.exportId||row.revision!==input.expectedRevision||row.generation!==input.expectedGeneration||row.state!=='applied'
        ||row.head_commit!==row.commit_sha)throw new Error('git_revision_conflict')
      await requireCurrentGitAuthorization(client,stamp,'publish')
      await client.query('COMMIT')
      return {proposalId:input.proposalId,outcome:row.outcome,versionId:row.version_id,linkId:row.link_id}
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  async function denied(input:ImportSubject,grant:V2GrantFacts,action:'apply'|'review',error:unknown) {
    const code=error instanceof Error?error.message:''
    const reason=code==='git_identity_unknown'?'identity_unknown':code==='git_self_review_denied'?'self_review_denied':code==='git_policy_changed'?'policy_changed'
      :code==='git_forbidden'?'forbidden':code==='git_authorization_stale'?'authorization_stale':code==='git_feature_disabled'?'feature_disabled':'source_invalid'
    // Explicit OUTER denial transaction. Nested domain savepoint audits were
    // rolled back with partial application and cannot stand in for this audit.
    const client=await deps.pool.connect()
    try {
      await client.query('BEGIN')
      if(code==='git_identity_unknown')await client.query(`UPDATE memory_git_import_proposals SET state='awaiting_identity'
        WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3 AND revision=$4 AND state='awaiting_review'`,[input.installationId,input.connectionId,input.proposalId,input.expectedRevision])
      const actor=grant.scopeBindings.find(b=>b.installation_id===input.installationId)
      await client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,proposal_id,membership_id,membership_revision,authorization_epoch,action,outcome,reason_code)
        SELECT $1,installation_id,$3,$4,$5,$6,$7,$8,'denied',$9 FROM memory_installations WHERE installation_id=$2`,
      [randomUUID(),input.installationId,input.connectionId,input.proposalId,actor?.membership_id??null,actor?.membership_revision??null,actor?.authorization_epoch??null,action,reason])
      if(error instanceof SkillReviewError) {
        const p=(await client.query(`SELECT proposed_document->'key'->>'id' AS skill_id FROM memory_git_import_proposals
          WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3 AND proposed_document->'key'->>'kind'='skill'`,[input.installationId,input.connectionId,input.proposalId])).rows[0]
        if(p)await appendSkillAudit(client,{installationId:input.installationId,actorKind:actor?.membership_id?'membership':null,actorId:actor?.membership_id??null,
          action:'edit',outcome:'denied',skillId:p.skill_id,versionId:null,revision:null,code:error.code})
      }
      await client.query('COMMIT')
    }catch(auditError){await client.query('ROLLBACK');throw auditError}finally{client.release()}
  }
  async function apply(grant:V2GrantFacts,raw:unknown):Promise<GitImportOutcome> {
    const input=parse(subject,raw)
    try{
      const confirmed=await confirmedOutcome(grant,input)
      if(confirmed)return confirmed
      return await exports.withApplyBase(grant,{installationId:input.installationId,connectionId:input.connectionId,expectedGeneration:input.expectedGeneration,exportId:input.exportId},async context=>{
      if(context.connection.syncMode!=='enabled'||await deps.applicationMode?.(context.connection)!=='enabled')throw new Error('git_feature_disabled')
      const p=await lockImportProposal(context,input)
      expected(context,p,input)
      if(p.state==='applied') {
        const existing=(await context.client.query(`SELECT o.outcome,l.version_id,l.link_id FROM memory_git_import_outcomes o JOIN memory_git_revision_links l USING(link_id)
          WHERE o.installation_id=$1 AND o.proposal_id=$2`,[input.installationId,p.proposal_id])).rows[0]
        if(!existing)throw new Error('git_source_stale')
        return {proposalId:p.proposal_id,outcome:existing.outcome,versionId:existing.version_id,linkId:existing.link_id}
      }
      const kind=p.proposed_document.result.kind
      const applicable=kind==='proposal'?['awaiting_review','awaiting_identity'].includes(p.state)
        :kind==='noop'?p.state==='noop':kind==='export'&&p.state==='planned'
      if(!applicable)throw new Error('git_proposal_terminal')
      // G=B with Memory-only changes is an export of M, not an import edit.
      // Like M=G, it confirms current M against actual G without a new author,
      // review or domain version; all source/run/namespace fences still apply.
      const contentChange=kind==='proposal'
      const g=await prepareGovernedImport(context,p,contentChange)
      if(contentChange)await requireImportQuorum(context,g)
      let outcome:GitImportOutcome['outcome']='linked',versionId=g.current.asset.baseVersionId
      let preparedClaim:Awaited<ReturnType<typeof prepareClaimRevision>>|undefined
      const deleting=contentChange&&p.proposed_document.result.kind!=='conflict'&&p.proposed_document.result.asset.deleted
      const applyDomain=async()=>{
        const bound=createTransactionBoundPool(context.client)
        if(g.current.asset.key.kind==='claim'||g.current.asset.key.kind==='rule') {
          const result=deleting?await createClaimRevisionService(bound).append({grant,installationId:input.installationId,governed:g})
            :preparedClaim=await prepareClaimRevision(context.client,{grant,installationId:input.installationId,governed:g})
          outcome=result.outcome;versionId=result.versionId
        } else if(g.current.asset.key.kind==='skill') {
          const current=g.current.asset as SkillAsset,result=p.proposed_document.result
          if(result.kind==='conflict')throw new Error('git_resolution_conflict')
          if(!Number.isSafeInteger(Number(current.serverOnly.editableHeadRevision)))throw new Error('git_revision_conflict')
          const service=createSkillReviewService({pool:bound,context:deps.skill.context})
          const draft=result.asset.deleted
            ?await service.execute({installationId:input.installationId,grant},{action:'revoke',skillId:current.key.id,expectedRevision:Number(current.serverOnly.editableHeadRevision)})
            :await service.executeGitEdit({installationId:input.installationId,grant},{action:'edit',skillId:current.key.id,
              expectedRevision:Number(current.serverOnly.editableHeadRevision),document:(result.asset.asset as SkillAsset).editable.document},
            {author:g.author!,prelockedLifecycle:context.sourceContext.lifecycle,governed:g})
          outcome=result.asset.deleted?'revoked':'draft_appended';versionId=draft.versionId
        } else {
          const result=p.proposed_document.result
          if(result.kind==='conflict')throw new Error('git_resolution_conflict')
          const service=createWikiPublicationService(bound)
          const published=result.asset.deleted
            ?await service.revoke({grant,targetInstallationId:input.installationId,current:g.current.asset as WikiAsset,sourceContext:context.sourceContext,governed:g})
            :await service.publishRevision({grant,targetInstallationId:input.installationId,
              current:g.current.asset as WikiAsset,proposed:result.asset.asset as WikiAsset,sourceContext:context.sourceContext,governed:g})
          outcome=result.asset.deleted?'revoked':'published';versionId=published.wikiVersionId
        }
      }
      if(deleting)outcome='revoked'
      else if(contentChange)await applyDomain()
      const result=p.proposed_document.result
      if(result.kind==='conflict')throw new Error('git_resolution_conflict')
      const binding=(await context.client.query(`SELECT binding_id,path FROM memory_git_asset_bindings WHERE installation_id=$1 AND connection_id=$2 AND asset_id=$3`,
        [input.installationId,input.connectionId,g.current.asset.key.id])).rows[0]
      if(!binding)throw new Error('git_source_stale')
      await context.client.query('UPDATE memory_git_asset_bindings SET path=$4 WHERE installation_id=$1 AND connection_id=$2 AND binding_id=$3',
        [input.installationId,input.connectionId,binding.binding_id,result.asset.asset.path])
      const linkId=await insertGitRevisionLink(context.client,{installationId:input.installationId,connectionId:input.connectionId,bindingId:binding.binding_id,
        key:g.current.asset.key,versionId,path:result.asset.asset.path,commitSha:p.head_commit,treeSha:g.treeSha,direction:'import',proposalId:p.proposal_id})
      await context.client.query(`INSERT INTO memory_git_import_outcomes(installation_id,connection_id,proposal_id,proposal_revision,revision_id,link_id,binding_id,
        publisher_membership_id,publisher_membership_revision,publisher_authorization_epoch,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [input.installationId,input.connectionId,p.proposal_id,p.revision,g.revisionId,linkId,binding.binding_id,context.stamp.membershipId,context.stamp.membershipRevision,context.stamp.authorizationEpoch,outcome])
      await context.client.query(`INSERT INTO memory_git_confirmed_bases(installation_id,connection_id,binding_id,export_id,link_id,git_hash,git_document)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.installationId,input.connectionId,binding.binding_id,input.exportId,linkId,snapshotDigest(g.git),g.git])
      await context.client.query("UPDATE memory_git_import_proposals SET state='applied',updated_at=NOW() WHERE installation_id=$1 AND proposal_id=$2",[input.installationId,p.proposal_id])
      if(g.author)await requireImportActor(context,g.author,'contribute')
      for(const a of g.coauthors)await requireImportActor(context,a,'contribute')
      if(contentChange)await requireImportQuorum(context,g)
      await context.client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,proposal_id,membership_id,membership_revision,authorization_epoch,
        old_version_id,new_version_id,action,outcome,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'apply',$10,'ok')`,
      [randomUUID(),input.installationId,input.connectionId,p.proposal_id,context.stamp.membershipId,context.stamp.membershipRevision,context.stamp.authorizationEpoch,g.current.asset.baseVersionId,versionId,contentChange?'allowed':'noop'])
      if(deleting)context.finalizeRevoke(async()=>{
        const expectedVersion=versionId
        // Domain approval/source/head checks still run while the original body
        // exists. Only this exact target operation may then invalidate its base.
        await applyDomain()
        if(versionId!==expectedVersion||outcome!=='revoked')throw new Error('git_revision_conflict')
        if(g.author)await requireImportActor(context,g.author,'contribute')
        for(const a of g.coauthors)await requireImportActor(context,a,'contribute')
        await requireImportQuorum(context,g)
        await requireCurrentGitAuthorization(context.client,context.stamp,'publish')
        const proof=await context.client.query(`SELECT 1 FROM memory_git_retained_outcomes WHERE installation_id=$1 AND connection_id=$2
          AND proposal_id=$3 AND export_id=$4 AND proposal_revision=$5 AND version_id=$6 AND link_id=$7 AND outcome='revoked' AND commit_sha=$8`,
        [input.installationId,input.connectionId,p.proposal_id,input.exportId,input.expectedRevision,versionId,linkId,p.head_commit])
        if(proof.rowCount!==1)throw new Error('git_confirmation_lost')
      })
      if(preparedClaim)context.finalizeClaimRevision(async()=>{
        await preparedClaim!.activate()
        if(g.author)await requireImportActor(context,g.author,'contribute')
        for(const a of g.coauthors)await requireImportActor(context,a,'contribute')
        await requireImportQuorum(context,g)
        await requireCurrentGitAuthorization(context.client,context.stamp,'publish')
        if(await deps.applicationMode?.(context.connection)!=='enabled')throw new Error('git_feature_disabled')
        const head=await context.client.query(`SELECT 1 FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2
          AND current_version_id=$3 AND revision=$4 AND state='active'`,
        [input.installationId,g.current.asset.key.id,versionId,preparedClaim!.revision])
        if(head.rowCount!==1)throw new Error('git_revision_conflict')
        const retained=await context.client.query(`SELECT 1 FROM memory_git_retained_outcomes o
          JOIN memory_git_merge_receipts m USING(installation_id,connection_id,generation,commit_sha)
          WHERE o.installation_id=$1 AND o.connection_id=$2 AND o.proposal_id=$3 AND o.export_id=$4
          AND o.proposal_revision=$5 AND o.version_id=$6 AND o.link_id=$7 AND o.outcome='published'
          AND o.commit_sha=$8 AND o.asset_id=$9 AND o.generation=$10 AND m.tree_sha=$11 AND m.run_id=$12`,
        [input.installationId,input.connectionId,p.proposal_id,input.exportId,input.expectedRevision,versionId,linkId,p.head_commit,g.current.asset.key.id,input.expectedGeneration,g.treeSha,p.run_id])
        if(retained.rowCount===1)return 'retained'
        const live=await context.client.query(`SELECT 1 FROM memory_git_import_outcomes o
          JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
          JOIN memory_git_revision_links l USING(installation_id,connection_id,link_id)
          JOIN memory_git_confirmed_bases b USING(installation_id,connection_id,link_id)
          WHERE o.installation_id=$1 AND o.connection_id=$2 AND o.proposal_id=$3 AND p.export_id=$4
          AND o.proposal_revision=$5 AND p.revision=$5 AND l.version_id=$6 AND l.link_id=$7
          AND o.outcome='published' AND p.state='applied' AND p.head_commit=$8 AND l.commit_sha=$8
          AND l.asset_id=$9 AND p.generation=$10 AND l.tree_sha=$11`,
        [input.installationId,input.connectionId,p.proposal_id,input.exportId,input.expectedRevision,versionId,linkId,p.head_commit,g.current.asset.key.id,input.expectedGeneration,g.treeSha])
        if(live.rowCount!==1)throw new Error('git_confirmation_lost')
        return 'live'
      })
      return {proposalId:p.proposal_id,outcome,versionId,linkId}
    })}catch(error){
      // A concurrent winner may have revoked the asset while this invocation
      // waited for its source locks. Recheck the same exact durable operation.
      try{const confirmed=await confirmedOutcome(grant,input);if(confirmed)return confirmed}catch{/* The original denial remains authoritative. */}
      if(!deps.deferDenied)await denied(input,grant,'apply',error);throw error
    }
  }
  return {
    /** Current read-only gate hint. The apply path repeats all checks and is the
     * only path that can obtain a domain approval capability. */
    async eligibility(context:import('./export-service.js').RegisteredGitBaseContext,p:import('./governance-adapter.js').ImportProposalRow) {
      const reasons:string[]=[]
      const reason=(error:unknown)=>{const code=error instanceof Error?error.message:'';return code==='git_quorum_failed'?'quorum_required':code==='git_identity_unknown'?'identity_unknown':code==='git_policy_changed'?'policy_changed':code==='git_authorization_stale'?'authorization_stale':code==='git_resolution_conflict'?'conflict':'source_invalid'}
      try {
        const changed=p.proposed_document.result.kind==='proposal',g=await prepareGovernedImport(context,p,changed,'read')
        const canReview=![g.author?.membershipId,...g.coauthors.map(a=>a.membershipId)].includes(context.stamp.membershipId)
        let canApply=true
        if(changed)try{await requireImportQuorum(context,g,false)}catch(error){canApply=false;reasons.push(reason(error))}
        return {canReview,canApply,reasons}
      }catch(error){return {canReview:false,canApply:false,reasons:[reason(error)]}}
    },
    recordDenied:denied,
    apply,
    confirmedOutcome:(grant:V2GrantFacts,raw:unknown)=>confirmedOutcome(grant,parse(subject,raw)),
    async applyBatch(grant:V2GrantFacts,requests:unknown[]) {
      if(!Array.isArray(requests)||requests.length>256)throw new Error('git_invalid_request')
      const outcomes=[]
      for(const raw of requests)try{outcomes.push({ok:true as const,result:await apply(grant,raw)})}catch(error){outcomes.push({ok:false as const,code:error instanceof Error&&/^git_[a-z_]+$/.test(error.message)?error.message:'git_apply_failed'})}
      return outcomes
    },
    async review(grant:V2GrantFacts,raw:unknown):Promise<{decisionId:string}> {
      const input=parse(decision,raw)
      try{return await exports.withReviewBase(grant,{installationId:input.installationId,connectionId:input.connectionId,expectedGeneration:input.expectedGeneration,exportId:input.exportId},async context=>{
        const p=await lockImportProposal(context,input)
        expected(context,p,input)
        if(!['awaiting_review','awaiting_identity'].includes(p.state))throw new Error('git_proposal_terminal')
        const g=await prepareGovernedImport(context,p,true)
        if(input.decision==='approve'&&[g.author?.membershipId,...g.coauthors.map(a=>a.membershipId)].includes(context.stamp.membershipId))throw new Error('git_self_review_denied')
        const decisionId=randomUUID()
        await context.client.query(`INSERT INTO memory_git_revision_reviews(decision_id,installation_id,revision_id,reviewer_membership_id,reviewer_membership_revision,reviewer_authorization_epoch,decision)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[decisionId,input.installationId,g.revisionId,context.stamp.membershipId,context.stamp.membershipRevision,context.stamp.authorizationEpoch,input.decision])
        await context.client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,proposal_id,membership_id,membership_revision,authorization_epoch,action,outcome,reason_code)
          VALUES($1,$2,$3,$4,$5,$6,$7,'review','allowed','ok')`,[randomUUID(),input.installationId,input.connectionId,p.proposal_id,context.stamp.membershipId,context.stamp.membershipRevision,context.stamp.authorizationEpoch])
        return {decisionId}
      })}catch(error){if(!deps.deferDenied)await denied(input,grant,'review',error);throw error}
    },
  }
}
