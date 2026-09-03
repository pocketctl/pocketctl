import type pg from 'pg'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import type { V2GrantFacts } from '../governance/authorization.js'
import { resolveSkillSource, type SkillPrelockedLifecycle } from '../skills/source-resolver.js'
import { archiveSourceRequest, findSkillArchive } from '../skills/version-repository.js'
import { validateSkillPublicationTarget, type SkillPublicationValidationDeps } from '../skills/publication-validation.js'
import { loadSkillReviewPolicySnapshot } from '../skills/review-policy-binding.js'
import { skillDocumentHash } from '../skills/types.js'
import { ReplayCaseSchema, replayCaseHash } from '../skills/replay-runner.js'
import { rawFileHash } from './attestation.js'
import { PortableAssetSchema, type AssetKey, type PortableAsset, type WikiAsset, type SkillAsset } from './types.js'
import type { GitConnection } from './repository.js'

// pg returns NUMERIC/BIGINT as strings. Do not serialize rows through PostgreSQL
// JSON or convert revisions to Number: both lose integers above 2^53.
type Row = pg.QueryResultRow
function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('hex')
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalize(v)]))
  return value
}
const digest = (value: unknown) => canonicalPayloadHash(normalize(value)).toString('hex')
const date = (value: Date | null): string | null => value === null ? null : value.toISOString()
function stale(): never { throw new Error('git_source_stale') }
async function rows(client: pg.PoolClient, sql: string, args: unknown[]): Promise<Row[]> { return (await client.query(sql,args)).rows }
async function one(client: pg.PoolClient, sql: string, args: unknown[]): Promise<Row> { return (await rows(client,sql,args))[0] ?? stale() }

export interface GitReaderInput {
  connection: GitConnection; grant: V2GrantFacts; exportId: string
  purpose: 'local_preview' | 'external_export'; lifecycle: SkillPrelockedLifecycle
  skill: SkillPublicationValidationDeps
  temporal?: { versionIds:Set<string>; membershipIds:Set<string> }
}

/** Discovery is untrusted and bounded. Repeat after acquiring the entire sorted
 * lifecycle lock set; an expanded set must retry before acquiring source locks. */
export async function collectGitLifecycleSources(client: pg.PoolClient, installationId: string, repositoryId: string,
  keys: AssetKey[], savedAssets: readonly PortableAsset[] = []): Promise<SkillPrelockedLifecycle> {
  const claimIds=keys.filter(k=>k.kind==='claim'||k.kind==='rule').map(k=>k.id),skillIds=keys.filter(k=>k.kind==='skill').map(k=>k.id),wikiIds=keys.filter(k=>k.kind==='wiki').map(k=>k.id)
  const sourceRows=await rows(client,`WITH skill_versions AS (
    SELECT v.version_id,v.archive_id FROM memory_skill_versions v JOIN memory_skill_heads h USING(installation_id,skill_id)
    LEFT JOIN memory_skill_publication_heads p USING(installation_id,skill_id)
    WHERE v.installation_id=$1 AND v.skill_id=ANY($3::uuid[]) AND (v.version_id IN(h.current_version_id,p.current_version_id) OR v.version_id=ANY($5::uuid[]))
  ), wiki_sources AS (
    SELECT bs.* FROM memory_wiki_heads h JOIN memory_wiki_versions v ON v.installation_id=h.installation_id AND v.wiki_id=h.wiki_id
    JOIN memory_wiki_build_sources bs ON bs.installation_id=v.installation_id AND bs.run_id=v.build_run_id
    WHERE h.installation_id=$1 AND h.wiki_id=ANY($4::uuid[]) AND (v.wiki_version_id=h.active_version_id OR v.wiki_version_id=ANY($6::uuid[]))
  ), claim_versions AS (
    SELECT current_version_id AS version_id FROM knowledge_claims WHERE installation_id=$1 AND claim_id=ANY($2::uuid[])
    UNION SELECT unnest($7::uuid[])
    UNION SELECT a.claim_version_id FROM memory_skill_archives a JOIN skill_versions s USING(archive_id) WHERE a.installation_id=$1
    UNION SELECT source_ref_id FROM wiki_sources WHERE source_kind='claim_version'
    UNION SELECT k.version_id FROM knowledge_evidence k JOIN wiki_sources s ON s.source_ref_id=k.evidence_id AND s.source_kind='evidence' WHERE k.installation_id=$1
  ), evidence_rows AS (
    SELECT k.* FROM knowledge_evidence k WHERE k.installation_id=$1 AND (k.version_id IN(SELECT version_id FROM claim_versions) OR k.evidence_id=ANY($8::uuid[]))
  ) SELECT e.session_id,e.repository_id FROM evidence_rows k JOIN work_episodes e USING(installation_id,episode_id)
    UNION SELECT se.session_id,NULL::uuid FROM evidence_rows k JOIN source_events se ON se.installation_id=k.installation_id AND se.source_event_id=k.source_event_id WHERE se.session_id IS NOT NULL
    UNION SELECT a.session_id,NULL::uuid FROM evidence_rows k JOIN source_artifacts a ON a.installation_id=k.installation_id AND a.artifact_id=k.artifact_id
    UNION SELECT se.session_id,NULL::uuid FROM evidence_rows k JOIN source_artifacts a ON a.installation_id=k.installation_id AND a.artifact_id=k.artifact_id
      JOIN source_events se ON se.installation_id=a.installation_id AND se.source_event_id=a.source_event_id WHERE se.session_id IS NOT NULL
    UNION SELECT c.reference_id AS session_id,r.repository_id FROM memory_skill_replay_cases c
      JOIN memory_skill_replay_runs r USING(installation_id,run_id) JOIN skill_versions s ON s.version_id=r.version_id
      WHERE r.installation_id=$1 AND c.kind='historical_session'
    LIMIT 24577`,[installationId,claimIds,skillIds,wikiIds,
      savedAssets.filter(a=>a.key.kind==='skill').map(a=>a.baseVersionId),savedAssets.filter(a=>a.key.kind==='wiki').map(a=>a.baseVersionId),
      savedAssets.filter(a=>a.key.kind==='claim'||a.key.kind==='rule').map(a=>a.baseVersionId),savedAssets.flatMap(a=>a.immutable.evidence.map(e=>e.evidenceId))])
  if(sourceRows.length>24576)stale()
  return {sessionIds:[...new Set(sourceRows.map(r=>r.session_id as string))].sort(),
    repositoryIds:[...new Set([repositoryId,...sourceRows.map(r=>r.repository_id as string|null).filter((id):id is string=>id!==null)])].sort()}
}

