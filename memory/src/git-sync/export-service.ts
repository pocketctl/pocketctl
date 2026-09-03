import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import type { SkillPublicationValidationDeps } from '../skills/publication-validation.js'
import { loadSkillPublicationPolicy } from '../skills/policy-service.js'
import { loadEffectiveReviewPolicySnapshot } from '../governance/review-policy.js'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { buildExportBundle, restoreExportBundle, verifyExportBase, rawFilesDigest, rawFileHash, type AttestationKeyRegistry } from './attestation.js'
import { ASSET_KINDS, RevisionSchema, FIELD_MAPPING, PortableAssetSchema, type AssetKey, type ExportBundle, type PortableAsset } from './types.js'
import { collectGitLifecycleSources, readGitAssets, sameGitLifecycleSources, validateSavedGitAssets } from './asset-reader.js'
import { lockGitPolicyScopes, requireGitPermission, requireCurrentGitAuthorization, type GitAuthorizationStamp } from './authorization.js'
import { insertGitSnapshot, lockGitConnection, type GitConnection } from './repository.js'
import { assetContentHash, encodeAsset } from './codec.js'
import { normalizedPathsOverlap, validateRepositoryPath } from './paths.js'
import { isDatabaseRegistry,assertSnapshotKey,type GitAttestationRegistry } from './key-registry.js'

const subject={installationId:z.uuid(),connectionId:z.uuid(),expectedGeneration:RevisionSchema.refine(v=>v!=='0')}
const requestSchema=z.object({...subject,baseCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),purpose:z.enum(['local_preview','external_export']),
  assets:z.array(z.object({kind:z.enum(ASSET_KINDS),id:z.uuid()}).strict()).min(1).max(254)
    .refine(keys=>new Set(keys.map(k=>k.id)).size===keys.length)}).strict()
const registeredSchema=z.object({...subject,exportId:z.uuid()}).strict()
type Subject=z.infer<z.ZodObject<typeof subject>>
function parse<T>(schema:z.ZodType<T>,raw:unknown):T {const value=schema.safeParse(raw);if(!value.success)throw new Error('git_invalid_request');return value.data}
const sourceHash=(assets:PortableAsset[])=>canonicalPayloadHash(assets.map(({exportId:_exportId,...asset})=>asset)).toString('hex')
const snapshots=(assets:PortableAsset[])=>assets.map(asset=>({asset,contentHash:assetContentHash(asset),deleted:false}))
export interface RegisteredGitBaseContext {
  client:pg.PoolClient; connection:GitConnection; stamp:GitAuthorizationStamp
  base:ExportBundle; current:ReturnType<typeof snapshots>
  reviewPolicyHash:string
  bindings:{assetId:string;kind:string;path:string}[]
  lockedMembershipIds:ReadonlySet<string>
  confirmedBases:Map<string,import('./types.js').AssetSnapshot>
  sourceContext:import('./asset-reader.js').GitReaderInput
  /** Internal, single exact governed revoke, after ordinary confirmation fences.
   * The closure must perform domain approval and retained-outcome revalidation. */
  finalizeRevoke(action:()=>Promise<void>):void
  /** Prepared Claim activation may leave this connection intact or invalidate
   * it through a dependent Skill. The closure proves the exact live/retained
   * operation and reports which proof survived; callers cannot choose an epoch. */
  finalizeClaimRevision(action:()=>Promise<'live'|'retained'>):void
}

/** Local Ledger operations only. READ COMMITTED plus lifecycle/source/head locks
 * and final materialization recheck form one consistent baseline, without a stale
 * MVCC snapshot established before waiting on a purge lock. No remote Git I/O. */
