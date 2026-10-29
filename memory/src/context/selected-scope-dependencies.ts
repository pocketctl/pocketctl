import {revisionTimeSql} from '../claims/version-selection.js'
import { deliveryVersionAvailableSql } from '../episodes/delivery-withdrawal.js'
import type pg from 'pg'
import {createScopeAuthorization,type V2GrantFacts,type GrantScopeBinding} from '../governance/authorization.js'
import {canonicalRepositoryRemotes} from '../governance/publication-applicability.js'
import {originPolicyCorpusSnapshot,type OriginPolicyFence} from '../governance/origin-policy.js'
import {resolveFederatedScopeContexts} from '../retrieval/federated-context.js'
import {resolveSelectedContextReferences,type SelectedContextReference,type ResolvedSelectedReference} from './compiler.js'
import type {ContextQueryFrame} from './consumption.js'

type QueryPool=Pick<pg.Pool,'query'>
export interface SelectedScopeDependency {
 installationId:string
 binding:GrantScopeBinding
 frame:ContextQueryFrame
 remotes:string[]
 references:SelectedContextReference[]
 versionIds:string[]
 metadataStamp:string
 originPolicyStamp:string|null
}
/** Server-produced proof, never accepted from request JSON. No token or source body is persisted here. */
export interface SelectedScopeProof {
 grant:V2GrantFacts
 primaryFrame:ContextQueryFrame
 mappingFingerprint:string
 scopes:SelectedScopeDependency[]
}

/** Exact referenced resources plus canonical aliases participate in the CAS.
 * Alias rows are needed to detect an otherwise invisible ambiguous mapping.
 * The primary registry is included only for the confirmed source repository.
 * No foreign row locks or foreign consumption-generation writes are taken. */
function metadataStampSql(d:string):string {
 const id=`(${d}->>'installationId')::uuid`
 const versions=`ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${d}->'versionIds'))`
 const repository=`(${d}->'frame'->>'repositoryId')::uuid`
 const snapshot=`(${d}->'frame'->>'repoSnapshotId')::uuid`
 const wikiVersions=`ARRAY(SELECT (r->>'source_version')::uuid FROM jsonb_array_elements(${d}->'references') r WHERE r->>'source_kind'='wiki_section')`
 return `(SELECT md5(jsonb_build_object(
  'installation',(SELECT jsonb_build_object('local',i.local_status,'relay',i.relay_status,'config',i.config_version) FROM memory_installations i WHERE i.installation_id=${id}),
  'scope',(SELECT to_jsonb(s) FROM memory_owner_scopes s WHERE s.installation_id=${id}),
  'member',(SELECT to_jsonb(m)||jsonb_build_object('time_valid',(m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())) FROM memory_scope_memberships m WHERE m.installation_id=${id} AND m.membership_id=(${d}->'binding'->>'membership_id')::uuid),
  'generation',COALESCE((SELECT generation FROM memory_scope_consumption_generations WHERE installation_id=${id}),1),
  'repositories',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.repository_id) FROM repositories r WHERE r.installation_id=${id} AND (r.repository_id=${repository} OR r.canonical_remote=ANY(ARRAY(SELECT value FROM jsonb_array_elements_text(${d}->'remotes'))))),
  'snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.repo_snapshot_id) FROM repo_snapshots s WHERE s.installation_id=${id} AND s.repository_id=${repository} AND (s.repo_snapshot_id=${snapshot} OR s.commit_sha=${d}->'frame'->>'commitSha')),
  'claims',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.claim_id) FROM knowledge_claims c WHERE c.installation_id=${id} AND EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=ANY(${versions}))),
  'versions',(SELECT jsonb_agg(to_jsonb(v)||jsonb_build_object('delivery_source_valid',${deliveryVersionAvailableSql()},'time_valid',(v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND (v.valid_until IS NULL OR v.valid_until>clock_timestamp()),'revision_time_valid',${revisionTimeSql()}) ORDER BY v.version_id) FROM knowledge_versions v WHERE v.installation_id=${id} AND v.version_id=ANY(${versions})),
  'evidence',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.evidence_id) FROM knowledge_evidence e WHERE e.installation_id=${id} AND e.version_id=ANY(${versions})),
  'episodes',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.episode_id) FROM work_episodes w WHERE w.installation_id=${id} AND EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.installation_id=w.installation_id AND e.episode_id=w.episode_id AND e.version_id=ANY(${versions}))),
  'wiki_versions',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.wiki_version_id) FROM memory_wiki_versions w WHERE w.installation_id=${id} AND w.wiki_version_id=ANY(${wikiVersions})),
  'wiki_sections',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.section_id) FROM memory_wiki_sections s WHERE s.installation_id=${id} AND s.section_id=ANY(ARRAY(SELECT (r->>'source_id')::uuid FROM jsonb_array_elements(${d}->'references') r WHERE r->>'source_kind'='wiki_section'))),
  'wiki_heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY h.repository_id) FROM memory_wiki_heads h WHERE h.installation_id=${id} AND h.repository_id=${repository}),
  'wiki_snapshots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.snapshot_id) FROM memory_source_snapshots s WHERE s.installation_id=${id} AND EXISTS(SELECT 1 FROM memory_wiki_versions w WHERE w.installation_id=s.installation_id AND w.source_snapshot_id=s.snapshot_id AND w.wiki_version_id=ANY(${wikiVersions}))),
  'wiki_sources',(SELECT jsonb_agg(to_jsonb(bs) ORDER BY bs.run_id,bs.source_kind,bs.source_ref_id) FROM memory_wiki_build_sources bs WHERE bs.installation_id=${id} AND EXISTS(SELECT 1 FROM memory_wiki_versions w WHERE w.installation_id=bs.installation_id AND w.build_run_id=bs.run_id AND w.wiki_version_id=ANY(${wikiVersions}))),
  'scope_tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.owner_scope_kind,t.owner_scope_id) FROM memory_scope_tombstones t WHERE t.owner_scope_kind=${d}->'binding'->>'owner_scope_kind' AND t.owner_scope_id=(${d}->'binding'->>'owner_scope_id')::uuid),
  'repository_tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.repository_id) FROM memory_repository_tombstones t WHERE t.installation_id=${id} AND t.repository_id=${repository}),
  'snapshot_tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.repository_id,t.commit_sha) FROM memory_source_snapshot_tombstones t WHERE t.installation_id=${id} AND t.repository_id=${repository}),
  'session_tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.session_id) FROM memory_session_tombstones t WHERE t.installation_id=${id} AND EXISTS(SELECT 1 FROM work_episodes w JOIN knowledge_evidence e USING(installation_id,episode_id) WHERE w.installation_id=t.installation_id AND w.session_id=t.session_id AND e.version_id=ANY(${versions})))
 )::text))`
}