async function readClaim(client: pg.PoolClient,input:GitReaderInput,key:AssetKey,versionId?:string) {
  const {connection:c}=input
  const claim=await one(client,`SELECT c.*,v.version_id AS selected_version_id FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=COALESCE($6::uuid,c.current_version_id) AND v.claim_id=c.claim_id
    JOIN repositories r ON r.installation_id=c.installation_id AND r.repository_id=$3
    WHERE c.installation_id=$1 AND c.claim_id=$2 AND c.state='active' AND c.owner_scope_kind=$4 AND c.owner_scope_id=$5 AND c.conflict_group_id IS NULL
      AND (v.repository_id=r.repository_id OR (v.repository_id IS NULL AND c.scope_kind='repository' AND c.scope_key IN(r.repository_id::text,r.repository_key)))
      AND v.authority IN('team_published','organization_published') AND v.source_promotion_candidate_id IS NOT NULL
      AND (v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND (v.valid_until IS NULL OR v.valid_until>clock_timestamp())
    FOR SHARE OF c,v,r`,[c.installationId,key.id,c.repositoryId,c.ownerScopeKind,c.ownerScopeId,versionId??null])
  if(key.kind==='rule'&&!['repository_convention','test_invariant'].includes(claim.claim_type))stale()
  const selectedVersionId=claim.selected_version_id
  delete claim.selected_version_id
  const version=await one(client,'SELECT * FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 FOR SHARE',[c.installationId,selectedVersionId])
  if(version.authority!==`${c.ownerScopeKind}_published`)stale()
  const authority=await one(client,'SELECT * FROM memory_authority_records WHERE installation_id=$1 AND version_id=$2 FOR SHARE',[c.installationId,version.version_id])
  const evidence=await readEvidence(client,input,version.version_id)
  input.temporal?.versionIds.add(version.version_id)
  return {claim,version,authority,evidence}
}

async function readEvidence(client:pg.PoolClient,input:GitReaderInput,versionId:string) {
  const installationId=input.connection.installationId
  const evidence=await rows(client,`SELECT k.*, e.session_id,e.repository_id AS episode_repository_id,e.state AS episode_state,
      e.source_digest AS episode_digest,e.updated_at AS episode_updated_at,
      EXISTS(SELECT 1 FROM source_sessions s WHERE s.installation_id=e.installation_id AND s.session_id=e.session_id AND s.deleted_at IS NOT NULL) AS session_deleted,
      EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id) AS tombstoned
    FROM knowledge_evidence k JOIN work_episodes e USING(installation_id,episode_id)
    WHERE k.installation_id=$1 AND k.version_id=$2 ORDER BY k.ordinal,k.evidence_id LIMIT 65 FOR SHARE OF k,e`,[installationId,versionId])
  if(!evidence.length||evidence.length>64)stale()
  for(const e of evidence) {
    if(e.visibility!=='shared'||e.session_deleted||e.tombstoned||e.episode_state!=='ready'
      ||!input.lifecycle.sessionIds.includes(e.session_id)||e.excerpt_hash?.toString('hex')!==rawFileHash(Buffer.from(e.excerpt)))stale()
    if(e.episode_repository_id&&!input.lifecycle.repositoryIds.includes(e.episode_repository_id))stale()
    const currentSession=async(sessionId:string|null)=>{
      if(!sessionId||!input.lifecycle.sessionIds.includes(sessionId))stale()
      await one(client,`SELECT 1 FROM source_sessions s WHERE installation_id=$1 AND session_id=$2 AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id) FOR SHARE`,[installationId,sessionId])
    }
    if(e.source_event_id) {
      const event=await one(client,'SELECT session_id FROM source_events WHERE installation_id=$1 AND source_event_id=$2 FOR SHARE',[installationId,e.source_event_id])
      await currentSession(event.session_id)
    }
    if(e.artifact_id) {
      const artifact=await one(client,'SELECT session_id,source_event_id FROM source_artifacts WHERE installation_id=$1 AND artifact_id=$2 FOR SHARE',[installationId,e.artifact_id])
      await currentSession(artifact.session_id)
      const event=await one(client,'SELECT session_id FROM source_events WHERE installation_id=$1 AND source_event_id=$2 FOR SHARE',[installationId,artifact.source_event_id])
      await currentSession(event.session_id)
    }
  }
  return evidence
}
function evidencePublic(e:Row) {return {evidenceId:e.evidence_id,versionId:e.version_id,hash:e.excerpt_hash.toString('hex'),kind:e.evidence_kind,ordinal:e.ordinal,visibility:e.visibility}}
function evidencePrivate(e:Row) {return {evidenceId:e.evidence_id,episodeId:e.episode_id,sourceEventId:e.source_event_id,artifactId:e.artifact_id,
  locator:e.locator,excerpt:e.excerpt,occurredAt:date(e.occurred_at),createdAt:date(e.created_at),sourceEvidenceHash:e.source_evidence_hash,contributorMembershipId:e.contributor_membership_id}}
