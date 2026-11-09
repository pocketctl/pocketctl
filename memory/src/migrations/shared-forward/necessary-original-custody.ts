import type pg from 'pg'
import {canonicalPayloadHash,createPostgresSharedSourceReader,verifyOriginalSourceHash,type SourceScope,type SourceRoot} from '@pocketctl/session-source'
import {assertOriginalCopiedSource,type OriginalBindingCopyReceipt} from './original-copy-proof.js'
import {assertFrozenMemorySource} from '../shared-source/maintenance.js'
import {assertTargetMemoryWritersFenced} from './source-maintenance-capabilities.js'
import {prepareOriginalDiscoveryObservation} from './original-discovery-observation.js'
import {hash,qi} from './source-maintenance-common.js'
import {readSourceProcessingCustodyDependency,validSourceProcessingCustodyWitness,type SourceProcessingCustodyWitness} from './source-processing-custody.js'

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
const digest=(v:unknown)=>canonicalPayloadHash(v).toString('hex')
const derived=new Set(['source_kind','canonical_key','canonical_session_key','source_version','source_sequence','content_hash','hash_version','mapping_state','adapter_version','canonical_projected_at','legacy_owner_user_id','legacy_manifest_hash'])
export interface NecessaryOriginalCustodyInput {copy:OriginalBindingCopyReceipt;scope:SourceScope;root:SourceRoot;sourceEventIds:string[];necessity?:'literal-reference'|'accepted-session'|'source-processing';discoveryWitness?:{canonicalKey:string};sourceProcessingWitness?:SourceProcessingCustodyWitness}
/** Read-only prerequisite shared by the operator and fixed live diagnostics.
 * Returns only original candidate/episode IDs and opaque metadata hashes. */
export async function readNecessaryOriginalDependencies(db:Pick<pg.Client,'query'>,schema:'public'|'memory',installationId:string,sessionId:string,sourceEventId:string,necessity:'literal-reference'|'accepted-session'='literal-reference'){
 if(!['literal-reference','accepted-session'].includes(necessity)||!['public','memory'].includes(schema)||!uuid(installationId)||!uuid(sourceEventId)||!sessionId||sessionId.length>512)throw Error('necessary_original_dependency_input_invalid')
 return (await db.query(`SELECT c.candidate_id::text,e.episode_id::text,
   encode(sha256(convert_to(jsonb_build_object('candidate',c.candidate_id,'revision',c.revision,'status',c.status,'episode',e.episode_id,
    'state',e.state,'digest',encode(e.source_digest,'hex'),'manifest',e.evidence_manifest,'handles',c.evidence_handles)::text,'UTF8')),'hex') AS facts_hash
   FROM ${schema}.memory_candidates c JOIN ${schema}.work_episodes e USING(installation_id,episode_id)
   WHERE c.installation_id=$1 AND c.status='accepted' AND e.session_id=$2 AND e.state NOT IN('invalidated','purged')
    AND octet_length(e.evidence_manifest::text)<=8388608 AND jsonb_typeof(e.evidence_manifest)='object'
    AND ($4::boolean OR EXISTS(SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(e.evidence_manifest)='object' THEN e.evidence_manifest ELSE '{}'::jsonb END) entry
      WHERE entry.value->>'source_event_id'=$3::text
       OR EXISTS(SELECT 1 FROM ${schema}.source_artifacts artifact WHERE artifact.installation_id=e.installation_id AND artifact.session_id=e.session_id
        AND artifact.artifact_id=CASE WHEN entry.value->>'artifact_id' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN (entry.value->>'artifact_id')::uuid END AND artifact.source_event_id=$3::uuid)))
   ORDER BY c.candidate_id LIMIT 257`,[installationId,sessionId,sourceEventId,necessity==='accepted-session'])).rows
}
/** Fixed original-Memory custody only. This does not prove a Relay identity,
 * canonical absence or deduplication. No raw-source discovery by content, no
 * transport recreation, and no producer lineage is inferred. */
