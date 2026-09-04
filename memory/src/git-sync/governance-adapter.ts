import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { currentReviewDecisions, evaluateQuorum } from '../governance/authority.js'
import { loadEffectiveReviewPolicySnapshot } from '../governance/review-policy.js'
import type { RegisteredGitBaseContext } from './export-service.js'
import type { ProposalDocument } from './proposal-service.js'
import { asAssetSnapshot, closeAssetNamespace, planAssetMerge, snapshotDigest } from './merge.js'
import { KNOWLEDGE_ROOT } from './paths.js'
import { PortableAssetSchema, type AssetSnapshot, type SkillAsset } from './types.js'

export const gitHash=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const same=(a:unknown,b:unknown)=>canonicalJsonString(a)===canonicalJsonString(b)
export interface ImportSubject {installationId:string;connectionId:string;expectedGeneration:string;exportId:string;proposalId:string;expectedRevision:string}
export interface ImportProposalRow {
  proposal_id:string;revision:string;state:string;export_id:string;run_id:string;generation:string;head_commit:string;
  base_revision:string;base_hash:string;local_hash:string;proposed_hash:string;policy_hash:string;authorization_epoch:string;
  proposed_document:ProposalDocument;provider_actor_id:string|null
  created_at:Date
}
export interface GitActor {membershipId:string;membershipRevision:string;authorizationEpoch:string}
export interface GovernedImport {
  proposal:ImportProposalRow;current:AssetSnapshot;git:AssetSnapshot;author:GitActor|null;coauthors:GitActor[];
  revisionId:string|null;policy:Awaited<ReturnType<typeof loadEffectiveReviewPolicySnapshot>>;countedDecisionIds:string[];
  treeSha:string
}
const approvals=new WeakMap<GovernedImport,{transactionId:string;hash:string;publisherMembershipId:string}>()
const readPreparations=new WeakSet<GovernedImport>()
const approvalHash=(g:GovernedImport)=>gitHash({proposal:g.proposal,current:g.current,author:g.author,coauthors:g.coauthors,revisionId:g.revisionId,
  policy:g.policy,countedDecisionIds:g.countedDecisionIds})
/** Non-serializable approval proof valid only inside the transaction that checked
 * all author/reviewer/policy fences. Domain methods cannot be called with a
 * request-shaped substitute or reuse this proof after locks have been released. */
export async function assertImportApproval(client:Pick<pg.PoolClient,'query'>,g:GovernedImport,publisherMembershipId?:string|null):Promise<void> {
  const proof=g&&approvals.get(g)
  if(!proof||proof.hash!==approvalHash(g)||(publisherMembershipId!==undefined&&publisherMembershipId!==proof.publisherMembershipId)
    ||(await client.query('SELECT txid_current()::text AS id')).rows[0].id!==proof.transactionId)throw new Error('git_governance_required')
}
export async function lockImportProposal(context:RegisteredGitBaseContext,input:ImportSubject):Promise<ImportProposalRow> {
  const observed=(await context.client.query('SELECT run_id FROM memory_git_import_proposals WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3',
    [input.installationId,input.connectionId,input.proposalId])).rows[0]
  if(!observed)throw new Error('git_not_found')
  if(observed.run_id)await context.client.query('SELECT 1 FROM memory_git_runs WHERE installation_id=$1 AND run_id=$2 FOR UPDATE',[input.installationId,observed.run_id])
  const row=(await context.client.query<ImportProposalRow>(`SELECT *,revision::text,base_revision::text,generation::text,authorization_epoch::text
    FROM memory_git_import_proposals WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3 FOR UPDATE`,
  [input.installationId,input.connectionId,input.proposalId])).rows[0]
  if(!row||row.export_id!==input.exportId)throw new Error('git_not_found')
  if(row.run_id!==observed.run_id)throw new Error('git_input_changed')
  if(row.revision!==input.expectedRevision||row.generation!==input.expectedGeneration)throw new Error('git_revision_conflict')
  return row
}
/** No new participant locks here: all membership rows were held before sources
 * and connection. A newly inserted mapping to an unseen member fails closed. */