function common(input:GitReaderInput,key:AssetKey,versionId:string,revision:string,sourceDigest:string) {
  return {schemaVersion:'memory-git.v1',key,path:`.pocketctl/knowledge/${key.kind==='wiki'?`wiki/${key.id}/metadata`:`${key.kind}s/${key.id}`}.yaml`,
    connectionId:input.connection.connectionId,exportId:input.exportId,baseVersionId:versionId,baseRevision:revision,sourceDigest}
}
function identity(input:GitReaderInput,evidence:Row[]) { const c=input.connection;return {installationId:c.installationId,ownerScopeKind:c.ownerScopeKind,ownerScopeId:c.ownerScopeId,evidence:evidence.map(evidencePublic)} }

/** Wiki knowledge-source producer contract. Identity is bound separately by the
 * tenant + exact source reference/version; the hash covers all Claim content. */
export function wikiClaimSourceHash(statement:string,structuredContent:unknown):string {
  return canonicalPayloadHash({statement,structuredContent}).toString('hex')
}
async function readWikiKnowledgeSource(client:pg.PoolClient,input:GitReaderInput,source:Row,historical=false) {
  const installationId=input.connection.installationId
  const claim=await one(client,source.source_kind==='claim_version'
    ? 'SELECT claim_id,version_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2'
    : 'SELECT v.claim_id,v.version_id FROM knowledge_evidence e JOIN knowledge_versions v USING(installation_id,version_id) WHERE e.installation_id=$1 AND e.evidence_id=$2',[installationId,source.source_ref_id])
  const facts=await readClaim(client,input,{kind:'claim',id:claim.claim_id},historical?claim.version_id:undefined)
  if(facts.version.version_id!==claim.version_id)stale()
  const referenced=source.source_kind==='evidence'?facts.evidence.find(e=>e.evidence_id===source.source_ref_id):undefined
  const expectedHash=source.source_kind==='claim_version'
    ? wikiClaimSourceHash(facts.version.statement,facts.version.structured_content)
    : referenced?.excerpt_hash.toString('hex')
  if(!expectedHash||source.content_hash!==expectedHash)stale()
  return facts
}
async function readWikiFileSource(client:pg.PoolClient,input:GitReaderInput,source:Row,snapshot:Row,graph:Row) {
  const installationId=input.connection.installationId
  if(source.source_snapshot_id!==snapshot.snapshot_id||source.commit_sha!==snapshot.commit_sha)stale()
  const node=await one(client,'SELECT * FROM memory_code_nodes WHERE installation_id=$1 AND graph_version_id=$2 AND node_id=$3 AND kind=$4 FOR SHARE',[installationId,graph.graph_version_id,source.source_ref_id,source.source_kind])
  if(node.stable_key!==source.stable_key||node.path!==source.path)stale()
  const entry=await one(client,`SELECT e.*,b.utf8_content FROM memory_source_snapshot_entries e JOIN memory_source_blobs b USING(installation_id,blob_hash)
    WHERE e.installation_id=$1 AND e.snapshot_id=$2 AND e.path=$3 FOR SHARE OF e,b`,[installationId,snapshot.snapshot_id,node.path])
  if(rawFileHash(Buffer.from(entry.utf8_content))!==entry.blob_hash)stale()
  const expectedHash=source.source_kind==='file'?entry.blob_hash:rawFileHash(Buffer.from([entry.blob_hash,node.stable_key,String(node.start_line??''),String(node.end_line??'')].join('\n')))
  if(source.content_hash!==expectedHash)stale()
  return {node,blobHash:entry.blob_hash,byteCount:entry.byte_count,mode:entry.mode}
}

