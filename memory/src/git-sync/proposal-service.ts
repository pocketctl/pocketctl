import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { createGitExportService, type RegisteredGitBaseContext } from './export-service.js'
import { decodeAsset, encodeAsset, parseStrictJson } from './codec.js'
import { rawFilesDigest } from './attestation.js'
import { requireCanonicalImportRun } from './governance-adapter.js'
import { asAssetSnapshot, closeAssetNamespace, planAssetMerge, snapshotDigest, type AssetMergePlan } from './merge.js'
import { KNOWLEDGE_ROOT, validateRepositoryFiles } from './paths.js'
import { DigestSchema, RevisionSchema, PortableAssetSchema, type AssetKey, type AssetSnapshot, type ExportBundle, type MergeResult, type RepositoryFile, type SkillAsset, type WikiAsset } from './types.js'

const subject={installationId:z.uuid(),connectionId:z.uuid(),expectedGeneration:RevisionSchema.refine(v=>v!=='0'),exportId:z.uuid()}
const fileSchema=z.object({path:z.string(),mode:z.literal('100644'),bytes:z.instanceof(Uint8Array)}).strict()
const planSchema=z.object({...subject,headCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),files:z.array(fileSchema).max(256)}).strict()
const inputsSchema=z.object({base:DigestSchema,memory:DigestSchema,git:DigestSchema}).strict()
const resolutionSchema=planSchema.extend({proposalId:z.uuid(),expectedRevision:RevisionSchema.refine(v=>v!=='0'),expectedInputs:inputsSchema,
  resolution:z.object({path:z.string(),deleted:z.boolean(),editable:z.unknown()}).strict()}).strict()
type PlanRequest=z.infer<typeof planSchema>
export type ProposalInputs=z.infer<typeof inputsSchema>
export interface GitProposal {
  proposalId:string; revision:string; state:string; key:AssetKey; inputs:ProposalInputs; result:MergeResult
  proposedHash:string; policyHash:string; resolvedDocumentHash?:string
}
/** Internal worker composition: locks run before proposals, finishes with the
 * job fence in this same transaction. Neither hook may open a transaction. */
export interface GitProposalFinalizer {
  before(context:RegisteredGitBaseContext):Promise<boolean>
  finish(context:RegisteredGitBaseContext,proposals:GitProposal[]):Promise<void>
}
export interface ProposalDocument {
  schemaVersion:'git-proposal.v1'; key:AssetKey; inputs:ProposalInputs; gitTreeDigest:string; result:MergeResult; resolvedDocumentHash?:string
  gitSnapshot?:AssetSnapshot
}
interface ProposalRow {
  proposal_id:string;revision:string;state:string;proposed_document:ProposalDocument;policy_hash:string;proposed_hash:string
  head_commit:string;generation:string;export_id:string
  run_id:string;provider_actor_id:string|null
}
const columns='proposal_id,revision::text,state,proposed_document,policy_hash,proposed_hash,head_commit,generation::text,export_id,run_id,provider_actor_id'
const hash=(value:unknown)=>canonicalPayloadHash(value).toString('hex')
const equal=(a:unknown,b:unknown)=>canonicalJsonString(a)===canonicalJsonString(b)
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const r=schema.safeParse(value);if(!r.success)throw new Error('git_invalid_request');return r.data}
const baseRequest=(r:PlanRequest)=>({installationId:r.installationId,connectionId:r.connectionId,expectedGeneration:r.expectedGeneration,exportId:r.exportId})
const dto=(r:ProposalRow):GitProposal=>({proposalId:r.proposal_id,revision:r.revision,state:r.state,key:r.proposed_document.key,inputs:r.proposed_document.inputs,
  result:r.proposed_document.result,policyHash:r.policy_hash,proposedHash:r.proposed_hash,...(r.proposed_document.resolvedDocumentHash?{resolvedDocumentHash:r.proposed_document.resolvedDocumentHash}:{})})
const state=(r:MergeResult)=>r.kind==='conflict'?'conflicted':r.kind==='noop'?'noop':r.kind==='export'?'planned':'awaiting_review'

/** Decode the complete bound subtree. The unchanged original control files are
 * compared byte-for-byte with the verified registered bundle; only assets edit. */
