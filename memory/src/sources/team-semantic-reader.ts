import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceRoot} from '@pocketctl/session-source'
import {createObservedSourceReader} from './observed-reader.js'
import {sourcePoolContext} from './pool-context.js'
import {discoverTeamSemanticGroup,type TeamSemanticRoster} from './team-semantic-discovery.js'
import {normalizeTeamSemanticBody,groupTeamSemanticFacts,teamSemanticPreparedRole,parseTeamSemanticSourceVersion} from './team-semantic.js'
import {lockTeamSemanticExecutionGroup,observeTeamSemanticExecution} from './source-execution.js'
export type SemanticRole=ReturnType<typeof teamSemanticPreparedRole>
export interface PreparedTeamSemanticBody {roster:TeamSemanticRoster;roles:SemanticRole[];assertCurrent(client:Pick<pg.PoolClient,'query'>,commit:boolean,retained?:boolean):Promise<void>}
/** Internal SUPPORT IO uses native adapters directly. It never reauthorizes a
 * requested raw reference through a different principal or semantic UUID. */
export async function prepareTeamSemanticBody(pool:pg.Pool,installation:string,root:SourceRoot):Promise<PreparedTeamSemanticBody>{
 const roster=await discoverTeamSemanticGroup(pool,installation,root)
 if(roster.supportCount<1||roster.withdrawn)throw Error('team_semantic_source_unavailable')
 if(roster.admission!=='eligible')throw Error('team_semantic_input_'+roster.admission)
 const reader=createObservedSourceReader(pool,sourcePoolContext(pool).archive),facts:object[]=[]
 let count=0,bytes=0
 for(const r of roster.roots)for(const c of r.contexts){
  if(['revoked','deleted'].includes(c.state))continue
  if(c.state!=='current'||c.mode!=='shared-active')throw Error('team_semantic_group_not_ready')
  const page=await reader.listHeads(c.scope,r.root,{limit:64})
  if(page.nextCursor||canonicalJsonString(page.version)!==canonicalJsonString(c.version))throw Error('team_semantic_group_changed')
  const bodies=await reader.resolveBodies(c.scope,r.root,page.heads,page.version)
  for(const body of bodies){
   if(++count>1536)throw Error('team_semantic_group_limit')
   bytes+=Buffer.byteLength(canonicalJsonString(body.payload));if(bytes>32*1024*1024)throw Error('team_semantic_group_limit')
   facts.push(normalizeTeamSemanticBody(c.scope,r.root,body))
  }
 }
 const roles=groupTeamSemanticFacts(facts).map(g=>teamSemanticPreparedRole(g.token))
 if(roles.length!==3||new Set(roles.map(r=>r.identity.at(-1))).size!==3||new Set(roles.map(r=>r.semanticTurnId)).size!==1)throw Error('team_semantic_group_incomplete')
 if(canonicalJsonString(await discoverTeamSemanticGroup(pool,installation,root))!==canonicalJsonString(roster))throw Error('team_semantic_group_changed')
 observeTeamSemanticExecution(pool,installation,roles[0].semanticSessionId,roster,canonicalPayloadHash(roles.map(r=>[r.semanticKey,r.businessDigest]).sort((a,b)=>a[0].localeCompare(b[0]))).toString('hex'))
 return {roster,roles,async assertCurrent(client,commit,retained=false){
  if(commit)await lockTeamSemanticExecutionGroup(client,installation,roster,retained)
  else if(canonicalJsonString(await discoverTeamSemanticGroup(client,installation,root))!==canonicalJsonString(roster))throw Error('team_semantic_group_changed')
 }}
}

interface SemanticReferenceRow {source_version?:unknown;source_event_id:string;source_kind?:string;canonical_key?:string;event_type:string;payload_hash:Buffer;content_hash?:Buffer;source_provenance:Record<string,unknown>;session_id:string|null;turn_id:string|null}
/** Split semantic UUIDs before the raw ref-context lookup. The caller keeps
 * all explicit raw UUIDs in its original AND-authorized route. */