async function claimAsset(client:pg.PoolClient,input:GitReaderInput,key:AssetKey):Promise<PortableAsset> {
  const facts=await readClaim(client,input,key),{claim:c,version:v,evidence}=facts
  return PortableAssetSchema.parse({...common(input,key,v.version_id,c.revision,digest(facts)),
    immutable:{...identity(input,evidence),claimType:c.claim_type,versionNumber:v.version_number,state:c.state,authority:v.authority,confidence:v.confidence,
      freshnessAt:date(v.freshness_at),validFrom:date(v.valid_from),validUntil:date(v.valid_until)},
    editable:{statement:v.statement,structuredContent:v.structured_content},serverOnly:{scopeKind:c.scope_kind,scopeKey:c.scope_key,normalizedKey:c.normalized_key,
      repositoryId:v.repository_id,repoSnapshotId:v.repo_snapshot_id,branch:v.branch,sourceCandidateId:v.source_candidate_id,supersededByClaimId:c.superseded_by_claim_id,
      createdAt:date(v.created_at),updatedAt:date(c.updated_at),sourcePromotionCandidateId:v.source_promotion_candidate_id,conflictGroupId:c.conflict_group_id,
      conflictVariant:c.conflict_variant,claimCreatedAt:date(c.created_at),evidence:evidence.map(evidencePrivate)}})
}