function readGitTree(base:ExportBundle,files:RepositoryFile[]):AssetSnapshot[] {
  validateRepositoryFiles(files)
  const controls=[`${KNOWLEDGE_ROOT}/manifest.yaml`,`${KNOWLEDGE_ROOT}/attestations/${base.exportId}.json`],remaining=new Map(files.map(f=>[f.path,f]))
  for(const path of controls) {
    const expected=base.files.find(f=>f.path===path),actual=remaining.get(path)
    if(!expected||!actual||!Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes)))throw new Error('git_control_file_changed')
    remaining.delete(path)
  }
  const grouped=new Map<string,RepositoryFile[]>()
  for(const file of remaining.values()) {
    if(!file.path.endsWith('.yaml'))continue
    const doc=parseStrictJson(file.bytes)
    if(!doc||typeof doc!=='object'||Array.isArray(doc))throw new Error('unmanaged_file')
    const key=(doc as {key?:AssetKey}).key,b=base.assets.find(s=>equal(s.asset.key,key??null))
    if(!b)throw new Error('unmanaged_file')
    if(grouped.has(b.asset.key.id))throw new Error('duplicate_asset_id')
    grouped.set(b.asset.key.id,[file])
  }
  const consumed=new Set<string>()
  const result=base.assets.map(b=>{
    const entries=grouped.get(b.asset.key.id)
    if(!entries)return {...b,deleted:true}
    if(b.asset.key.kind==='wiki') {
      const directory=entries[0].path.slice(0,entries[0].path.lastIndexOf('/'))
      entries.push(...[...remaining.values()].filter(f=>f.path.startsWith(`${directory}/`)&&f.path.endsWith('.md')))
    }
    for(const file of entries){if(consumed.has(file.path))throw new Error('path_collision');consumed.add(file.path)}
    const asset=decodeAsset(entries,b)
    // v1 represents a whole-Wiki directory rename, but has no independent page
    // path field. Never silently discard a physical page rename accepted by ID.
    if(asset.key.kind==='wiki')for(const file of entries.filter(f=>f.path.endsWith('.md'))) {
      const header=/^<!-- pocketctl:page (.+) -->\n/.exec(Buffer.from(file.bytes).toString('utf8'))!
      const marker=parseStrictJson(Buffer.from(header[1])) as {pageId:string}
      const page=(asset as WikiAsset).immutable.pages.find(p=>p.pageId===marker.pageId)!
      const directory=asset.path.slice(0,asset.path.lastIndexOf('/'))
      if(file.path!==`${directory}/${page.pageKey}.md`)throw new Error('git_wiki_page_path_changed')
    }
    return asAssetSnapshot(asset)
  })
  if(consumed.size!==remaining.size)throw new Error('unmanaged_file')
  return result
}
function checkNamespace(context:RegisteredGitBaseContext,plans:AssetMergePlan[]):AssetMergePlan[] {
  const ids=new Set(plans.map(p=>p.key.id)),outside=context.bindings.filter(b=>!ids.has(b.assetId))
  return closeAssetNamespace(plans,context.current,[`${KNOWLEDGE_ROOT}/manifest.yaml`,`${KNOWLEDGE_ROOT}/attestations`,
    ...outside.map(b=>b.kind==='wiki'?b.path.slice(0,b.path.lastIndexOf('/')):b.path)])
}
function prepare(context:RegisteredGitBaseContext,input:PlanRequest) {
  const git=readGitTree(context.base,input.files)
  const gitTreeDigest=rawFilesDigest(input.files)
  return context.base.assets.map(wireB=>{
    const B=context.confirmedBases.get(wireB.asset.key.id)??wireB
    const M=context.current.find(s=>s.asset.key.id===B.asset.key.id)!,G=git.find(s=>s.asset.key.id===B.asset.key.id)!
    const document:ProposalDocument={schemaVersion:'git-proposal.v1',key:B.asset.key,inputs:{base:snapshotDigest(B),memory:snapshotDigest(M),git:snapshotDigest(G)},gitTreeDigest,gitSnapshot:G,result:planAssetMerge(B,M,G)}
    return {document,B,M,G}
  })
}
/** INTERNAL Ledger service. Callers in later provider orchestration must supply
 * a verified actual commit/tree read; this service performs no remote I/O and
 * grants no authority to Git authors. Returned assets include serverOnly. */