export async function requireImportActor(context:RegisteredGitBaseContext,actor:GitActor,permission:'contribute'|'review'|'publish') {
  if(!context.lockedMembershipIds.has(actor.membershipId))throw new Error('git_authorization_stale')
  const role=permission==='contribute'?['contributor','scope_administrator']:permission==='review'?['reviewer','publisher','scope_administrator']:['publisher','scope_administrator']
  const result=await context.client.query(`SELECT 1 FROM memory_scope_memberships WHERE installation_id=$1 AND membership_id=$2
    AND membership_revision=$3 AND state='active' AND roles && $4::text[]
    AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())`,
  [context.connection.installationId,actor.membershipId,actor.membershipRevision,role])
  if(!result.rowCount||actor.authorizationEpoch!==context.stamp.authorizationEpoch)throw new Error('git_authorization_stale')
}
/** Shared internal provenance fence, including conflicted proposals which cannot
 * enter approval preparation yet. Caller locks run before proposal rows. */
export async function requireCanonicalImportRun(context:RegisteredGitBaseContext,p:Pick<ImportProposalRow,'run_id'|'export_id'|'head_commit'|'provider_actor_id'>) {
  const {client,connection:c}=context
  if(!p.run_id)throw new Error('git_source_stale')
  const run=(await client.query(`SELECT r.*,m.tree_sha AS verified_tree FROM memory_git_runs r
    JOIN memory_git_merge_receipts m ON m.installation_id=r.installation_id AND m.connection_id=r.connection_id AND m.run_id=r.run_id
      AND m.generation=r.generation AND m.commit_sha=r.merge_commit
    JOIN memory_git_run_receipts rr ON rr.installation_id=r.installation_id AND rr.run_id=r.run_id
    WHERE r.installation_id=$1 AND r.connection_id=$2 AND r.run_id=$3 AND rr.eligible
      AND rr.state IN('verified','planned') AND r.state IN('verified','planned','awaiting_review','applied') FOR SHARE OF r`,[c.installationId,c.connectionId,p.run_id])).rows[0]
  if(!run||run.generation!==c.generation||run.export_id!==p.export_id||run.merge_commit!==p.head_commit||run.tree_sha!==run.verified_tree
    ||run.provider_actor_id!==p.provider_actor_id||run.authorization_epoch!==context.stamp.authorizationEpoch||run.config_version!==context.stamp.configVersion)throw new Error('git_source_stale')
  await requireImportActor(context,{membershipId:run.membership_id,membershipRevision:run.membership_revision,authorizationEpoch:run.authorization_epoch},'contribute')
  return run
}
export async function prepareGovernedImport(context:RegisteredGitBaseContext,p:ImportProposalRow,identityRequired:boolean,mode:'write'|'read'='write'):Promise<GovernedImport> {
  const {client,connection:c}=context,document=p.proposed_document,current=context.current.find(a=>a.asset.key.id===document.key.id)
  const wire=context.base.assets.find(a=>a.asset.key.id===document.key.id)
  if(!wire||!current)throw new Error('git_source_stale')
  const run=await requireCanonicalImportRun(context,p)
  const git=document.gitSnapshot
  if(!git)throw new Error('git_input_changed') // Old proposals must be re-planned.
  PortableAssetSchema.parse(git.asset)
  planAssetMerge(wire,wire,git) // Recheck immutable signed wire anchors.
  const base=context.confirmedBases.get(wire.asset.key.id)??wire
  if(!same(document.inputs,{base:snapshotDigest(base),memory:snapshotDigest(current),git:snapshotDigest(git)})
    ||p.base_hash!==document.inputs.base||p.local_hash!==document.inputs.memory||p.proposed_hash!==gitHash(document.result))throw new Error('git_input_changed')
  if(document.result.kind==='conflict')throw new Error('git_resolution_conflict')
  const namespace=closeAssetNamespace([{key:document.key,result:document.result}],context.current,[`${KNOWLEDGE_ROOT}/manifest.yaml`,`${KNOWLEDGE_ROOT}/attestations`,
    ...context.bindings.filter(b=>b.assetId!==document.key.id).map(b=>b.kind==='wiki'?b.path.slice(0,b.path.lastIndexOf('/')):b.path)])
  if(namespace[0].result.kind==='conflict')throw new Error('git_resolution_conflict')
  const next=PortableAssetSchema.parse(document.result.asset.asset)
  if(!same({...next,path:current.asset.path,editable:current.asset.editable},current.asset))throw new Error('immutable_field_changed')
  if(document.result.asset.contentHash!==asAssetSnapshot(next).contentHash)throw new Error('git_input_changed')
  const policy=await loadEffectiveReviewPolicySnapshot(client,c.installationId,{ensure:false})
  const expectedPolicy=current.asset.key.kind==='skill'?(current.asset as SkillAsset).immutable.policyHash:gitHash(policy)
  if(p.policy_hash!==expectedPolicy)throw new Error('git_policy_changed')
  let author:GitActor|null=null
  if(identityRequired) {
    if(!run.provider_actor_id)throw new Error('git_identity_unknown')
    const mapped=(await client.query(`SELECT membership_id,membership_revision::text,authorization_epoch::text FROM memory_git_actor_mappings
      WHERE installation_id=$1 AND connection_id=$2 AND provider_actor_id=$3`,[c.installationId,c.connectionId,run.provider_actor_id])).rows[0]
    if(!mapped)throw new Error('git_identity_unknown')
    author={membershipId:mapped.membership_id,membershipRevision:mapped.membership_revision,authorizationEpoch:mapped.authorization_epoch}
    await requireImportActor(context,author,'contribute')
    if(mode==='write')await client.query(`INSERT INTO memory_git_original_authors(installation_id,connection_id,proposal_id,run_id,provider_actor_id,
      author_membership_id,author_membership_revision,author_authorization_epoch,head_commit,tree_sha)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
    [c.installationId,c.connectionId,p.proposal_id,p.run_id,run.provider_actor_id,author.membershipId,author.membershipRevision,author.authorizationEpoch,p.head_commit,run.tree_sha])
    const saved=(await client.query('SELECT * FROM memory_git_original_authors WHERE installation_id=$1 AND proposal_id=$2',[c.installationId,p.proposal_id])).rows[0]
    if(!saved&&mode==='write')throw new Error('git_authorization_stale')
    if(saved&&(saved.author_membership_id!==author.membershipId||saved.author_membership_revision!==author.membershipRevision||saved.author_authorization_epoch!==author.authorizationEpoch
      ||saved.run_id!==p.run_id||saved.provider_actor_id!==run.provider_actor_id||saved.head_commit!==p.head_commit||saved.tree_sha!==run.tree_sha))throw new Error('git_authorization_stale')
  }
  const resolvers=(await client.query(`SELECT resolver_membership_id,resolver_membership_revision::text,resolver_authorization_epoch::text
    FROM memory_git_resolution_authors WHERE installation_id=$1 AND proposal_id=$2 AND proposal_revision<=$3 ORDER BY proposal_revision`,[c.installationId,p.proposal_id,p.revision])).rows
  const coauthors=resolvers.map(r=>({membershipId:r.resolver_membership_id,membershipRevision:r.resolver_membership_revision,authorizationEpoch:r.resolver_authorization_epoch}))
  for(const resolver of coauthors)await requireImportActor(context,resolver,'contribute')
  let revisionId:string|null=null
  if(identityRequired) {
    const policies=(await client.query(`SELECT s.installation_id,s.policy_id,v.policy_version_id FROM memory_review_policy_versions v
      JOIN memory_review_policy_sets s USING(policy_id) WHERE v.policy_version_id=ANY($1::uuid[])`,[[policy.activeVersionId,policy.parentActiveVersionId].filter(Boolean)])).rows
    const target=policies.find(r=>r.policy_version_id===policy.activeVersionId),parent=policies.find(r=>r.policy_version_id===policy.parentActiveVersionId)
    if(!target||target.installation_id!==c.installationId)throw new Error('git_policy_changed')
    const key=current.asset.key,ids=[key.kind==='claim'||key.kind==='rule'?key.id:null,key.kind==='wiki'?key.id:null,key.kind==='skill'?key.id:null]
    const versions=ids.map(id=>id?current.asset.baseVersionId:null)
    if(mode==='read'&&!(await client.query('SELECT $1::timestamptz+$2*INTERVAL \'1 day\'>clock_timestamp() AS alive',[p.created_at,policy.policy.candidate_ttl_days])).rows[0].alive)throw new Error('git_policy_changed')
    if(mode==='write')await client.query(`INSERT INTO memory_git_governed_revisions(revision_id,installation_id,connection_id,proposal_id,proposal_revision,base_revision,
      kind,claim_id,wiki_id,skill_id,claim_version_id,wiki_version_id,skill_version_id,base_hash,memory_hash,git_hash,proposed_hash,policy_hash,
      review_policy_id,review_policy_version_id,parent_installation_id,parent_policy_id,parent_policy_version_id,authorization_epoch,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$26::timestamptz+$25*INTERVAL '1 day') ON CONFLICT DO NOTHING`,
    [randomUUID(),c.installationId,c.connectionId,p.proposal_id,p.revision,p.base_revision,key.kind,...ids,...versions,document.inputs.base,document.inputs.memory,document.inputs.git,p.proposed_hash,
      gitHash(policy),target.policy_id,policy.activeVersionId,parent?.installation_id??null,parent?.policy_id??null,policy.parentActiveVersionId,context.stamp.authorizationEpoch,policy.policy.candidate_ttl_days,p.created_at])
    const revision=(await client.query(`SELECT *,expires_at>clock_timestamp() AS alive FROM memory_git_governed_revisions WHERE installation_id=$1 AND proposal_id=$2 AND proposal_revision=$3`,[c.installationId,p.proposal_id,p.revision])).rows[0]
    if(revision&&(!revision.alive||revision.policy_hash!==gitHash(policy)||revision.proposed_hash!==p.proposed_hash||revision.memory_hash!==document.inputs.memory
      ||revision.git_hash!==document.inputs.git||revision.base_hash!==document.inputs.base||revision.authorization_epoch!==context.stamp.authorizationEpoch))throw new Error('git_policy_changed')
    if(!revision&&mode==='write')throw new Error('git_policy_changed')
    revisionId=revision?.revision_id??null
    if(mode==='write')for(const evidence of current.asset.immutable.evidence)await client.query(`INSERT INTO memory_git_revision_evidence(installation_id,revision_id,evidence_id,version_id,evidence_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[c.installationId,revisionId,evidence.evidenceId,evidence.versionId,evidence.hash])
  }
  const prepared={proposal:p,current,git,author,coauthors,revisionId,policy,countedDecisionIds:[],treeSha:run.tree_sha}
  if(mode==='read')readPreparations.add(prepared)
  return prepared
}
export async function requireImportQuorum(context:RegisteredGitBaseContext,g:GovernedImport,recordApproval=true):Promise<void> {
  const {client,connection:c}=context
  const decisions=(await client.query(`SELECT decision_id,reviewer_membership_id,reviewer_membership_revision::text,decision FROM memory_git_revision_reviews
    WHERE installation_id=$1 AND revision_id=$2 AND reviewer_authorization_epoch=$3`,[c.installationId,g.revisionId,context.stamp.authorizationEpoch])).rows
  if(decisions.some(d=>!context.lockedMembershipIds.has(d.reviewer_membership_id)))throw new Error('git_authorization_stale')
  const members=(await client.query(`SELECT membership_id,membership_revision::text,state,roles FROM memory_scope_memberships
    WHERE installation_id=$1 AND membership_id=ANY($2::uuid[])
      AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())`,[c.installationId,decisions.map(d=>d.reviewer_membership_id)])).rows
  const authors=new Set([g.author?.membershipId,...g.coauthors.map(a=>a.membershipId)])
  const current=currentReviewDecisions(decisions.map(d=>({decisionId:d.decision_id,membershipId:d.reviewer_membership_id,membershipRevision:d.reviewer_membership_revision,decision:d.decision})),
    members.map(m=>({membershipId:m.membership_id,membershipRevision:m.membership_revision,state:m.state,roles:m.roles})))
    .filter(d=>d.decision!=='approve'||(!authors.has(d.membershipId)&&(g.policy.policy.publisher_may_count_as_reviewer||d.membershipId!==context.stamp.membershipId)))
  const quorum=evaluateQuorum({decisions:current,policy:g.policy.policy,proposerMembershipId:g.author?.membershipId??null,publisherMembershipId:context.stamp.membershipId})
  if(!quorum.ok)throw new Error('git_quorum_failed')
  g.countedDecisionIds=current.filter(d=>quorum.countedDecisionMemberships.includes(d.membershipId)).map(d=>d.decisionId)
  if(recordApproval&&!readPreparations.has(g))approvals.set(g,{transactionId:(await client.query('SELECT txid_current()::text AS id')).rows[0].id,hash:approvalHash(g),publisherMembershipId:context.stamp.membershipId})
}