async function wikiAsset(client:pg.PoolClient,input:GitReaderInput,key:AssetKey):Promise<PortableAsset> {
  const {installationId,repositoryId}=input.connection
  const w=await one(client,"SELECT * FROM memory_wikis WHERE installation_id=$1 AND wiki_id=$2 AND repository_id=$3 AND state='active' FOR SHARE",[installationId,key.id,repositoryId])
  const h=await one(client,'SELECT * FROM memory_wiki_heads WHERE installation_id=$1 AND wiki_id=$2 AND repository_id=$3 FOR SHARE',[installationId,key.id,repositoryId])
  const v=await one(client,"SELECT * FROM memory_wiki_versions WHERE installation_id=$1 AND wiki_id=$2 AND wiki_version_id=$3 AND state='active' FOR SHARE",[installationId,key.id,h.active_version_id])
  const snapshot=await one(client,`SELECT * FROM memory_source_snapshots s WHERE installation_id=$1 AND snapshot_id=$2 AND repository_id=$3 AND state='active'
    AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND (t.snapshot_id=s.snapshot_id OR (t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha))) FOR SHARE`,[installationId,v.source_snapshot_id,repositoryId])
  const graph=await one(client,`SELECT g.* FROM memory_code_graph_versions g JOIN memory_code_graph_heads h ON h.installation_id=g.installation_id AND h.active_graph_version_id=g.graph_version_id AND h.repository_id=g.repository_id
    WHERE g.installation_id=$1 AND g.graph_version_id=$2 AND g.repository_id=$3 AND g.snapshot_id=$4 AND g.state='active' FOR SHARE OF g,h`,[installationId,v.graph_version_id,repositoryId,snapshot.snapshot_id])
  const build=await one(client,"SELECT * FROM memory_wiki_build_runs WHERE installation_id=$1 AND run_id=$2 AND wiki_id=$3 AND state='published' FOR SHARE",[installationId,v.build_run_id,key.id])
  if(build.source_snapshot_id!==snapshot.snapshot_id||build.graph_version_id!==graph.graph_version_id||build.generation!==w.generation)stale()
  if((await rows(client,'SELECT 1 FROM memory_wiki_stale_marks WHERE installation_id=$1 AND wiki_id=$2 AND cleared_at IS NULL',[installationId,key.id])).length)stale()
  const pages=await rows(client,'SELECT * FROM memory_wiki_pages WHERE installation_id=$1 AND wiki_version_id=$2 ORDER BY position,page_key LIMIT 33 FOR SHARE',[installationId,v.wiki_version_id])
  const sections=await rows(client,'SELECT * FROM memory_wiki_sections WHERE installation_id=$1 AND wiki_version_id=$2 ORDER BY position,section_key LIMIT 257 FOR SHARE',[installationId,v.wiki_version_id])
  const bindings=await rows(client,'SELECT * FROM memory_wiki_source_bindings WHERE installation_id=$1 AND wiki_version_id=$2 ORDER BY source_token,binding_id LIMIT 16385 FOR SHARE',[installationId,v.wiki_version_id])
  const heads=await rows(client,'SELECT * FROM memory_wiki_manual_section_heads WHERE installation_id=$1 AND wiki_id=$2 ORDER BY section_key LIMIT 257 FOR SHARE',[installationId,key.id])
  const versions=await rows(client,`SELECT v.* FROM memory_wiki_manual_section_versions v JOIN memory_wiki_manual_section_heads h ON h.installation_id=v.installation_id AND h.current_version_id=v.manual_version_id
    WHERE h.installation_id=$1 AND h.wiki_id=$2 ORDER BY h.section_key LIMIT 257 FOR SHARE OF v`,[installationId,key.id])
  const sources=await rows(client,'SELECT * FROM memory_wiki_build_sources WHERE installation_id=$1 AND run_id=$2 ORDER BY ordinal LIMIT 257 FOR SHARE',[installationId,build.run_id])
  if(!sources.length||sources.length>256||bindings.length>16384||heads.length!==versions.length||sections.length>256||pages.length>32)stale()
  const evidence=new Map<string,Row>(),sourceFacts:unknown[]=[]
  for(const source of sources) {
    if(source.source_kind==='file'||source.source_kind==='symbol') {
      // Hashes and metadata bind the source; full code bodies never enter the
      // portable projection or saved attestation.
      sourceFacts.push(await readWikiFileSource(client,input,source,snapshot,graph))
    } else {
      const facts=await readWikiKnowledgeSource(client,input,source)
      for(const e of facts.evidence)evidence.set(e.evidence_id,e)
      sourceFacts.push(facts)
    }
  }
  const immutablePages:WikiAsset['immutable']['pages']=[],editablePages:WikiAsset['editable']['pages']=[]
  for(const page of pages) {
    const current=sections.filter(s=>s.page_id===page.page_id),immutableSections:WikiAsset['immutable']['pages'][number]['sections']=[]
    for(const s of current) {
      const bound=bindings.filter(b=>b.section_id===s.section_id),manual=heads.find(head=>head.section_key===s.section_key),mv=manual?versions.find(version=>version.manual_version_id===manual.current_version_id):undefined
      if(s.authority==='generated') { if(!bound.length||manual)stale() }
      else if(!manual||!mv||mv.wiki_id!==key.id||mv.section_key!==s.section_key||mv.markdown!==s.markdown
        ||rawFileHash(Buffer.from(mv.markdown))!==mv.content_hash||manual.locked!==(s.authority==='locked'))stale()
      for(const b of bound) {
        const source=sources.find(source=>source.source_token===b.source_token)
        if(!source||source.source_kind!==b.source_kind||source.source_snapshot_id!==b.source_snapshot_id||source.commit_sha!==b.commit_sha)stale()
      }
      immutableSections.push({sectionId:s.section_id,authority:s.authority,generatedVersionId:v.wiki_version_id,manualVersionId:manual?.current_version_id??null,
        lockVersion:manual?.lock_version??'0',position:s.position,sourceBindings:bound.map(b=>({bindingId:b.binding_id,sourceKind:b.source_kind,sourceToken:b.source_token,
          sourceSnapshotId:b.source_snapshot_id,commitSha:b.commit_sha,createdAt:date(b.created_at)!}))})
    }
    immutablePages.push({pageId:page.page_id,pageKey:page.page_key,position:page.position,sections:immutableSections})
    editablePages.push({pageId:page.page_id,title:page.title,sections:current.map(s=>({sectionId:s.section_id,sectionKey:s.section_key,heading:s.heading,markdown:s.markdown,coverage:s.coverage}))})
  }
  if(heads.some(head=>!sections.some(s=>s.section_key===head.section_key&&s.authority!=='generated'))||bindings.some(b=>!sections.some(s=>s.section_id===b.section_id)))stale()
  return PortableAssetSchema.parse({...common(input,key,v.wiki_version_id,h.revision,digest({w,h,v,snapshot,graph,build,pages,sections,bindings,heads,versions,sources,sourceFacts})),
    immutable:{...identity(input,[...evidence.values()]),state:v.state,generatedVersionId:v.wiki_version_id,generatedRevision:v.revision,pages:immutablePages},editable:{pages:editablePages},
    serverOnly:{repositoryId,sourceSnapshotId:v.source_snapshot_id,graphVersionId:v.graph_version_id,buildRunId:v.build_run_id,contentHash:v.content_hash,createdAt:date(v.created_at),updatedAt:date(h.updated_at),
      generation:w.generation,wikiCreatedAt:date(w.created_at),wikiUpdatedAt:date(w.updated_at),
      manualHeads:heads.map(m=>({sectionKey:m.section_key,currentVersionId:m.current_version_id,locked:m.locked,lockVersion:m.lock_version,updatedAt:date(m.updated_at)})),
      manualVersions:versions.map(m=>({manualVersionId:m.manual_version_id,sectionKey:m.section_key,markdown:m.markdown,contentHash:m.content_hash,actorScopeKind:m.actor_scope_kind,
        actorScopeId:m.actor_scope_id,reasonCode:m.reason_code,previousVersionId:m.previous_version_id,createdAt:date(m.created_at)}))}})
}