export function createGitExportService(deps:{pool:pg.Pool;keys:GitAttestationRegistry;skill:SkillPublicationValidationDeps}) {
  async function transaction<T>(grant:V2GrantFacts,input:Subject,keys:AssetKey[],run:(client:pg.PoolClient,connection:GitConnection,
    reader:(exportId:string,purpose:'local_preview'|'external_export')=>Promise<PortableAsset[]>,
    validateBase:(bundle:ExportBundle)=>Promise<void>,stamp:GitAuthorizationStamp,reviewPolicyHash:string,keyView:AttestationKeyRegistry,
    lockedMembershipIds:ReadonlySet<string>,lifecycle:import('../skills/source-resolver.js').SkillPrelockedLifecycle)=>Promise<T>,savedAssets:readonly PortableAsset[]=[],purpose:'read'|'contribute'|'review'|'publish'='contribute',writeIntent=false):Promise<T> {
    const client=await deps.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const keyView=isDatabaseRegistry(deps.keys)?await deps.keys.transactionView(client):deps.keys
      const observed=(await client.query<{repository_id:string}>('SELECT repository_id FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2',[input.installationId,input.connectionId])).rows[0]
      if(!observed)throw new Error('git_not_found')
      const lifecycle=await collectGitLifecycleSources(client,input.installationId,observed.repository_id,keys,savedAssets)
      for(const session of lifecycle.sessionIds)await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2,0))`,[input.installationId,session])
      const policyScopes=await lockGitPolicyScopes(client,grant,input.installationId)
      const stamp=await requireGitPermission(client,grant,input.installationId,purpose)
      // Scope membership edits take these locks before source/task locks too. The
      // complete bounded set includes current reviewers and historical publisher.
      const members=await client.query('SELECT membership_id FROM memory_scope_memberships WHERE installation_id=$1 ORDER BY membership_id LIMIT 4097 FOR SHARE',[input.installationId])
      if(members.rows.length>4096)throw new Error('git_source_limit')
      // Target and inherited parent scopes are already locked and revalidated.
      // Lock all policy heads in stable order before any repository/domain lock;
      // the existing policy loader below only revisits these known held rows.
      const heads=await client.query(`SELECT h.policy_id FROM memory_review_policy_heads h JOIN memory_review_policy_sets s USING(policy_id)
        WHERE s.installation_id=ANY($1::uuid[]) ORDER BY s.installation_id FOR SHARE OF h`,[policyScopes])
      if(heads.rowCount!==policyScopes.length)throw new Error('git_policy_scope_stale')
      const reviewPolicyHash=canonicalPayloadHash(await loadEffectiveReviewPolicySnapshot(client,input.installationId,{ensure:false})).toString('hex')
      if(keys.some(key=>key.kind==='skill'))await loadSkillPublicationPolicy(client,input.installationId)
      for(const repository of lifecycle.repositoryIds) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`,[input.installationId,repository])
        const alive=await client.query(`SELECT 1 FROM repositories r WHERE installation_id=$1 AND repository_id=$2
          AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id) FOR SHARE`,[input.installationId,repository])
        if(!alive.rowCount)throw new Error('git_source_stale')
      }
      if(!sameGitLifecycleSources(lifecycle,await collectGitLifecycleSources(client,input.installationId,observed.repository_id,keys,savedAssets)))throw new Error('git_source_stale')
      if(writeIntent) {
        // Acquire exclusive intent BEFORE readers can hold a shared mutable head
        // and BEFORE connection/proposal locks, including repo-null shared Claims.
        const claims=keys.filter(k=>k.kind==='claim'||k.kind==='rule').map(k=>k.id),wikis=keys.filter(k=>k.kind==='wiki').map(k=>k.id),skills=keys.filter(k=>k.kind==='skill').map(k=>k.id)
        await client.query('SELECT claim_id FROM knowledge_claims WHERE installation_id=$1 AND claim_id=ANY($2::uuid[]) ORDER BY claim_id FOR UPDATE',[input.installationId,claims])
        // Wiki build/publication writers lock run before wiki. Capture both
        // original and current published builds before taking mutable Wiki rows;
        // a changed head retries instead of discovering another run lock late.
        const discoverBuilds=async()=> (await client.query<{build_run_id:string}>(`SELECT DISTINCT v.build_run_id FROM memory_wiki_versions v
          JOIN memory_wiki_heads h ON h.installation_id=v.installation_id AND h.wiki_id=v.wiki_id
          WHERE v.installation_id=$1 AND v.wiki_id=ANY($2::uuid[]) AND v.build_run_id IS NOT NULL
            AND (v.wiki_version_id=h.active_version_id OR v.wiki_version_id=ANY($3::uuid[])) ORDER BY v.build_run_id`,
        [input.installationId,wikis,savedAssets.filter(a=>a.key.kind==='wiki').map(a=>a.baseVersionId)])).rows.map(r=>r.build_run_id)
        const buildIds=await discoverBuilds()
        await client.query('SELECT run_id FROM memory_wiki_build_runs WHERE installation_id=$1 AND run_id=ANY($2::uuid[]) ORDER BY run_id FOR SHARE',[input.installationId,buildIds])
        await client.query('SELECT wiki_id FROM memory_wikis WHERE installation_id=$1 AND wiki_id=ANY($2::uuid[]) ORDER BY wiki_id FOR UPDATE',[input.installationId,wikis])
        await client.query('SELECT wiki_id FROM memory_wiki_heads WHERE installation_id=$1 AND wiki_id=ANY($2::uuid[]) ORDER BY wiki_id FOR UPDATE',[input.installationId,wikis])
        if(canonicalJsonString(buildIds)!==canonicalJsonString(await discoverBuilds()))throw new Error('git_source_stale')
        await client.query('SELECT wiki_id FROM memory_wiki_manual_section_heads WHERE installation_id=$1 AND wiki_id=ANY($2::uuid[]) ORDER BY wiki_id,section_key FOR UPDATE',[input.installationId,wikis])
        await client.query(`SELECT t.task_id FROM memory_skill_tasks t JOIN memory_skills s USING(installation_id,task_id)
          WHERE s.installation_id=$1 AND s.skill_id=ANY($2::uuid[]) ORDER BY t.task_id FOR UPDATE OF t`,[input.installationId,skills])
        await client.query('SELECT skill_id FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=ANY($2::uuid[]) ORDER BY skill_id FOR UPDATE',[input.installationId,skills])
      }
      // Read, do not lock connection until every source head has been validated.
      const c=(await client.query(`SELECT connection_id AS "connectionId",installation_id AS "installationId",repository_id AS "repositoryId",
        owner_scope_kind AS "ownerScopeKind",owner_scope_id AS "ownerScopeId",provider,provider_repository_id AS "providerRepositoryId",target_branch AS "targetBranch",
        root_path AS "rootPath",sync_mode AS "syncMode",write_mode AS "writeMode",state,generation::text
        FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2`,[input.installationId,input.connectionId])).rows[0] as GitConnection|undefined
      if(!c||c.repositoryId!==observed.repository_id||c.ownerScopeKind!==stamp.ownerScopeKind||c.ownerScopeId!==stamp.ownerScopeId)throw new Error('git_source_stale')
      if(c.generation!==input.expectedGeneration)throw new Error('git_generation_conflict')
      if(c.state!=='active'||c.syncMode==='off')throw new Error('git_connection_disabled')
      const temporal={versionIds:new Set<string>(),membershipIds:new Set<string>()}
      const reader=(exportId:string,purpose:'local_preview'|'external_export')=>readGitAssets(client,{connection:c,grant,exportId,purpose,lifecycle,skill:deps.skill,temporal},keys)
      const validateBase=(bundle:ExportBundle)=>validateSavedGitAssets(client,{connection:c,grant,exportId:bundle.exportId,purpose:bundle.purpose,lifecycle,skill:deps.skill,temporal},bundle.assets.map(s=>s.asset))
      const result=await run(client,c,reader,validateBase,stamp,reviewPolicyHash,keyView,new Set(members.rows.map(row=>row.membership_id as string)),lifecycle)
      // Exact dependencies were validated and row-locked before connection wait.
      // This final clock-only fence acquires no new source/lifecycle locks and
      // deliberately ignores unrelated installation memberships.
      const versions=[...temporal.versionIds],temporalMembers=[...temporal.membershipIds]
      const validVersions=await client.query(`SELECT version_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=ANY($2::uuid[])
        AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())`,[input.installationId,versions])
      const validMembers=await client.query(`SELECT membership_id FROM memory_scope_memberships WHERE installation_id=$1 AND membership_id=ANY($2::uuid[])
        AND state='active' AND (valid_from IS NULL OR valid_from<=clock_timestamp()) AND (valid_until IS NULL OR valid_until>clock_timestamp())`,[input.installationId,temporalMembers])
      if(validVersions.rowCount!==versions.length||validMembers.rowCount!==temporalMembers.length)throw new Error('git_source_stale')
      await requireCurrentGitAuthorization(client,stamp,purpose)
      await client.query('COMMIT')
      return result
    } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  }
  async function restore(client:pg.PoolClient,installationId:string,connectionId:string,exportId:string,lock=true) {
    const saved=(await client.query(`SELECT attestation FROM memory_git_snapshots WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3
      AND (expires_at IS NULL OR expires_at>clock_timestamp()) ${lock?'FOR SHARE':''}`,[installationId,connectionId,exportId])).rows[0]
    if(!saved)throw new Error('git_export_unregistered')
    const assetRows=(await client.query<{base_document:PortableAsset;content_hash:string}>('SELECT base_document,content_hash FROM memory_git_snapshot_assets WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 ORDER BY path',[installationId,connectionId,exportId])).rows
    return restoreExportBundle(assetRows.map(row=>({asset:row.base_document,contentHash:row.content_hash,deleted:false})),saved.attestation)
  }
  async function verifyCurrent(bundle:ExportBundle,c:GitConnection,client:pg.PoolClient,keys:AttestationKeyRegistry) {
    // Task 8 uses connection generation as the common tombstone/lifecycle fence.
    // tombstoneGeneration is deliberately the same authoritative counter.
    if(isDatabaseRegistry(deps.keys))await assertSnapshotKey(client,bundle)
    verifyExportBase(bundle,{installationId:c.installationId,repositoryId:c.repositoryId,connectionId:c.connectionId,generation:c.generation,
      tombstoneGeneration:c.generation,exportId:bundle.exportId,baseCommit:bundle.baseCommit,purpose:bundle.purpose,publishable:bundle.publishable},keys)
  }
  /** INTERNAL transaction composition, never an HTTP callback. Original B and
   * current editable M are materialized under their union lifecycle locks before
   * connection/snapshot locks. Callers may lock/write proposals but must not call
   * public pool services or discover new Session/repository locks here. */
  async function registered<T>(grant:V2GrantFacts,raw:unknown,run:(context:RegisteredGitBaseContext)=>Promise<T>,permission:'read'|'contribute'|'review'|'publish'):Promise<T> {
    const input=parse(registeredSchema,raw)
    // Authorize before even the unlocked lifecycle discovery read. The source
    // transaction below independently revalidates in its normal lock order.
    const preflight=await deps.pool.connect()
    try {await preflight.query('BEGIN');await requireGitPermission(preflight,grant,input.installationId,permission);await preflight.query('COMMIT')}
    catch(error){await preflight.query('ROLLBACK');throw error}finally{preflight.release()}
    const found=await deps.pool.query<{base_document:PortableAsset}>('SELECT base_document FROM memory_git_snapshot_assets WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 ORDER BY path',[input.installationId,input.connectionId,input.exportId])
    if(!found.rowCount)throw new Error('git_export_unregistered')
    const savedAssets=found.rows.map(row=>PortableAssetSchema.parse(row.base_document)),keys=savedAssets.map(asset=>asset.key)
    return transaction(grant,input,keys,async(client,c,reader,validateBase,stamp,reviewPolicyHash,keyView,lockedMembershipIds,lifecycle)=>{
      const observed=await restore(client,c.installationId,c.connectionId,input.exportId,false)
      if(canonicalJsonString(observed.assets.map(s=>s.asset))!==canonicalJsonString(savedAssets))throw new Error('git_source_stale')
      await verifyCurrent(observed,c,client,keyView)
      await validateBase(observed)
      await reader(observed.exportId,observed.purpose)
      const current=await reader(observed.exportId,'local_preview')
      await validateBase(observed)
      if(canonicalJsonString(current)!==canonicalJsonString(await reader(observed.exportId,'local_preview')))throw new Error('git_source_stale')
      const bindings=(await client.query<{assetId:string;kind:string;path:string}>(`SELECT asset_id AS "assetId",kind,path FROM memory_git_asset_bindings
        WHERE installation_id=$1 AND connection_id=$2 ORDER BY asset_id LIMIT 4097 FOR ${permission==='publish'?'UPDATE':'SHARE'}`,[c.installationId,c.connectionId])).rows
      if(bindings.length>4096)throw new Error('git_source_limit')
      for(const asset of current) {
        const binding=bindings.find(b=>b.assetId===asset.key.id&&b.kind===asset.key.kind)
        if(!binding)throw new Error('git_source_stale')
        asset.path=binding.path
      }
      await lockGitConnection(client,c.installationId,c.connectionId,input.expectedGeneration)
      // Private target configuration stays in this closure, never the safe
      // GitConnection DTO or registered callback context.
      const target=(await client.query('SELECT target_id,credential_ref FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2',
        [c.installationId,c.connectionId])).rows[0]
      const base=await restore(client,c.installationId,c.connectionId,input.exportId)
      await verifyCurrent(base,c,client,keyView)
      const confirmedBases=new Map<string,import('./types.js').AssetSnapshot>()
      const confirmed=await client.query<{asset_id:string;git_document:import('./types.js').AssetSnapshot;git_hash:string}>(`SELECT DISTINCT ON(b.asset_id) b.asset_id,c.git_document,c.git_hash
        FROM memory_git_confirmed_bases c JOIN memory_git_asset_bindings b USING(installation_id,connection_id,binding_id)
        WHERE c.installation_id=$1 AND c.connection_id=$2 AND c.export_id=$3 ORDER BY b.asset_id,c.sequence DESC`,[c.installationId,c.connectionId,input.exportId])
      for(const row of confirmed.rows) {
        PortableAssetSchema.parse(row.git_document.asset)
        if(canonicalPayloadHash({asset:row.git_document.asset,deleted:row.git_document.deleted}).toString('hex')!==row.git_hash)throw new Error('git_input_changed')
        confirmedBases.set(row.asset_id,row.git_document)
      }
      let revoke:(()=>Promise<void>)|undefined
      let claimRevision:(()=>Promise<'live'|'retained'>)|undefined
      const result=await run({client,connection:c,stamp,base,current:snapshots(current),bindings,reviewPolicyHash,lockedMembershipIds,confirmedBases,
        finalizeRevoke:action=>{if(permission!=='publish'||revoke||claimRevision)throw new Error('git_governance_required');revoke=action},
        finalizeClaimRevision:action=>{if(permission!=='publish'||revoke||claimRevision)throw new Error('git_governance_required');claimRevision=action},
        sourceContext:{connection:c,grant,exportId:base.exportId,purpose:'local_preview',lifecycle,skill:deps.skill}})
      // No new earlier lifecycle locks after proposal mutation. Snapshot expiry
      // and a synchronously revoked key must still fail before COMMIT.
      await verifyCurrent(await restore(client,c.installationId,c.connectionId,input.exportId),c,client,keyView)
      await lockGitConnection(client,c.installationId,c.connectionId,input.expectedGeneration)
      await requireCurrentGitAuthorization(client,stamp,permission)
      if(revoke||claimRevision){
        const proof=claimRevision?await claimRevision():await revoke!().then(()=>'retained' as const)
        // Only the exact lifecycle increment made by this original transaction
        // is accepted. Revocation does not waive current mode/target fences.
        const epoch=(await client.query<{generation:string}>(`SELECT generation::text FROM memory_git_lifecycle_epochs
          WHERE installation_id=$1 AND connection_id=$2 AND transaction_id=txid_current()`,[c.installationId,c.connectionId])).rows[0]
        if(proof==='retained'&&(!epoch||BigInt(epoch.generation)!==BigInt(c.generation)+1n)
          ||proof==='live'&&epoch)throw new Error('git_generation_conflict')
        const final=await lockGitConnection(client,c.installationId,c.connectionId,proof==='retained'?epoch!.generation:c.generation)
        const finalTarget=(await client.query('SELECT target_id,credential_ref FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2',
          [c.installationId,c.connectionId])).rows[0]
        if(final.state!==c.state||final.syncMode!==c.syncMode||final.provider!==c.provider||final.providerRepositoryId!==c.providerRepositoryId
          ||final.targetBranch!==c.targetBranch||final.repositoryId!==c.repositoryId||final.rootPath!==c.rootPath||final.writeMode!==c.writeMode
          ||final.ownerScopeKind!==c.ownerScopeKind||final.ownerScopeId!==c.ownerScopeId
          ||finalTarget.target_id!==target.target_id||finalTarget.credential_ref!==target.credential_ref)throw new Error('git_source_stale')
      }
      return result
    },savedAssets,permission,permission==='publish')
  }
  return {
    withReadBase:<T>(grant:V2GrantFacts,raw:unknown,run:(context:RegisteredGitBaseContext)=>Promise<T>)=>registered(grant,raw,run,'read'),
    withRegisteredBase:<T>(grant:V2GrantFacts,raw:unknown,run:(context:RegisteredGitBaseContext)=>Promise<T>)=>registered(grant,raw,run,'contribute'),
    withReviewBase:<T>(grant:V2GrantFacts,raw:unknown,run:(context:RegisteredGitBaseContext)=>Promise<T>)=>registered(grant,raw,run,'review'),
    withApplyBase:<T>(grant:V2GrantFacts,raw:unknown,run:(context:RegisteredGitBaseContext)=>Promise<T>)=>registered(grant,raw,run,'publish'),
    async export(grant:V2GrantFacts,raw:unknown):Promise<ExportBundle> {
      const input=parse(requestSchema,raw)
      return transaction(grant,input,input.assets,async(client,c,reader,_validate,_stamp,_policy,keyView)=>{
        const exportId=randomUUID(),assets=await reader(exportId,input.purpose)
        // Read again before taking connection/snapshot locks. Source/head facts
        // discovered before any wait cannot silently enter the signed baseline.
        const current=await reader(exportId,input.purpose)
        if(canonicalJsonString(assets)!==canonicalJsonString(current))throw new Error('git_source_stale')
        // Bindings precede connection ownership, as in registered-base reads.
        // A confirmed rename is part of export identity before dedupe/signing.
        const bindings=(await client.query<{asset_id:string;kind:string;path:string}>(`SELECT asset_id,kind,path FROM memory_git_asset_bindings
          WHERE installation_id=$1 AND connection_id=$2 ORDER BY asset_id LIMIT 4097 FOR SHARE`,[c.installationId,c.connectionId])).rows
        if(bindings.length>4096)throw new Error('git_source_limit')
        for(const asset of assets){const binding=bindings.find(b=>b.asset_id===asset.key.id)
          if(binding){if(binding.kind!==asset.key.kind)throw new Error('git_binding_conflict');asset.path=binding.path}}
        const outside=bindings.filter(b=>!assets.some(a=>a.key.id===b.asset_id))
          .map(b=>validateRepositoryPath(b.kind==='wiki'?b.path.slice(0,b.path.lastIndexOf('/')):b.path))
        if(assets.flatMap(encodeAsset).some(f=>outside.some(path=>normalizedPathsOverlap(validateRepositoryPath(f.path),path))))throw new Error('path_collision')
        const sourceDigest=sourceHash(assets)
        await lockGitConnection(client,c.installationId,c.connectionId,c.generation)
        const prior=await client.query<{export_id:string}>(`SELECT export_id FROM memory_git_snapshots
          WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 AND base_commit=$4 AND source_digest=$5
            AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY created_at DESC,export_id LIMIT 32`,
          [c.installationId,c.connectionId,c.generation,input.baseCommit,sourceDigest])
        for(const row of prior.rows) {
          const bundle=await restore(client,c.installationId,c.connectionId,row.export_id)
          if(bundle.purpose!==input.purpose)continue
          // A revoked signing key requires a fresh signed baseline. Corrupt
          // stored content is not silently repaired by producing another export.
          const envelope=JSON.parse(Buffer.from(bundle.attestation).toString()) as {descriptor:{keyId:string}}
          if(keyView.verificationKey(envelope.descriptor.keyId)?.state==='revoked')continue
          if(isDatabaseRegistry(deps.keys)){try{await assertSnapshotKey(client,bundle)}catch{continue}}
          await verifyCurrent(bundle,c,client,keyView);return bundle
        }
        const bundle=buildExportBundle({installationId:c.installationId,repositoryId:c.repositoryId,connectionId:c.connectionId,generation:c.generation,
          tombstoneGeneration:c.generation,exportId,baseCommit:input.baseCommit,purpose:input.purpose,publishable:input.purpose==='external_export'},snapshots(assets),keyView)
        await insertGitSnapshot(client,{installationId:c.installationId,connectionId:c.connectionId,exportId,generation:c.generation,baseCommit:input.baseCommit,
          sourceDigest,manifestHash:rawFileHash(bundle.files.find(file=>file.path.endsWith('/manifest.yaml'))!.bytes),attestation:bundle.attestation,
          assets:bundle.assets.map(snapshot=>({asset:snapshot.asset,contentHash:snapshot.contentHash,fileHash:rawFilesDigest(encodeAsset(snapshot.asset)),fieldMap:FIELD_MAPPING[snapshot.asset.key.kind]}))})
        if(isDatabaseRegistry(deps.keys))await client.query(`INSERT INTO memory_git_snapshot_keys(installation_id,connection_id,export_id,key_id) VALUES($1,$2,$3,$4)`,
          [c.installationId,c.connectionId,exportId,keyView.signingKey().keyId])
        return bundle
      })
    },
    /** Import consumers use this registered-base boundary, not offline signature
     * verification alone. Current authorization/sources, expiry and generation
     * are checked even when an old signature remains cryptographically valid. */
    async loadRegisteredBase(grant:V2GrantFacts,raw:unknown):Promise<ExportBundle> {
      const input=parse(registeredSchema,raw)
      const found=await deps.pool.query<{base_document:PortableAsset}>('SELECT base_document FROM memory_git_snapshot_assets WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 ORDER BY path',[input.installationId,input.connectionId,input.exportId])
      if(!found.rowCount)throw new Error('git_export_unregistered')
      const savedAssets=found.rows.map(row=>PortableAssetSchema.parse(row.base_document)),keys=savedAssets.map(asset=>asset.key)
      return transaction(grant,input,keys,async(client,c,reader,validateBase,_stamp,_policy,keyView)=>{
        const observed=await restore(client,c.installationId,c.connectionId,input.exportId,false)
        if(canonicalJsonString(observed.assets.map(s=>s.asset))!==canonicalJsonString(savedAssets))throw new Error('git_source_stale')
        await verifyCurrent(observed,c,client,keyView)
        await validateBase(observed)
        await reader(observed.exportId,observed.purpose)
        await validateBase(observed)
        await lockGitConnection(client,c.installationId,c.connectionId,input.expectedGeneration)
        const bundle=await restore(client,c.installationId,c.connectionId,input.exportId)
        await verifyCurrent(bundle,c,client,keyView)
        return bundle
      },savedAssets)
    },
  }
}