export function createGitProposalService(deps:Parameters<typeof createGitExportService>[0]) {
  const exports=createGitExportService(deps)
  function policyHash(context:RegisteredGitBaseContext,asset:AssetSnapshot) {
    if(asset.asset.key.kind==='skill')return (asset.asset as SkillAsset).immutable.policyHash
    return context.reviewPolicyHash
  }
  async function appliedDocument(context:RegisteredGitBaseContext,prior:ProposalRow,M:AssetSnapshot,G:AssetSnapshot):Promise<ProposalDocument> {
    const {connection:c,client}=context,result=prior.proposed_document.result
    if(result.kind==='conflict'||result.asset.deleted||prior.proposed_hash!==hash(result)
      ||prior.proposed_document.inputs.git!==snapshotDigest(G)||!equal(prior.proposed_document.gitSnapshot,G))throw new Error('git_input_changed')
    const run=await requireCanonicalImportRun(context,prior)
    const proof=await client.query(`SELECT 1 FROM memory_git_import_outcomes o
      JOIN memory_git_revision_links l USING(installation_id,connection_id,link_id,binding_id)
      JOIN memory_git_confirmed_bases b USING(installation_id,connection_id,link_id,binding_id)
      WHERE o.installation_id=$1 AND o.connection_id=$2 AND o.proposal_id=$3 AND o.proposal_revision=$4
        AND l.proposal_id=$3 AND l.asset_id=$5 AND l.version_id=$6 AND l.commit_sha=$7 AND l.tree_sha=$8
        AND l.path=$9 AND b.export_id=$10 AND b.git_hash=$11 AND b.git_document=$12
        AND o.outcome IN('published','draft_appended','linked')`,
    [c.installationId,c.connectionId,prior.proposal_id,prior.revision,M.asset.key.id,M.asset.baseVersionId,prior.head_commit,run.tree_sha,
      M.asset.path,prior.export_id,snapshotDigest(G),G])
    if(proof.rowCount!==1||!equal(context.confirmedBases.get(M.asset.key.id),G)
      ||M.deleted||M.asset.path!==result.asset.asset.path||M.contentHash!==result.asset.contentHash)throw new Error('git_input_changed')
    // Only namespace planning uses current occupancy. The terminal proposal and
    // its original input/result/version are returned and persisted unchanged.
    return {...structuredClone(prior.proposed_document),result:{kind:'noop',asset:M}}
  }
  /** All same-head siblings are locked and assembled before any namespace check
   * or write. Same-input resolutions are authoritative pending revisions too. */
  async function assemble(context:RegisteredGitBaseContext,input:PlanRequest) {
    const prepared=prepare(context,input)
    const priors=(await context.client.query<ProposalRow>(`SELECT ${columns} FROM memory_git_import_proposals
      WHERE installation_id=$1 AND connection_id=$2 AND head_commit=$3 AND proposed_document->'key'->>'id'=ANY($4::text[])
      ORDER BY proposal_id FOR UPDATE`,[input.installationId,input.connectionId,input.headCommit,prepared.map(p=>p.document.key.id)])).rows
    const result=[]
    for(const candidate of prepared) {
      const prior=priors.find(p=>equal(p.proposed_document.key,candidate.document.key)),policy=policyHash(context,candidate.M)
      if(prior) {
        if(prior.export_id!==input.exportId||prior.generation!==input.expectedGeneration||prior.proposed_document.gitTreeDigest!==candidate.document.gitTreeDigest)throw new Error('git_input_changed')
        if(prior.state==='applied') {
          if(prior.policy_hash!==policy)throw new Error('git_policy_changed')
          const document=await appliedDocument(context,prior,candidate.M,candidate.G)
          result.push({...candidate,document,prior,policy});continue
        }
        if(!['conflicted','awaiting_review','noop','planned'].includes(prior.state))throw new Error('git_proposal_terminal')
      }
      const sameInput=prior&&equal(prior.proposed_document.inputs,candidate.document.inputs)&&prior.policy_hash===policy
      result.push({...candidate,document:sameInput?structuredClone(prior.proposed_document):candidate.document,prior,policy})
    }
    return result
  }
  async function persist(context:RegisteredGitBaseContext,input:PlanRequest,document:ProposalDocument,M:AssetSnapshot,policy:string,prior?:ProposalRow) {
    const c=context.connection,stamp=context.stamp,proposalId=prior?.proposal_id??randomUUID(),proposedHash=hash(document.result)
    const values=[proposalId,c.installationId,c.connectionId,input.exportId,c.generation,state(document.result),M.asset.baseRevision,document.inputs.base,document.inputs.memory,proposedHash,policy,document,stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch,input.headCommit]
    const rows=prior?await context.client.query<ProposalRow>(`UPDATE memory_git_import_proposals SET revision=revision+1,state=$6,base_revision=$7,base_hash=$8,local_hash=$9,
      proposed_hash=$10,policy_hash=$11,proposed_document=$12,membership_id=$13,membership_revision=$14,authorization_epoch=$15,updated_at=NOW()
      WHERE proposal_id=$1 AND installation_id=$2 AND connection_id=$3 AND export_id=$4 AND generation=$5 AND head_commit=$16 RETURNING ${columns}`,values)
      :await context.client.query<ProposalRow>(`INSERT INTO memory_git_import_proposals(proposal_id,installation_id,connection_id,export_id,generation,state,base_revision,base_hash,local_hash,proposed_hash,
        policy_hash,proposed_document,membership_id,membership_revision,authorization_epoch,head_commit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${columns}`,values)
    const row=rows.rows[0];if(!row)throw new Error('git_revision_conflict')
    if(document.result.kind==='conflict')for(const conflict of document.result.conflicts)await context.client.query(`INSERT INTO memory_git_conflicts(conflict_id,installation_id,proposal_id,proposal_revision,field,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),c.installationId,proposalId,row.revision,conflict.field,conflict.reason])
    await context.client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,export_id,proposal_id,membership_id,membership_revision,authorization_epoch,action,outcome,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'import',$9,'ok')`,[randomUUID(),c.installationId,c.connectionId,input.exportId,proposalId,stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch,document.result.kind==='noop'?'noop':'pending'])
    return dto(row)
  }
  async function plan(grant:V2GrantFacts,raw:unknown,finalizer?:GitProposalFinalizer):Promise<GitProposal[]> {
      const input=parse(planSchema,raw)
      return exports.withRegisteredBase(grant,baseRequest(input),async context=>{
        if(finalizer&&!await finalizer.before(context)){await finalizer.finish(context,[]);return []}
        const prepared=await assemble(context,input),result:GitProposal[]=[]
        const closed=checkNamespace(context,prepared.map(p=>({key:p.document.key,result:p.document.result})))
        for(const [index,{document,M,policy,prior}] of prepared.entries()) {
          if(prior?.state==='applied') {
            if(!equal(document.result,closed[index].result))throw new Error('git_resolution_conflict')
            result.push(dto(prior));continue
          }
          if(!equal(document.result,closed[index].result)){document.result=closed[index].result;delete document.resolvedDocumentHash}
          if(prior&&equal(prior.proposed_document,document)&&prior.policy_hash===policy){result.push(dto(prior));continue}
          result.push(await persist(context,input,document,M,policy,prior))
        }
        await finalizer?.finish(context,result)
        return result
      })
  }
  async function resolvePrepared(context:RegisteredGitBaseContext,input:z.infer<typeof resolutionSchema>,prepared:Awaited<ReturnType<typeof assemble>>) {
        const selected=prepared.find(p=>p.prior?.proposal_id===input.proposalId),prior=selected?.prior
        if(!prior)throw new Error('git_not_found')
        if(prior.revision!==input.expectedRevision)throw new Error('git_revision_conflict')
        if(!['conflicted','awaiting_review'].includes(prior.state))throw new Error('git_proposal_terminal')
        if(!selected||prior.export_id!==input.exportId||prior.generation!==input.expectedGeneration||prior.head_commit!==input.headCommit
          ||prior.proposed_document.gitTreeDigest!==selected.document.gitTreeDigest||!equal(prior.proposed_document.inputs,input.expectedInputs)
          ||!equal(selected.document.inputs,input.expectedInputs))throw new Error('git_input_changed')
        const policy=selected.policy
        if(prior.policy_hash!==policy)throw new Error('git_policy_changed')
        const asset=PortableAssetSchema.parse({...selected.M.asset,path:input.resolution.path,editable:input.resolution.editable}),resolved=asAssetSnapshot(asset,input.resolution.deleted)
        const result=planAssetMerge(selected.M,selected.M,resolved)
        if(result.kind==='conflict')throw new Error('git_resolution_conflict')
        if(prior.proposed_document.result.kind==='conflict'&&prior.proposed_document.result.conflicts.some(c=>c.reason==='locked')&&!equal(resolved,selected.M))throw new Error('git_resolution_locked')
        const tree=prepared.map(p=>({key:p.document.key,result:p===selected?{kind:'proposal' as const,asset:resolved}:p.document.result}))
        const closed=checkNamespace(context,tree)
        if(!equal(closed,tree))throw new Error('git_resolution_conflict')
        // Validate physical page paths for the complete resolved candidate tree,
        // including already-conflicted peers' current authoritative M.
        const files=tree.flatMap(p=>{const s=p.result.kind==='conflict'?context.current.find(m=>equal(m.asset.key,p.key))!:p.result.asset;return s.deleted?[]:encodeAsset(s.asset)})
        validateRepositoryFiles(files)
        const document:ProposalDocument={...selected.document,result:{kind:'proposal',asset:resolved},resolvedDocumentHash:resolved.contentHash}
        const resolvedProposal=await persist(context,input,document,selected.M,policy,prior)
        if(!equal(prior.proposed_document.result,document.result))await context.client.query(`INSERT INTO memory_git_resolution_authors(installation_id,connection_id,proposal_id,proposal_revision,
          resolver_membership_id,resolver_membership_revision,resolver_authorization_epoch,document_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.installationId,input.connectionId,prior.proposal_id,resolvedProposal.revision,
          context.stamp.membershipId,context.stamp.membershipRevision,context.stamp.authorizationEpoch,hash(document)])
        return resolvedProposal
  }
  return {
    plan:(grant:V2GrantFacts,raw:unknown)=>plan(grant,raw),
    planWithFinalizer:plan,
    async resolve(grant:V2GrantFacts,raw:unknown):Promise<GitProposal> {
      const input=parse(resolutionSchema,raw)
      return exports.withRegisteredBase(grant,baseRequest(input),async context=>resolvePrepared(context,input,await assemble(context,input)))
    },
    /** Foreground resolution only consumes the exact saved provider G. No raw
     * tree, trusted commit, author or fetch target is accepted from HTTP. */
    async resolveRegistered(grant:V2GrantFacts,raw:unknown):Promise<GitProposal> {
      const input=parse(resolutionSchema.omit({files:true,headCommit:true}).extend({expectedPolicyHash:DigestSchema,expectedProposedHash:DigestSchema,expectedAssetRevision:RevisionSchema}).strict(),raw)
      return exports.withRegisteredBase(grant,baseRequest({...input,headCommit:'',files:[]}),async context=>{
        const observed=(await context.client.query<ProposalRow>(`SELECT ${columns} FROM memory_git_import_proposals WHERE installation_id=$1 AND connection_id=$2 AND proposal_id=$3`,[input.installationId,input.connectionId,input.proposalId])).rows[0]
        if(!observed)throw new Error('git_not_found')
        if(observed.run_id)await context.client.query('SELECT 1 FROM memory_git_runs WHERE installation_id=$1 AND run_id=$2 FOR SHARE',[input.installationId,observed.run_id])
        const priors=(await context.client.query<ProposalRow>(`SELECT ${columns} FROM memory_git_import_proposals WHERE installation_id=$1 AND connection_id=$2 AND head_commit=$3 ORDER BY proposal_id FOR UPDATE`,[input.installationId,input.connectionId,observed.head_commit])).rows
        const p=priors.find(row=>row.proposal_id===input.proposalId)
        if(!p||p.run_id!==observed.run_id)throw new Error('git_input_changed')
        await requireCanonicalImportRun(context,p)
        if(p.policy_hash!==input.expectedPolicyHash)throw new Error('git_policy_changed')
        if(p.proposed_hash!==input.expectedProposedHash)throw new Error('git_revision_conflict')
        const current=context.current.find(a=>a.asset.key.id===p.proposed_document.key.id)
        if(current?.asset.baseRevision!==input.expectedAssetRevision)throw new Error('git_revision_conflict')
        const prepared:Awaited<ReturnType<typeof assemble>>=[]
        for(const wire of context.base.assets) {
          const prior=priors.find(r=>equal(r.proposed_document.key,wire.asset.key)),M=context.current.find(a=>equal(a.asset.key,wire.asset.key)),B=context.confirmedBases.get(wire.asset.key.id)??wire,G=prior?.proposed_document.gitSnapshot
          if(!prior||!M||!G||prior.export_id!==input.exportId||prior.generation!==input.expectedGeneration||prior.run_id!==p.run_id||prior.provider_actor_id!==p.provider_actor_id)throw new Error('git_input_changed')
          planAssetMerge(wire,wire,G) // Immutable signed anchors remain enforced.
          const policy=policyHash(context,M)
          if(prior.policy_hash!==policy)throw new Error('git_policy_changed')
          if(prior.state==='applied')prepared.push({document:await appliedDocument(context,prior,M,G),prior,B,M,G,policy})
          else {
            if(!['conflicted','awaiting_review','noop','planned'].includes(prior.state))throw new Error('git_proposal_terminal')
            if(!equal(prior.proposed_document.inputs,{base:snapshotDigest(B),memory:snapshotDigest(M),git:snapshotDigest(G)}))throw new Error('git_input_changed')
            prepared.push({document:structuredClone(prior.proposed_document),prior,B,M,G,policy})
          }
        }
        return resolvePrepared(context,{...input,headCommit:p.head_commit,files:[]},prepared)
      })
    },
  }
}