async function skillAsset(client:pg.PoolClient,input:GitReaderInput,key:AssetKey):Promise<PortableAsset> {
  const {installationId,repositoryId}=input.connection
  const skill=await one(client,'SELECT * FROM memory_skills WHERE installation_id=$1 AND skill_id=$2',[installationId,key.id])
  const head=await one(client,'SELECT * FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2',[installationId,key.id])
  const publication=(await rows(client,'SELECT * FROM memory_skill_publication_heads WHERE installation_id=$1 AND skill_id=$2',[installationId,key.id]))[0]
  const external=input.purpose==='external_export'
  if(['rejected','revoked'].includes(head.state)||(external&&(!publication||publication.state!=='active')))stale()
  const version=await one(client,'SELECT * FROM memory_skill_versions WHERE installation_id=$1 AND skill_id=$2 AND version_id=$3 FOR SHARE',[installationId,key.id,external?publication!.current_version_id:head.current_version_id])
  const archive=await findSkillArchive(client,installationId,version.candidate_id)
  if(!archive||archive.source_kind!=='claim_version'||archive.repository_id!==repositoryId)stale()
  const claim=await one(client,'SELECT claim_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2',[installationId,archive.claim_version_id])
  const source=await readClaim(client,input,{kind:'claim',id:claim.claim_id})
  if(source.version.version_id!==archive.claim_version_id)stale()
  try {
    if(external) {
      const validated=await validateSkillPublicationTarget(client,{installationId,grant:input.grant},{skillId:key.id,versionId:version.version_id,expectedRevision:head.revision,
        mode:'execution',allowHistoricalVersion:true,prelockedLifecycle:input.lifecycle},input.skill)
      for(const id of validated.authorizationMembershipIds)input.temporal?.membershipIds.add(id)
    }
    else {
      const resolved=await resolveSkillSource(client,{installationId,grant:input.grant,source:archiveSourceRequest(archive),requiredPermission:'read',prelockedLifecycle:input.lifecycle},input.skill.context)
      if(resolved.sourceDigest!==archive.source_digest||resolved.inputDigest!==archive.input_digest||skillDocumentHash(version.document)!==version.document_hash)stale()
      const binding=input.grant.scopeBindings.find(b=>b.installation_id===installationId)!
      if((await loadSkillReviewPolicySnapshot(client,installationId,binding,{ensure:false})).hash!==version.policy_hash)stale()
    }
  } catch {stale()}
  await one(client,'SELECT 1 FROM memory_skills WHERE installation_id=$1 AND skill_id=$2 FOR SHARE',[installationId,key.id])
  await one(client,'SELECT 1 FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2 AND revision=$3 FOR SHARE',[installationId,key.id,head.revision])
  const task=await one(client,"SELECT * FROM memory_skill_tasks WHERE installation_id=$1 AND task_id=$2 AND repository_id=$3 AND state NOT IN('cancelled','dead') FOR SHARE",[installationId,skill.task_id,repositoryId])
  if((await rows(client,'SELECT 1 FROM memory_skill_version_revocations WHERE installation_id=$1 AND version_id=$2',[installationId,version.version_id])).length)stale()
  if(publication)await one(client,'SELECT 1 FROM memory_skill_publication_heads WHERE installation_id=$1 AND skill_id=$2 AND revision=$3 FOR SHARE',[installationId,key.id,publication.revision])
  const replay=(await rows(client,'SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND version_id=$2 ORDER BY sequence DESC LIMIT 1 FOR SHARE',[installationId,version.version_id]))[0]
  return PortableAssetSchema.parse({...common(input,key,version.version_id,head.revision,version.source_digest),
    immutable:{...identity(input,source.evidence),versionNumber:version.version_number,state:external?'reviewed':head.state,risk:version.risk,policyHash:version.policy_hash,
      documentHash:version.document_hash,archiveContentHash:version.archive_content_hash,replayRunId:replay?.run_id??null,replayState:replay?.state??'not_run',
      publicationState:publication?.state??'disabled',publicationRevision:publication?.revision??'0',publishedVersionId:publication?.current_version_id??null},
    editable:{document:version.document},serverOnly:{taskId:skill.task_id,candidateId:version.candidate_id,archiveId:version.archive_id,policySnapshot:version.policy_snapshot,
      authorKind:version.author_kind,authorId:version.author_id,authorizationEpoch:version.authorization_epoch,createdAt:date(version.created_at),updatedAt:date(head.updated_at),skillCreatedAt:date(skill.created_at),
      previousPublishedVersionId:publication?.previous_version_id??null,publicationEventId:publication?.publication_event_id??null,publicationUpdatedAt:publication?date(publication.updated_at):null,
      editableHeadVersionId:head.current_version_id,editableHeadRevision:head.revision,editableHeadState:head.state}})
}

/** Internal transaction-only, four-kind lossless projection. Caller owns current
 * authorization plus whole-set lifecycle locks; neither DB row existence nor a
 * portable schema is itself evidence of export authority. */
export async function readGitAssets(client:pg.PoolClient,input:GitReaderInput,keys:AssetKey[]):Promise<PortableAsset[]> {
  const result:PortableAsset[]=[]
  for(const key of [...keys].sort((a,b)=>a.id.localeCompare(b.id))) {
    result.push(await (key.kind==='wiki'?wikiAsset(client,input,key):key.kind==='skill'?skillAsset(client,input,key):claimAsset(client,input,key)))
  }
  return result
}
export const sameGitLifecycleSources=(a:SkillPrelockedLifecycle,b:SkillPrelockedLifecycle)=>canonicalJsonString(a)===canonicalJsonString(b)