export async function retainNecessaryOriginalPersonalReferencePage(source:pg.Client,target:pg.Client,input:NecessaryOriginalCustodyInput,options:{signal?:AbortSignal;beforeCommit?:()=>Promise<void>;archive?:Parameters<typeof createPostgresSharedSourceReader>[1]}={}){
 const {copy,scope,root,sourceEventIds:ids,necessity='literal-reference',discoveryWitness,sourceProcessingWitness}=structuredClone(input),abort=()=>{if(options.signal?.aborted)throw Error('necessary_original_aborted')}
 if(discoveryWitness&&(necessity!=='accepted-session'||Object.keys(discoveryWitness).length!==1||typeof discoveryWitness.canonicalKey!=='string'||!/^[1-9][0-9]*$/.test(discoveryWitness.canonicalKey)||BigInt(discoveryWitness.canonicalKey)>9223372036854775807n))throw Error('necessary_original_input_invalid')
 if((necessity==='source-processing')!==Boolean(sourceProcessingWitness)||sourceProcessingWitness&&!validSourceProcessingCustodyWitness(sourceProcessingWitness))throw Error('necessary_original_input_invalid')
 if(!['literal-reference','accepted-session','source-processing'].includes(necessity)||scope?.ownerScopeKind!=='personal'||!uuid(scope.installationId)||!/^[1-9][0-9]*$/.test(scope.principalUserId)||root?.kind!=='relay_event'
  ||!root.key.startsWith(scope.principalUserId+':')||!Array.isArray(ids)||ids.length<1||ids.length>256||ids.some(id=>!uuid(id))||new Set(ids).size!==ids.length)throw Error('necessary_original_input_invalid')
 abort();const columns=await assertOriginalCopiedSource(source,target,copy),session=root.key.slice(scope.principalUserId.length+1)
 const assertSessionPolicy=async()=>{if(['accepted-session','source-processing'].includes(necessity)&&!(await target.query("SELECT start_policy='retained_history' AND shared.memory_installation_input_ready(installation_id) AS ready FROM public.extension_installations WHERE installation_id=$1",[scope.installationId])).rows[0]?.ready)throw Error('necessary_original_session_policy_unproven')}
 await assertSessionPolicy()
 let processingHeadProof:Record<string,unknown>|undefined,processingHeadVersion:unknown
 if(sourceProcessingWitness){
  const dependency=await readSourceProcessingCustodyDependency(target,{scope,root,sessionId:session,sourceEventId:ids[0],witness:sourceProcessingWitness})
  if(dependency.length!==1)throw Error('necessary_original_dependency_unproven')
  // Actual current native input proves that the whole-Session mapping guard
  // is relevant. This is not compared with the old body or used as its ID.
  const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('necessary_original_external_io_forbidden')}},options.archive)
  const page=await reader.listHeads(scope,root,{limit:1})
  if(page.heads.length!==1||page.heads[0].sessionKey!==session)throw Error('necessary_original_dependency_unproven')
  processingHeadVersion=page.version;processingHeadProof={canonicalKey:page.heads[0].canonicalKey,contentHash:page.heads[0].contentHash,version:page.version}
 }
 const originalColumns=columns.filter(c=>!derived.has(c)),project=originalColumns.map(c=>'s.'+qi(c)).join(',')
 await source.query("SET TIME ZONE 'UTC'");await target.query("SET TIME ZONE 'UTC'")
 const rowSql=(schema:string)=>`SELECT s.source_event_id::text,s.xmin::text AS row_version,s.installation_id::text,s.origin,s.origin_position,s.canonical_event_key,s.session_id,s.turn_id,s.event_type,s.occurred_at,
  s.source_provenance,s.classification,s.body_reclaimed_at,encode(s.payload_hash,'hex') AS original_hash,
  encode(sha256(convert_to(row_to_json(original)::text,'UTF8')),'hex') AS original_row_hash
  ${schema==='memory'?",s.mapping_state,s.source_kind,s.canonical_key,s.canonical_session_key,s.source_sequence::text,encode(s.content_hash,'hex') AS content_hash,s.hash_version,s.adapter_version,s.legacy_owner_user_id::text,s.legacy_manifest_hash":''}
  FROM ${schema}.source_events s CROSS JOIN LATERAL(SELECT ${project}) original WHERE s.source_event_id=ANY($1::uuid[])
   AND pg_column_size(s.classification)<=32768 AND pg_column_size(s.source_provenance)<=32768 ORDER BY s.source_event_id`
 const originals=(await source.query(rowSql('public'),[ids])).rows,copied=(await target.query(rowSql('memory'),[ids])).rows
 if(originals.length!==ids.length||copied.length!==ids.length)throw Error('necessary_original_copy_changed')
 // The default proves literal packet handles. Explicit accepted-session custody
 // instead closes this same current personal Session's original references,
 // required by the canonical writer's whole-Session unknown-reference fence.
 // Both retain original cells without claiming canonical identity or absence.
 const manifests=new Map<string,Record<string,unknown>>(),necessities=new Map<string,string>(),contentHashes=new Map<string,string>()
 const observations=new Map<string,Awaited<ReturnType<typeof prepareOriginalDiscoveryObservation>>>()
 let bytes=0
 for(const a of originals){
  abort();const b=copied.find(r=>r.source_event_id===a.source_event_id)!
  if(a.original_row_hash!==b.original_row_hash||a.installation_id!==scope.installationId||a.session_id!==session||session.startsWith('team_')||a.origin!=='feed'
   ||!/^\d*[1-9]\d*$/.test(a.origin_position)||(!discoveryWitness&&a.canonical_event_key!==null)||a.body_reclaimed_at||digest(a.source_provenance)!==digest({})
   ||Object.hasOwn(a.classification??{},'memory_source'))throw Error('necessary_original_copy_changed')
  const originalBody=(await source.query(`SELECT CASE WHEN octet_length(payload::text)<=33554432 THEN payload ELSE NULL END AS payload FROM public.source_events WHERE source_event_id=$1`,[a.source_event_id])).rows[0]?.payload
  const format=originalBody&&verifyOriginalSourceHash({origin:a.origin,originPosition:a.origin_position,eventType:a.event_type,occurredAt:a.occurred_at,payload:originalBody,payloadHash:a.original_hash})
  if(format!=='canonical-json-sha256-v1'||!discoveryWitness&&typeof originalBody.event_id==='string'&&originalBody.event_id)throw Error('necessary_original_body_unproven')
  bytes+=Buffer.byteLength(JSON.stringify(originalBody));if(bytes>32*1024*1024)throw Error('necessary_original_body_limit')
  if(discoveryWitness)observations.set(a.source_event_id,await prepareOriginalDiscoveryObservation(source,target,scope,root,a,originalBody,discoveryWitness.canonicalKey,options.archive))
  if(!discoveryWitness&&((await source.query('SELECT 1 FROM public.memory_feed_inbox WHERE installation_id=$1 AND feed_id=$2 LIMIT 1',[scope.installationId,a.origin_position])).rowCount
   ||(await target.query('SELECT 1 FROM public.extension_feed WHERE feed_id=$1 LIMIT 1',[a.origin_position])).rowCount))throw Error('necessary_original_transport_still_present')
  let factsHash:string
  if(sourceProcessingWitness){
   const rows=await readSourceProcessingCustodyDependency(target,{scope,root,sessionId:session,sourceEventId:a.source_event_id,witness:sourceProcessingWitness})
   if(rows.length!==1)throw Error('necessary_original_dependency_unproven')
   factsHash=hash({rows,processingHeadProof})
  }else{
   const acceptedNecessity=necessity as 'literal-reference'|'accepted-session'
   const refs=await readNecessaryOriginalDependencies(source,'public',scope.installationId,session,a.source_event_id,acceptedNecessity),current=await readNecessaryOriginalDependencies(target,'memory',scope.installationId,session,a.source_event_id,acceptedNecessity)
   if(!refs.length||refs.length>256||hash(refs)!==hash(current))throw Error('necessary_original_dependency_unproven')
   factsHash=hash(refs)
  }
  const contentHash=digest(originalBody)
  contentHashes.set(a.source_event_id,contentHash);necessities.set(a.source_event_id,factsHash)
  const manifest={...(observations.has(a.source_event_id)?{discoveryObservation:observations.get(a.source_event_id)!.manifest}:{}),...(sourceProcessingWitness?{sourceProcessingWitness,processingHeadProof}:{}),schemaVersion:1,kind:'necessary-original-memory-custody',necessity,sourceEventId:a.source_event_id,installationId:scope.installationId,sessionId:session,
   sourceIdentity:copy.sourceIdentity,targetIdentity:copy.targetIdentity,copyManifestHash:copy.manifestHash,sourceRowVersion:a.row_version,originalRowHash:a.original_row_hash,
   originalSourceHash:a.original_hash,contentHash,classificationHash:digest(a.classification),provenanceHash:digest(a.source_provenance),necessaryDependencyHash:factsHash,
   currentScope:scope,canonicalIdentityResolved:false,canonicalAbsenceProven:false,bodyDisposition:'retain-original-cell',provenanceState:'unknown',sourceSequence:null,deletionAuthorized:false}
  manifests.set(a.source_event_id,manifest)
 }
 const authority=(await target.query("SELECT * FROM shared.memory_relay_source_authority($1::jsonb,'relay_event',$2)",[JSON.stringify(scope),root.key])).rows[0]
 if(authority?.state!=='current')throw Error('necessary_original_authority_changed')
 const canonicalVersion={content:authority.content_revision,authorization:authority.authorization_revision,storage:authority.storage_revision}
 if(sourceProcessingWitness&&digest(canonicalVersion)!==digest(processingHeadVersion))throw Error('necessary_original_authority_changed')
 abort();await options.beforeCommit?.();abort()
 let changed=0,alreadyBound=0
 try{
  await target.query('BEGIN');await target.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await assertTargetMemoryWritersFenced(target)
  if(!(await target.query("SELECT shared.lock_memory_personal_source_commit($1::jsonb,'relay_event',$2,$3::jsonb,FALSE) AS locked",[JSON.stringify(scope),root.key,JSON.stringify(canonicalVersion)])).rows[0]?.locked)throw Error('necessary_original_authority_changed')
  if(sourceProcessingWitness)await target.query('LOCK TABLE shared.memory_source_modes,shared.memory_source_distributions,shared.memory_source_distribution_targets,memory.memory_jobs IN SHARE MODE NOWAIT')
  if(!(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||$1,0)) AS locked",[scope.installationId])).rows[0].locked)throw Error('necessary_original_busy')
  await assertSessionPolicy()
  await target.query('LOCK TABLE memory.memory_candidates,memory.work_episodes,memory.source_artifacts IN SHARE MODE NOWAIT')
  const changes:{id:string;version:string;manifest:string;contentHash:string}[]=[]
  for(const a of originals){
   abort();const b=copied.find(r=>r.source_event_id===a.source_event_id)!,manifestHash=hash(manifests.get(a.source_event_id)),contentHash=contentHashes.get(a.source_event_id)!
   await observations.get(a.source_event_id)?.assertCurrent()
   const currentDependency=sourceProcessingWitness?hash({rows:await readSourceProcessingCustodyDependency(target,{scope,root,sessionId:session,sourceEventId:a.source_event_id,witness:sourceProcessingWitness}),processingHeadProof}):hash(await readNecessaryOriginalDependencies(target,'memory',scope.installationId,session,a.source_event_id,necessity as 'literal-reference'|'accepted-session'))
   if(currentDependency!==necessities.get(a.source_event_id))throw Error('necessary_original_dependency_changed')
   if((await target.query('SELECT 1 FROM memory.memory_source_retention_receipts WHERE installation_id=$1 AND session_id=$2 AND($3::text IS NULL OR turn_id=$3) LIMIT 1',[scope.installationId,session,a.turn_id])).rowCount)throw Error('necessary_original_usage_revoked')
   if(b.mapping_state==='verified'){
    if(b.source_kind!=='legacy_archive'||b.canonical_key!==a.source_event_id||b.canonical_session_key!==session||b.legacy_owner_user_id!==scope.principalUserId||b.legacy_manifest_hash!==manifestHash
     ||b.adapter_version!=='legacy-archive-v1'||b.source_sequence!==null||b.content_hash!==contentHash||b.hash_version!=='canonical-json-sha256-v1')throw Error('necessary_original_existing_conflict')
    if(!(await target.query('SELECT 1 FROM memory.source_events WHERE source_event_id=$1 AND xmin::text=$2 FOR UPDATE NOWAIT',[a.source_event_id,b.row_version])).rowCount)throw Error('necessary_original_row_changed')
    alreadyBound++
   }else{
    if(b.mapping_state!=='unproven'||b.source_kind!==null||b.canonical_key!==null||b.canonical_session_key!==null||b.source_sequence!==null||b.content_hash!==null||b.legacy_manifest_hash!==null||b.legacy_owner_user_id!==null)throw Error('necessary_original_existing_conflict')
    changes.push({id:a.source_event_id,version:b.row_version,manifest:manifestHash,contentHash})
   }
  }
  if(changes.length){
   // One statement means the established archive capture increments this
   // root once. Reserve its existing dirty fence, then record that exact
   // resulting version; no invented producer or Journal order is involved.
   if(!(await target.query("SELECT pg_try_advisory_xact_lock(hashtextextended('memory-source-dirty:legacy_archive:'||$1,0)) AS locked",[root.key])).rows[0].locked)throw Error('necessary_original_busy')
   await target.query("SELECT 1 FROM shared.memory_source_work WHERE source_kind='legacy_archive' AND root_key=$1 FOR UPDATE NOWAIT",[root.key])
   const version=(await target.query(`SELECT jsonb_build_object('content',(COALESCE((SELECT revision FROM shared.memory_source_work WHERE source_kind='legacy_archive' AND root_key=$1),0)+1)::text,
    'authorization',$2::text,'storage',(COALESCE((SELECT storage_revision FROM shared.memory_source_work WHERE source_kind='legacy_archive' AND root_key=$1),0)+COALESCE((SELECT revision FROM shared.memory_local_source_rights WHERE installation_id=$3),0))::text) AS value`,[root.key,scope.authorizationRevision,scope.installationId])).rows[0].value
   const updated=await target.query(`UPDATE memory.source_events s SET mapping_state='verified',source_kind='legacy_archive',canonical_key=s.source_event_id::text,canonical_session_key=s.session_id,
    source_version=$2::jsonb,source_sequence=NULL,content_hash=decode(r."contentHash",'hex'),hash_version='canonical-json-sha256-v1',adapter_version='legacy-archive-v1',legacy_owner_user_id=$3::int,legacy_manifest_hash=r.manifest
    FROM jsonb_to_recordset($1::jsonb) r(id uuid,version text,manifest text,"contentHash" text)
    WHERE s.source_event_id=r.id AND s.xmin::text=r.version AND s.mapping_state='unproven'`,[JSON.stringify(changes),JSON.stringify(version),scope.principalUserId])
   if(updated.rowCount!==changes.length)throw Error('necessary_original_row_changed');changed=updated.rowCount
  }
  abort();await assertFrozenMemorySource(source);await target.query('COMMIT')
 }catch(error){await target.query('ROLLBACK').catch(()=>{});throw error}
 // The newly explicit original UUID must now be readable by the established
 // legacy adapter. Apps remain fenced; a failure requires forward repair.
 const reader=createPostgresSharedSourceReader({query:(sql,args)=>target.query(sql,args),async connect(){throw Error('necessary_original_external_io_forbidden')}}),legacyRoot={kind:'legacy_archive' as const,key:root.key}
 const heads=await reader.getHeads(scope,legacyRoot,ids),bodies=await reader.resolveBodies(scope,legacyRoot,heads.heads,heads.version)
 if(bodies.length!==ids.length||bodies.some(b=>b.head.contentHash!==contentHashes.get(b.head.canonicalKey)||digest(b.payload)!==contentHashes.get(b.head.canonicalKey)||b.head.provenance.state!=='unknown'))throw Error('necessary_original_current_reader_conflict')
 return {schemaVersion:1,kind:'necessary-original-memory-custody',necessity,copyManifestHash:copy.manifestHash,installationId:scope.installationId,rootKey:root.key,changed,alreadyBound,sourceVersion:heads.version,
  manifests:[...manifests.values()],canonicalIdentityResolved:false,canonicalAbsenceProven:false,sourceBodiesChanged:false,originalIdsPreserved:true,provenanceRewritten:false,deletionAuthorized:false}
}