export function selectedScopeFenceSql(parameter:string):string {
 return `(${parameter}::jsonb IS NULL OR (
  ((${parameter}::jsonb->'grant'->>'expiresAt') IS NULL OR clock_timestamp()<to_timestamp((${parameter}::jsonb->'grant'->>'expiresAt')::double precision))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${parameter}::jsonb->'scopes') d WHERE ${metadataStampSql('d')} IS DISTINCT FROM d->>'metadataStamp')
 ))`
}

async function stamp(pool:QueryPool,scope:SelectedScopeDependency):Promise<string>{
 return(await pool.query<{stamp:string}>(`SELECT ${metadataStampSql('$1::jsonb')} AS stamp`,[JSON.stringify(scope)])).rows[0].stamp
}

async function contexts(pool:QueryPool,grant:V2GrantFacts,ids:readonly string[],frame:ContextQueryFrame){
 const scopes=ids.map(id=>grant.scopeBindings.find(b=>b.installation_id===id)!).map(b=>({installationId:b.installation_id,ownerScopeKind:b.owner_scope_kind,ownerScopeId:b.owner_scope_id,authorizationEpoch:b.authorization_epoch}))
 return resolveFederatedScopeContexts(pool as pg.Pool,{grant,scopes,repositoryId:frame.repositoryId,repoSnapshotId:frame.repoSnapshotId,branch:frame.branch,taskScopeKey:frame.taskScopeKey})
}

async function exactVersionIds(pool:QueryPool,id:string,references:readonly SelectedContextReference[]):Promise<string[]>{
 const ids=references.filter(r=>r.source_kind!=='wiki_section').map(r=>r.source_version)
 const wiki=references.filter(r=>r.source_kind==='wiki_section').map(r=>r.source_version)
 if(wiki.length){
  const rows=(await pool.query<{version_id:string|null}>(`SELECT CASE WHEN bs.source_kind='claim_version' THEN bs.source_ref_id ELSE e.version_id END::text AS version_id
   FROM memory_wiki_versions w JOIN memory_wiki_build_sources bs ON bs.installation_id=w.installation_id AND bs.run_id=w.build_run_id
   LEFT JOIN knowledge_evidence e ON e.installation_id=bs.installation_id AND e.evidence_id=bs.source_ref_id AND bs.source_kind='evidence'
   WHERE w.installation_id=$1 AND w.wiki_version_id=ANY($2::uuid[]) AND bs.source_kind IN('claim_version','evidence')`,[id,wiki])).rows
  ids.push(...rows.flatMap(r=>r.version_id?[r.version_id]:[]))
 }
 return [...new Set(ids)].sort()
}