function requireSavedEvidence(asset:PortableAsset,evidence:Row[]) {
  const order=(a:{evidenceId:string},b:{evidenceId:string})=>a.evidenceId.localeCompare(b.evidenceId)
  if(canonicalJsonString([...asset.immutable.evidence].sort(order))!==canonicalJsonString(evidence.map(evidencePublic).sort(order)))stale()
}
async function validateSavedWiki(client:pg.PoolClient,input:GitReaderInput,asset:WikiAsset) {
  const {installationId,repositoryId}=input.connection,base=asset.serverOnly
  const version=await one(client,`SELECT v.* FROM memory_wiki_versions v JOIN memory_wikis w USING(installation_id,wiki_id)
    WHERE v.installation_id=$1 AND v.wiki_id=$2 AND v.wiki_version_id=$3 AND w.repository_id=$4 AND v.state IN('active','superseded') FOR SHARE OF v,w`,[installationId,asset.key.id,asset.baseVersionId,repositoryId])
  if(version.source_snapshot_id!==base.sourceSnapshotId||version.graph_version_id!==base.graphVersionId||version.build_run_id!==base.buildRunId||version.content_hash!==base.contentHash)stale()
  const snapshot=await one(client,`SELECT * FROM memory_source_snapshots s WHERE installation_id=$1 AND snapshot_id=$2 AND repository_id=$3 AND state='active'
    AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND (t.snapshot_id=s.snapshot_id OR (t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha))) FOR SHARE`,[installationId,base.sourceSnapshotId,repositoryId])
  const graph=await one(client,"SELECT * FROM memory_code_graph_versions WHERE installation_id=$1 AND graph_version_id=$2 AND repository_id=$3 AND snapshot_id=$4 AND state IN('active','superseded') FOR SHARE",[installationId,base.graphVersionId,repositoryId,base.sourceSnapshotId])
  await one(client,"SELECT 1 FROM memory_wiki_build_runs WHERE installation_id=$1 AND run_id=$2 AND wiki_id=$3 AND source_snapshot_id=$4 AND graph_version_id=$5 AND generation=$6 AND state='published' FOR SHARE",[installationId,base.buildRunId,asset.key.id,base.sourceSnapshotId,base.graphVersionId,base.generation])
  const sources=await rows(client,'SELECT * FROM memory_wiki_build_sources WHERE installation_id=$1 AND run_id=$2 ORDER BY ordinal LIMIT 257 FOR SHARE',[installationId,base.buildRunId])
  if(!sources.length||sources.length>256)stale()
  const evidence=new Map<string,Row>()
  for(const source of sources) {
    if(source.source_kind==='file'||source.source_kind==='symbol')await readWikiFileSource(client,input,source,snapshot,graph)
    else for(const e of (await readWikiKnowledgeSource(client,input,source,true)).evidence)evidence.set(e.evidence_id,e)
  }
  requireSavedEvidence(asset,[...evidence.values()])
  for(const section of asset.immutable.pages.flatMap(page=>page.sections)) {
    for(const b of section.sourceBindings) {
      const actual=await one(client,'SELECT * FROM memory_wiki_source_bindings WHERE installation_id=$1 AND wiki_version_id=$2 AND section_id=$3 AND binding_id=$4 FOR SHARE',[installationId,asset.baseVersionId,section.sectionId,b.bindingId])
      if(actual.source_kind!==b.sourceKind||actual.source_token!==b.sourceToken||actual.source_snapshot_id!==b.sourceSnapshotId||actual.commit_sha!==b.commitSha)stale()
      if(!sources.some(s=>s.source_token===b.sourceToken&&s.source_kind===b.sourceKind&&s.source_snapshot_id===b.sourceSnapshotId&&s.commit_sha===b.commitSha))stale()
    }
    if(section.manualVersionId) {
      const saved=base.manualVersions.find(m=>m.manualVersionId===section.manualVersionId)
      if(!saved)stale()
      const manual=await one(client,'SELECT * FROM memory_wiki_manual_section_versions WHERE installation_id=$1 AND wiki_id=$2 AND manual_version_id=$3 FOR SHARE',[installationId,asset.key.id,section.manualVersionId])
      if(manual.section_key!==saved.sectionKey||manual.markdown!==saved.markdown||manual.content_hash!==saved.contentHash
        ||rawFileHash(Buffer.from(manual.markdown))!==manual.content_hash)stale()
    }
  }
}
async function validateSavedSkill(client:pg.PoolClient,input:GitReaderInput,asset:SkillAsset) {
  const {installationId,repositoryId}=input.connection
  const version=await one(client,'SELECT * FROM memory_skill_versions WHERE installation_id=$1 AND skill_id=$2 AND version_id=$3 FOR SHARE',[installationId,asset.key.id,asset.baseVersionId])
  if(version.candidate_id!==asset.serverOnly.candidateId||version.archive_id!==asset.serverOnly.archiveId||version.source_digest!==asset.sourceDigest
    ||version.document_hash!==asset.immutable.documentHash||version.policy_hash!==asset.immutable.policyHash||version.archive_content_hash!==asset.immutable.archiveContentHash
    ||skillDocumentHash(version.document)!==asset.immutable.documentHash)stale()
  if((await rows(client,'SELECT 1 FROM memory_skill_version_revocations WHERE installation_id=$1 AND version_id=$2',[installationId,asset.baseVersionId])).length)stale()
  const archive=await findSkillArchive(client,installationId,version.candidate_id)
  if(!archive||archive.source_kind!=='claim_version'||archive.candidate_state==='revoked'||archive.repository_id!==repositoryId||archive.archive_id!==version.archive_id)stale()
  const claim=await one(client,'SELECT claim_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2',[installationId,archive.claim_version_id])
  const facts=await readClaim(client,input,{kind:'claim',id:claim.claim_id},archive.claim_version_id!)
  requireSavedEvidence(asset,facts.evidence)
  // Match the persisted shared Skill source packet contract without requiring its
  // historical Claim version to still be the editable current head.
  const packets=facts.evidence.map((e,i)=>({token:`source-${i+1}`,handle:`claim:${e.evidence_id}`,excerpt:e.excerpt,excerptHash:e.excerpt_hash.toString('hex'),kind:e.evidence_kind,
    eventId:e.source_event_id,artifactId:e.artifact_id,evidenceId:e.evidence_id}))
  if(canonicalPayloadHash({versionId:archive.claim_version_id,statement:facts.version.statement,content:facts.version.structured_content,packets}).toString('hex')!==asset.sourceDigest)stale()
  await one(client,`SELECT 1 FROM repo_snapshots s WHERE installation_id=$1 AND repository_id=$2 AND repo_snapshot_id=$3
    AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha) FOR SHARE`,[installationId,repositoryId,archive.repo_snapshot_id])
  if(asset.immutable.replayRunId) {
    const run=await one(client,'SELECT * FROM memory_skill_replay_runs WHERE installation_id=$1 AND skill_id=$2 AND version_id=$3 AND run_id=$4 FOR SHARE',[installationId,asset.key.id,asset.baseVersionId,asset.immutable.replayRunId])
    if(run.state!==asset.immutable.replayState||run.source_digest!==asset.sourceDigest||run.document_hash!==asset.immutable.documentHash||run.policy_hash!==asset.immutable.policyHash)stale()
    const cases=await rows(client,'SELECT * FROM memory_skill_replay_cases WHERE installation_id=$1 AND run_id=$2 ORDER BY case_id LIMIT 33 FOR SHARE',[installationId,run.run_id])
    if(cases.length>32)stale()
    const recorded=ReplayCaseSchema.array().max(32).safeParse(await input.skill.cases.loadCases({installationId,repositoryId,repoSnapshotId:archive.repo_snapshot_id,
      versionId:asset.baseVersionId,documentHash:asset.immutable.documentHash,policyHash:asset.immutable.policyHash,caseIds:cases.map(c=>c.case_id)}))
    if(!recorded.success||recorded.data.length!==cases.length||new Set(recorded.data.map(c=>c.case_id)).size!==cases.length)stale()
    for(const c of cases) {
      const actual=recorded.data.find(r=>r.case_id===c.case_id)
      if(!actual||replayCaseHash(actual)!==c.input_hash||actual.installation_id!==installationId||actual.version_id!==asset.baseVersionId)stale()
      if(c.kind==='historical_session') {
        if(!input.lifecycle.sessionIds.includes(c.reference_id))stale()
        await one(client,`SELECT 1 FROM source_sessions s JOIN work_episodes e USING(installation_id,session_id)
          WHERE s.installation_id=$1 AND s.session_id=$2 AND s.deleted_at IS NULL AND e.repository_id=$3 AND e.repo_snapshot_id=$4 AND e.state='ready' AND e.outcome='completed'
          AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id) FOR SHARE OF s,e`,[installationId,c.reference_id,repositoryId,archive.repo_snapshot_id])
      }
    }
  }
}
/** Original B is historical, not necessarily current M. Validate exact saved
 * versions/references and their live eligibility under the union lifecycle locks;
 * a valid signature must never substitute for original-source authorization. */
export async function validateSavedGitAssets(client:pg.PoolClient,input:GitReaderInput,savedAssets:readonly PortableAsset[]):Promise<void> {
  for(const unparsed of [...savedAssets].sort((a,b)=>a.key.id.localeCompare(b.key.id))) {
    const asset=PortableAssetSchema.parse(unparsed)
    if(asset.immutable.installationId!==input.connection.installationId||asset.connectionId!==input.connection.connectionId
      ||asset.immutable.ownerScopeKind!==input.connection.ownerScopeKind||asset.immutable.ownerScopeId!==input.connection.ownerScopeId)stale()
    if(asset.key.kind==='wiki')await validateSavedWiki(client,input,asset as WikiAsset)
    else if(asset.key.kind==='skill')await validateSavedSkill(client,input,asset as SkillAsset)
    else {
      const facts=await readClaim(client,input,asset.key,asset.baseVersionId)
      if(canonicalJsonString({statement:facts.version.statement,structuredContent:facts.version.structured_content})!==canonicalJsonString(asset.editable))stale()
      requireSavedEvidence(asset,facts.evidence)
    }
  }
}