export async function prepareTeamSemanticReferences(pool:pg.Pool,installation:string,rows:readonly SemanticReferenceRow[],retained=false){
 const bodies=new Map<string,Record<string,unknown>>(),checks:((client:Pick<pg.PoolClient,'query'>,commit:boolean)=>Promise<void>)[]=[]
 const registrations=(await pool.query('SELECT semantic_ref_id::text,semantic_key,business_digest,semantic_payload_hash,semantic_provenance,registration_state,structured_identity FROM memory_team_semantic_groups WHERE installation_id=$1 AND semantic_ref_id=ANY($2::uuid[]) ORDER BY semantic_ref_id',[installation,rows.map(r=>r.source_event_id)])).rows
 const publications=(await pool.query(`SELECT p.*,encode(p.business_digest,'hex') AS digest FROM memory_team_semantic_publications p
  WHERE p.installation_id=$1 AND p.disposition IN('published','legacy_related') AND(p.goal_ref_id=ANY($2::uuid[]) OR p.reply_ref_id=ANY($2::uuid[]) OR p.outcome_ref_id=ANY($2::uuid[])) ORDER BY p.group_key`,[installation,rows.map(r=>r.source_event_id)])).rows
 if(publications.length>rows.length)throw Error('team_semantic_publication_conflict')
 for(const publication of publications){
  const selected=rows.filter(r=>[publication.goal_ref_id,publication.reply_ref_id,publication.outcome_ref_id].includes(r.source_event_id))
  const root={kind:publication.source_kind,key:publication.source_roster.seed} as SourceRoot
  if(selected.some(row=>{
   const v=parseTeamSemanticSourceVersion(row.source_version),g=registrations.find(g=>g.semantic_ref_id===row.source_event_id)
   return !v||!g||g.registration_state!=='published'||v.originalSupportDigest!==publication.support_digest.toString('hex')
    ||v.businessDigest!==g.business_digest?.toString('hex')||!row.payload_hash.equals(g.semantic_payload_hash)||!row.content_hash?.equals(g.semantic_payload_hash)
    ||row.canonical_key!==g.semantic_key||row.source_provenance.source_kind!=='team_semantic'||row.source_provenance.business_digest!==v.businessDigest
    ||canonicalJsonString(row.source_provenance.structured_identity)!==canonicalJsonString(g.structured_identity)
    ||canonicalJsonString(row.source_provenance.native)!==canonicalJsonString(g.semantic_provenance.team)
  }))throw Error('source_reference_unproven')
  if(retained){
   const roster=await discoverTeamSemanticGroup(pool,installation,root)
   if(roster.supportCount<1||roster.withdrawn)throw Error('team_semantic_source_unavailable')
   if(canonicalJsonString(roster.publication)!==canonicalJsonString(publication.native_publication_proof)||roster.admission!=='eligible')throw Error('team_semantic_group_changed')
   checks.push(async(client,commit)=>{
    if(commit)await lockTeamSemanticExecutionGroup(client,installation,roster,true)
    else if(canonicalJsonString(await discoverTeamSemanticGroup(client,installation,root))!==canonicalJsonString(roster))throw Error('team_semantic_group_changed')
   })
   continue
  }
  const prepared=await prepareTeamSemanticBody(pool,installation,root)
  if(canonicalJsonString(prepared.roster.publication)!==canonicalJsonString(publication.native_publication_proof))throw Error('team_semantic_group_changed')
  for(const row of selected){
   const descriptor=parseTeamSemanticSourceVersion(row.source_version)
   const role=prepared.roles.find(r=>r.semanticKey===row.canonical_key)
   if(!descriptor||descriptor.businessDigest!==role?.businessDigest||descriptor.originalSupportDigest!==publication.support_digest.toString('hex')||!role||role.semanticSessionId!==row.session_id||role.semanticTurnId!==row.turn_id||role.eventType!==row.event_type
    ||role.payloadHash!==row.payload_hash.toString('hex')||role.payloadHash!==row.content_hash?.toString('hex')
    ||canonicalJsonString(role.provenance)!==canonicalJsonString(row.source_provenance))throw Error('source_reference_hash_mismatch')
   bodies.set(row.source_event_id,role.payload)
  }
  checks.push((client,commit)=>prepared.assertCurrent(client,commit))
 }
 const assigned=new Set(publications.flatMap(p=>[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id]))
 if(rows.some(r=>!assigned.has(r.source_event_id))||!retained&&bodies.size!==rows.length)throw Error('team_semantic_publication_missing')
 return {bodies,async assertCurrent(client:Pick<pg.PoolClient,'query'>,commit=false){for(const check of checks)await check(client,commit)}}
}