export async function prepareSelectedScopeContext(pool:QueryPool,input:{installationId:string;references:readonly SelectedContextReference[];frame:ContextQueryFrame;grant:V2GrantFacts}):Promise<{proof:SelectedScopeProof;resolved:ResolvedSelectedReference[]}|null>{
 if(input.grant.primaryInstallationId!==input.installationId)return null
 // Foreign snapshot content needs a recorded primary frame; a caller hint
 // cannot supply proof when the exact primary snapshot is missing/ambiguous.
 if((input.frame.commitSha&&!input.frame.repoSnapshotId)||input.references.some(r=>r.installation_id!==input.installationId&&r.source_kind==='wiki_section'&&!input.frame.repoSnapshotId))return null
 const ids=[...new Set([input.installationId,...input.references.map(r=>r.installation_id)])].sort()
 const grant=await createScopeAuthorization(pool as pg.Pool).validateV2Grant({...input.grant,scopeBindings:input.grant.scopeBindings.filter(b=>ids.includes(b.installation_id))})
 if(!grant||ids.some(id=>!grant.scopeBindings.some(b=>b.installation_id===id&&b.permissions.includes('read'))))return null
 if(input.references.some(r=>grant.scopeBindings.find(b=>b.installation_id===r.installation_id)?.owner_scope_id!==r.owner_scope_id))return null
 const mapping=await contexts(pool,grant,ids,input.frame)
 const proof:SelectedScopeProof={grant,primaryFrame:{repositoryId:input.frame.repositoryId,repoSnapshotId:input.frame.repoSnapshotId,branch:input.frame.branch,taskScopeKey:input.frame.taskScopeKey,commitSha:input.frame.commitSha},mappingFingerprint:mapping.fingerprint??'',scopes:[]}
 const resolved:ResolvedSelectedReference[]=[]
 for(const id of ids){
  const mapped=mapping.contexts.get(id)?.context
  if(!mapped)return null
  const frame:ContextQueryFrame={repositoryId:mapped.repositoryId,repoSnapshotId:mapped.repoSnapshotId,branch:mapped.branch,taskScopeKey:mapped.taskScopeKey,commitSha:mapped.snapshotCommitSha??null}
  const references=input.references.filter(r=>r.installation_id===id)
  const scope:SelectedScopeDependency={installationId:id,binding:grant.scopeBindings.find(b=>b.installation_id===id)!,frame,remotes:canonicalRepositoryRemotes(mapped.canonicalRepositoryKey??''),references,versionIds:await exactVersionIds(pool,id,references),metadataStamp:'',originPolicyStamp:(await originPolicyCorpusSnapshot(pool,id)).stamp}
  // Capture before reading rendered content, so a concurrent edit cannot bless old bytes with a new stamp.
  scope.metadataStamp=await stamp(pool,scope)
  const entries=await resolveSelectedContextReferences(pool as pg.Pool,id,references,frame)
  if(!entries)return null
  resolved.push(...entries);proof.scopes.push(scope)
 }
 if(!await selectedScopeContextCurrent(pool,proof))return null
 // Preserve caller order for deterministic rendering, independent of scope order.
 resolved.sort((a,b)=>input.references.indexOf(a.reference)-input.references.indexOf(b.reference))
 return{proof,resolved}
}

function bindingKey(b:GrantScopeBinding):string {
 return JSON.stringify([b.installation_id,b.owner_scope_kind,b.owner_scope_id,b.membership_id,b.membership_revision,b.authorization_epoch,[...b.permissions].sort()])
}

export async function selectedScopeContextCurrent(pool:QueryPool,proof:SelectedScopeProof,currentGrant?:V2GrantFacts):Promise<boolean>{
 const validate=async(facts:V2GrantFacts)=>createScopeAuthorization(pool as pg.Pool).validateV2Grant({...facts,scopeBindings:facts.scopeBindings.filter(b=>proof.scopes.some(s=>s.installationId===b.installation_id))})
 const grant=await validate(proof.grant)
 if(!grant||proof.scopes.some(s=>!grant.scopeBindings.some(b=>b.installation_id===s.installationId&&b.permissions.includes('read'))))return false
 if(currentGrant){
  if(currentGrant.primaryInstallationId!==proof.grant.primaryInstallationId)return false
  const now=await validate(currentGrant)
  if(!now||proof.scopes.some(s=>!now.scopeBindings.some(b=>b.installation_id===s.installationId&&bindingKey(b)===bindingKey(s.binding))))return false
 }
 const mapped=await contexts(pool,grant,proof.scopes.map(s=>s.installationId),proof.primaryFrame)
 if((mapped.fingerprint??'')!==proof.mappingFingerprint)return false
 for(const scope of proof.scopes){
  if(await stamp(pool,scope)!==scope.metadataStamp)return false
  if((await originPolicyCorpusSnapshot(pool,scope.installationId)).stamp!==scope.originPolicyStamp)return false
  if(!await resolveSelectedContextReferences(pool as pg.Pool,scope.installationId,scope.references,scope.frame))return false
 }
 return true
}

/** Bind current upstream policies to the same atomic nonce statement as the source metadata CAS. */
export async function selectedScopeOriginFences(pool:QueryPool,proof:SelectedScopeProof):Promise<{matches:boolean;fences:OriginPolicyFence[]}>{
 const fences:OriginPolicyFence[]=[]
 let matches=true
 for(const scope of proof.scopes){const origin=await originPolicyCorpusSnapshot(pool,scope.installationId);matches&&=origin.stamp===scope.originPolicyStamp;fences.push(...origin.fences)}
 return{matches,fences}
}
