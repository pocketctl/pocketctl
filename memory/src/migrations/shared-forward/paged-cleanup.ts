import {bindPagedSkillGrants,assertPagedJobPayloads} from './paged-cleanup-native-shapes.js'
import {pagedContextGenerationRows,assertPagedActiveExtractions} from './paged-cleanup-operational.js'
import {pagedAffectedEpisodePredicate,assertPagedExactEpisodes} from './paged-cleanup-exact-source.js'
import {bindPagedAccounting} from './paged-cleanup-accounting.js'
import {nativeOutputBoundary,observeNativeOutputs} from './paged-cleanup-native-outputs.js'
import {bindPagedOriginalSources} from './paged-cleanup-source.js'
import pg from 'pg'
import {mkdtemp,open,rm} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {PagedCleanupManifestWriter,openPagedCleanupManifest,readPagedCleanupParts,pagedHash,validatePagedCleanupPart,type PagedCleanupPart,type PagedCleanupRecord,type PagedCleanupHeader} from './paged-cleanup-manifest.js'
import {pagedConfigHash,pagedWindow,pagedAuthority,normalizedPagedRoots,type PagedCleanupConfig,type PagedCleanupOptions,type PagedRoot} from './paged-cleanup-authority.js'
import {type PagedCatalog} from './paged-cleanup-catalog.js'
import {selectPagedRows,pagedBytePrefix,tableShape,observePagedPart,observePagedRow,assertPagedOriginalState,assertPagedEdges,referenceContractHash} from './paged-cleanup-state.js'
import {analyzePagedMetadata,pagedTables,pagedFileStateSeed,extendPagedFileState,preparePagedMetadata,beginPagedLoad,loadPagedPart,assertStoredPagedPart,sealPagedLoad,requirePagedSeal,pagedPrefix,writePagedReceipt,updatePagedExpectedBatch,pagedRelation,auditPagedMetadata,lockPagedMetadata} from './paged-cleanup-receipts.js'
import {discoverLinkedClosure,bindLinkedPolicyOutputs} from './forward-cleanup-linked.js'
import type {CleanupDependencies} from './forward-cleanup-state.js'
import {applyStagedSessionPage} from '../../purge/staged-session.js'
import {hash,qi} from './source-maintenance-common.js'
export type {PagedCleanupConfig,PagedCleanupOptions,PagedRoot} from './paged-cleanup-authority.js'
const rawOrder=['memory_context_packs','memory_task_bundles','memory_source_processing_receipts','memory_session_scene_frames','work_episodes','source_artifacts','source_turns','source_events','memory_snapshot_events','memory_source_retention_receipts','memory_feed_inbox','memory_skill_executions']
// Frozen native governance capture emits a metadata-only audit row for each
// raw source/episode deletion. Reserve escaped identity plus fixed native
// sequence/time/revision/operation fields; actual outputs are still measured.
const rawAuditTables=new Set(['source_events','source_artifacts','source_turns','work_episodes'])
const rawAuditReserve=(row:PagedCleanupRecord)=>rawAuditTables.has(row.table)?512n+4n*BigInt(Buffer.byteLength(JSON.stringify(row.key))):0n
const protectedTable=(name:string)=>/budget|attempt|usage_outbox|capsule|policy|settings|consent/.test(name)
function dependencies(roots:readonly PagedRoot[],episodes:string[],config:PagedCleanupConfig):CleanupDependencies{return {roots:[...roots],installationIds:config.installationIds,broadIds:[],sourceEventIds:[],artifactIds:[],episodeIds:episodes,candidateIds:[],packIds:[],injectionIds:[],bundleIds:[]}}
async function recordsForRefs(c:pg.Client,catalog:PagedCatalog,table:string,refs:Record<string,string|null>[]):Promise<PagedCleanupRecord[]>{
 const shape=tableShape(catalog,table)
 if(!refs.length)return []
 if(refs.length>1024)throw Error('paged_component_capacity')
 const result=await selectPagedRows(c,shape,`EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::memory.${qi(table)},$1::jsonb) k WHERE ${shape.pk.map(k=>`t.${qi(k)} IS NOT DISTINCT FROM k.${qi(k)}`).join(' AND ')})`,[JSON.stringify(refs)],null,1024)
 if(result.length!==refs.length)throw Error('paged_component_row_changed')
 return result
}
async function episodeChildren(c:pg.Client,catalog:PagedCatalog,records:PagedCleanupRecord[]){
 const result=new Set<string>(),ids=records.map(r=>r.key.episode_id!)
 for(const edge of catalog.edges.filter(e=>e.parent==='work_episodes')){
  const index=edge.parentColumns.indexOf('episode_id');if(index<0)continue
  for(const row of(await c.query(`SELECT DISTINCT t.${qi(edge.childColumns[index])}::text AS id FROM memory.${qi(edge.child)} t WHERE t.${qi(edge.childColumns[index])}=ANY($1::uuid[]) LIMIT 1025`,[ids])).rows)result.add(row.id)
 }
 return result
}
async function episodeComponent(c:pg.Client,catalog:PagedCatalog,config:PagedCleanupConfig,roots:readonly PagedRoot[],seeds:PagedCleanupRecord[]){
 const seed=seeds[0];if(!seed||seeds.some(r=>r.references.installation_id!==seed.references.installation_id))throw Error('paged_component_cross_owner')
 let ids=[...new Set(seeds.map(r=>r.key.episode_id!))],closure:Awaited<ReturnType<typeof discoverLinkedClosure>>|undefined,d:CleanupDependencies
 for(let round=0;round<32;round++){
  d=dependencies(roots,ids,config)
  try{closure=await discoverLinkedClosure(c,d,undefined,true)}catch(error){if(/bound|depth/.test((error as Error).message))throw Error('paged_component_capacity');throw error}
  const candidate=[...new Set([...closure.supportEpisodeIds,...Object.values(closure.rows).flatMap(rows=>rows.map(r=>r.episode_id).filter((id):id is string=>!!id))])]
  const selected=(await c.query(`SELECT episode_id::text FROM memory.work_episodes e WHERE episode_id=ANY($1::uuid[]) AND(EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) WHERE e.installation_id=r."installationId" AND e.session_id=r."sessionId") OR ${pagedAffectedEpisodePredicate('e','$2')}) ORDER BY episode_id`,[candidate,JSON.stringify(roots)])).rows.map(r=>r.episode_id as string)
  const next=[...new Set([...ids,...selected])].sort();if(next.length>1024)throw Error('paged_component_capacity');if(pagedHash(next)===pagedHash([...ids].sort())){ids=next;break}ids=next;if(round===31)throw Error('paged_component_capacity')
 }
 // A necessary lower bound avoids expensive body/policy prediction for a
 // divisible seed batch that must already split. Connected components still
 // use the same complete native closure and unchanged limits.
 if(Object.values(closure!.rows).reduce((n,rows)=>n+rows.length,0)*4>1024)throw Error('paged_component_capacity')
 const outside=(await c.query(`SELECT episode_id::text FROM memory.work_episodes e WHERE episode_id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) WHERE e.installation_id=r."installationId" AND e.session_id=r."sessionId")`,[ids,JSON.stringify(roots)])).rows.map(r=>r.episode_id as string)
 await assertPagedActiveExtractions(c,ids)
 await assertPagedExactEpisodes(c,roots,config.installationIds,outside)
 if(outside.length)closure!.exactSources!.episodeIds=[...ids]
 const records:PagedCleanupRecord[]=[]
 for(const [table,refs] of Object.entries(closure!.rows))records.push(...await recordsForRefs(c,catalog,table,refs))
 for(const id of closure!.supportEpisodeIds)if(!records.some(r=>r.table==='work_episodes'&&r.key.episode_id===id))records.push(...await recordsForRefs(c,catalog,'work_episodes',[{installation_id:seed.references.installation_id!,episode_id:id}]))
 if(records.reduce((n,r)=>n+2n*BigInt(r.bytes)+rawAuditReserve(r),0n)>8388608n)throw Error('paged_component_capacity')
 await bindPagedSkillGrants(c,records)
 for(const row of records){
  if(row.references.installation_id&&row.references.installation_id!==seed.references.installation_id)throw Error('paged_component_cross_owner')
  row.disposition=protectedTable(row.table)?'preserve':'invalidate'
  if(row.table==='work_episodes'){
   if(outside.includes(row.key.episode_id!))row.references.exact_source_policy_hash=pagedHash('native-exact-source-packet-v2')
   if(!ids.includes(row.key.episode_id!)){row.disposition='preserve';row.retainReason='replacement_support';continue}
   const required=(await c.query(`SELECT EXISTS(SELECT 1 FROM memory.memory_extraction_runs WHERE installation_id=$1 AND episode_id=$2 AND(generation_run_id IS NOT NULL OR input_tokens>0 OR output_tokens>0 OR cost_micros>0 OR error_code='provider_result_unknown' OR state='running')) OR EXISTS(SELECT 1 FROM memory.memory_skill_task_runs WHERE installation_id=$1 AND episode_id=$2 AND(generation_run_id IS NOT NULL OR budget_reservation_id IS NOT NULL OR state IN('pending','running'))) AS retained`,[row.references.installation_id,row.key.episode_id])).rows[0].retained
   if(required)row.retainReason='incurred_effect'
   else if(outside.includes(row.key.episode_id!))row.retainReason='referenced_source_loss'
  }
  if(row.table==='memory_extraction_runs')row.disposition='preserve'
  if(row.table==='memory_generation_runs')row.retainReason='incurred_effect'
 }
 d=dependencies(roots,ids,config);try{await bindLinkedPolicyOutputs(c,closure!,d,config.tombstoneHmacKeys)}catch(error){if((error as Error).message==='cleanup_linked_policy_output_row_bound_exceeded')throw Error('paged_component_capacity');throw error}
 await bindPagedAccounting(c,records)
 // Native metadata outputs have stable semantic keys even when a job's
 // physical UUID is allocated by the original native INSERT.
 const outputs:Pick<PagedCleanupRecord,'table'|'key'>[]=[...closure!.tombstones.map(t=>({table:'knowledge_tombstones',key:{installation_id:t.installation_id,key_id:t.key_id,identity_hmac:t.identity_hmac}})),...closure!.jobKeys.map(key=>({table:'memory_jobs',key:{installation_id:seed.references.installation_id!,job_type:'index_claim_version',idempotency_key:key}}))]
 for(const output of outputs){const template:PagedCleanupRecord={...output,references:{},fingerprint:'0'.repeat(64),bytes:'0',disposition:'output'},actual=await observePagedRow(c,catalog,template);if(actual){template.fingerprint=actual.fingerprint;template.references.row_version=actual.version}records.push(template)}
 await assertPagedJobPayloads(c,records)
 if(records.length*4>1024||records.reduce((n,r)=>n+2n*BigInt(r.bytes)+rawAuditReserve(r),0n)>8388608n)throw Error('paged_component_capacity')
 return {componentHash:pagedHash(ids),records,ids}
}
async function nativeClosureForRaw(c:pg.Client,catalog:PagedCatalog,config:PagedCleanupConfig,root:PagedRoot,row:PagedCleanupRecord){
 if(!['memory_context_packs','memory_task_bundles'].includes(row.table))return [row]
 const d=dependencies([],[],config);if(row.table==='memory_context_packs')d.packIds=[row.key.pack_id!];else d.bundleIds=[row.key.bundle_id!]
 const closure=await discoverLinkedClosure(c,d,undefined,true),records:PagedCleanupRecord[]=[]
 for(const [table,refs] of Object.entries(closure.rows))for(const found of await recordsForRefs(c,catalog,table,refs))records.push({...found,disposition:table===row.table?'delete':'invalidate'})
 if(records.length*4>1024)throw Error('paged_component_capacity');return records
}
/** Read-only keyset discovery; filesystem IO occurs after each SQL window. */
export async function planPagedCleanup(config:PagedCleanupConfig,inputRoots:readonly PagedRoot[],directory:string,options:PagedCleanupOptions={}){
 const roots=normalizedPagedRoots(config,inputRoots),configHash=pagedConfigHash(config),initial=await pagedWindow(config,options,true,async(c,identity)=>({identity,...await pagedAuthority(c,config,roots)}))
 const binding={identity:initial.identity,configHash,catalogHash:initial.catalog.hash,authorityHash:initial.hash,referenceContractHash:referenceContractHash(),rootsHash:pagedHash(roots)},writer=await PagedCleanupManifestWriter.create(directory,binding,options)
 const scratch=await mkdtemp(join(dirname(resolve(directory)),'.paged-components-'));let ordinal=0n
 const discover=async<T>(body:(c:pg.Client)=>Promise<T>)=>pagedWindow(config,options,true,async(c,identity)=>{if(identity!==initial.identity)throw Error('paged_identity_drift');const current=await pagedAuthority(c,config,roots);if(current.hash!==initial.hash)throw Error('paged_authority_drift');return body(c)})
 const emit=async(phase:PagedCleanupPart['phase'],root:PagedRoot,records:PagedCleanupRecord[],componentHash=pagedHash(records.map(r=>[r.table,r.key])))=>{if(!records.length)return;const page={ordinal:String(ordinal++),phase,root,componentHash,records};validatePagedCleanupPart(page);await writer.append(page)}
 try{
  // Accepted capsule identities remain frozen even when their source parents
  // are later absent; do not cap the total retained set at4096.
  for(const installationId of config.installationIds){let cursor:Record<string,string|null>|null=null;for(;;){const rows=await discover(c=>selectPagedRows(c,tableShape(initial.catalog,'knowledge_evidence_capsules'),'t.installation_id=$1',[installationId],cursor));if(!rows.length)break;await emit('authority',roots.find(r=>r.installationId===installationId)??roots[0],rows.map(r=>({...r,retainReason:'independent_accepted'})));cursor=rows.at(-1)!.key}}
  const affectedOwners=new Set<string>()
  for(const root of roots){
   let generationCursor:Record<string,string|null>|null=null,generationLimit=128
   for(;;){let batch:Awaited<ReturnType<typeof pagedContextGenerationRows>>
    try{batch=await discover(c=>pagedContextGenerationRows(c,initial.catalog,root,generationCursor,generationLimit))}
    catch(error){if((error as Error).message!=='paged_context_component_capacity'||generationLimit===1)throw error;generationLimit=Math.max(1,Math.floor(generationLimit/2));continue}
    if(!batch.rows.length)break;await emit('operational',root,batch.records);generationCursor=batch.rows.at(-1)!.key;generationLimit=128
   }
    const markerPath=(id:string)=>join(scratch,pagedHash([root.installationId,id]))
    const seen=async(id:string)=>{try{const file=await open(markerPath(id),'r');await file.close();return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}}
    const bounded=async(seeds:PagedCleanupRecord[]):Promise<void>=>{
     if(!seeds.length)return
     let component:Awaited<ReturnType<typeof episodeComponent>>
     try{component=await discover(c=>episodeComponent(c,initial.catalog,config,roots,seeds))}
     catch(error){if((error as Error).message!=='paged_component_capacity'||seeds.length===1)throw error;const at=Math.floor(seeds.length/2);await bounded(seeds.slice(0,at));const rest:PagedCleanupRecord[]=[];for(const row of seeds.slice(at))if(!await seen(row.key.episode_id!))rest.push(row);await bounded(rest);return}
     for(const id of component.ids)if(await seen(id))throw Error('paged_component_overlap')
     for(const id of component.ids){const file=await open(markerPath(id),'wx',0o600);await file.close()}
     await emit('derived',root,component.records,component.componentHash)
    }
   if(!affectedOwners.has(root.installationId)){
    affectedOwners.add(root.installationId);let after:Record<string,string|null>|null=null
    for(;;){const rows=await discover(c=>selectPagedRows(c,tableShape(initial.catalog,'work_episodes'),`t.installation_id=$1 AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("installationId" uuid,"sessionId" text) WHERE t.installation_id=r."installationId" AND t.session_id=r."sessionId") AND ${pagedAffectedEpisodePredicate('t','$2')}`,[root.installationId,JSON.stringify(roots)],after));if(!rows.length)break
     const pending:PagedCleanupRecord[]=[];for(const row of rows)if(!await seen(row.key.episode_id!))pending.push(row);await bounded(pending);after=rows.at(-1)!.key
    }
   }
   // Discover complete Claim/Skill/native components before raw phases. The
   // disk set suppresses repeats without an installation-sized JS array.
   let cursor:Record<string,string|null>|null=null
   for(;;){const batch=await discover(async c=>{const rows=await selectPagedRows(c,tableShape(initial.catalog,'work_episodes'),'t.installation_id=$1 AND t.session_id=$2',[root.installationId,root.sessionId],cursor);await assertPagedActiveExtractions(c,rows.map(row=>row.key.episode_id!));return {rows,linked:[...await episodeChildren(c,initial.catalog,rows)]}});if(!batch.rows.length)break
    const pending:PagedCleanupRecord[]=[];for(const row of batch.rows.filter(r=>batch.linked.includes(r.key.episode_id!)))if(!await seen(row.key.episode_id!))pending.push(row)
    await bounded(pending)
    cursor=batch.rows.at(-1)!.key
   }
   // Exact feedback IDs are captured before source joins can disappear.
   cursor=null;for(;;){const rows=await discover(c=>selectPagedRows(c,tableShape(initial.catalog,'memory_feedback'),"t.installation_id=$1 AND t.details->>'session_id'=$2",[root.installationId,root.sessionId],cursor));if(!rows.length)break;await emit('feedback',root,rows.map(r=>({...r,disposition:'minimize'})));cursor=rows.at(-1)!.key}
   for(const table of rawOrder){
    cursor=null
    let rawLimit=128
    for(;;){
     let batch:{rows:PagedCleanupRecord[];selected:PagedCleanupRecord[]}
     try{
      batch=await discover(async c=>{
       const rows=pagedBytePrefix(await selectPagedRows(c,tableShape(initial.catalog,table),
        't.installation_id=$1 AND t.session_id=$2',[root.installationId,root.sessionId],cursor,rawLimit),8388608n,rawAuditReserve)
       if(table==='source_events')await bindPagedOriginalSources(c,rows)
       if(table==='source_events'&&rows.some(r=>r.references.canonical_session_key&&r.references.canonical_session_key!==root.sessionId))throw Error('paged_alias_exact_adapter_required')
       const linked=table==='work_episodes'?await episodeChildren(c,initial.catalog,rows):new Set<string>()
       return {rows,selected:rows.filter(r=>!linked.has(r.key.episode_id!))}
      })
     }catch(error){
      if((error as Error).message!=='paged_source_capacity'||rawLimit===1)throw error
      rawLimit=Math.max(1,Math.floor(rawLimit/2));continue
     }
     if(!batch.rows.length)break
     if(['memory_context_packs','memory_task_bundles'].includes(table)){
      for(const row of batch.selected)await emit('raw',root,await discover(c=>nativeClosureForRaw(c,initial.catalog,config,root,{...row,disposition:'delete'})))
     }else await emit('raw',root,batch.selected.map(r=>({...r,disposition:'delete'})))
     cursor=batch.rows.at(-1)!.key;rawLimit=128
    }
   }
   const final=await discover(async c=>{const rows=await selectPagedRows(c,tableShape(initial.catalog,'source_sessions'),'t.installation_id=$1 AND t.session_id=$2',[root.installationId,root.sessionId]);if(rows.length!==1)throw Error('paged_original_session_required');const tombstones=await selectPagedRows(c,tableShape(initial.catalog,'memory_session_tombstones'),'t.installation_id=$1 AND t.session_id=$2',[root.installationId,root.sessionId]);return [...rows.map(r=>({...r,disposition:'minimize' as const,references:{...r.references,barrier_reason_key:initial.sessions.find(s=>s.installationId===root.installationId&&s.sessionId===root.sessionId)!.reason}})),...(tombstones.length?tombstones:[{table:'memory_session_tombstones',key:{installation_id:root.installationId,session_id:root.sessionId},references:{},fingerprint:'0'.repeat(64),bytes:'0',disposition:'output' as const}])]})
   await emit('final',root,final)
  }
  await discover(async()=>undefined);return await writer.finish()
 }catch(error){await writer.abort();throw error}finally{await rm(scratch,{recursive:true,force:true})}
}
async function rootsFromManifest(directory:string){const opened=await openPagedCleanupManifest(directory),roots=new Map<string,PagedRoot>();for await(const page of readPagedCleanupParts(opened))if(page.phase==='final')roots.set(pagedHash(page.root),page.root);const result=[...roots.values()].sort((a,b)=>a.installationId.localeCompare(b.installationId)||a.sessionId.localeCompare(b.sessionId));if(pagedHash(result)!==opened.header.rootsHash)throw Error('paged_manifest_roots_drift');return {opened,roots:result}}
async function checkWindow(c:pg.Client,identity:string,config:PagedCleanupConfig,header:PagedCleanupHeader,roots:readonly PagedRoot[],locked:boolean){
 if(identity!==header.identity||pagedConfigHash(config)!==header.configHash||referenceContractHash()!==header.referenceContractHash)throw Error('paged_manifest_binding_drift')
 const current=await pagedAuthority(c,config,roots,locked);if(locked&&await auditPagedMetadata(c))await lockPagedMetadata(c);if(current.hash!==header.authorityHash)throw Error('paged_authority_drift');return current.catalog
}
function receipt(header:PagedCleanupHeader,completed:string,ready:boolean){return {schemaVersion:4,kind:'memory-paged-privacy-cleanup-verification',verificationScope:'fixed_original_personal_roots',globalRetainedAuthorityVerified:false,manifestHash:header.manifestHash,completedPages:completed,totalPages:header.partCount,privacyCatchupReadyForReopen:ready,reopeningReady:false,activationAuthorized:false,backupCreated:false,rollbackSupported:false}}
export async function applyPagedCleanup(config:PagedCleanupConfig,directory:string,options:PagedCleanupOptions={}){
 const {opened,roots}=await rootsFromManifest(directory),header=opened.header;normalizedPagedRoots(config,roots)
 await pagedWindow(config,options,false,async(c,identity)=>{await checkWindow(c,identity,config,header,roots,true);await preparePagedMetadata(c);await beginPagedLoad(c,header)})
 let loadedHash=header.manifestHash,fileStateRoot=pagedFileStateSeed(header)
 for await(const page of readPagedCleanupParts(opened)){
  const witness=await pagedWindow(config,options,false,async(c,identity)=>{
   await checkWindow(c,identity,config,header,roots,true);await auditPagedMetadata(c,true)
   return loadPagedPart(c,header,page)
  })
  fileStateRoot=extendPagedFileState(fileStateRoot,witness)
  loadedHash=pagedHash([loadedHash,page.ordinal,pagedHash(page)])
 }
 // The complete newly loaded set must have current statistics before the
 // first exhaustive seal/state join. Resume refreshes changed receipt/item
 // estimates too, without rewriting any authenticated metadata row.
 for(const table of Object.keys(pagedTables) as (keyof typeof pagedTables)[]){
  await pagedWindow(config,options,false,async(c,identity)=>{
   await checkWindow(c,identity,config,header,roots,true)
   await analyzePagedMetadata(c,table)
  })
 }
 const initialPrefix=await pagedWindow(config,options,false,async(c,identity)=>{
  const catalog=await checkWindow(c,identity,config,header,roots,true)
  await sealPagedLoad(c,header,loadedHash);await requirePagedSeal(c,header,fileStateRoot)
  await assertPagedOriginalState(c,catalog,header);await assertPagedEdges(c,catalog,header,roots,true)
  return pagedPrefix(c,header)
 })
 for await(const page of readPagedCleanupParts(opened)){
  // Every prior page has just been authenticated against the immutable files,
  // exact receipt chain and full current original state/edges. It has no new
  // DML to fence. Every remaining write and final verification rechecks all
  // current authority, original identities and negative channels as before.
  if(BigInt(page.ordinal)<BigInt(initialPrefix.completed))continue
  const committed=await pagedWindow(config,options,false,async(c,identity)=>{
   const catalog=await checkWindow(c,identity,config,header,roots,true);await c.query("SELECT pg_advisory_xact_lock(hashtextextended('memory-paged-cleanup:'||$1,0))",[header.manifestHash]);await requirePagedSeal(c,header,fileStateRoot)
   await assertPagedOriginalState(c,catalog,header);await assertPagedEdges(c,catalog,header,roots,true);const prefix=await pagedPrefix(c,header)
   if(BigInt(page.ordinal)<BigInt(prefix.completed))return false;if(page.ordinal!==prefix.completed)throw Error('paged_receipt_prefix_drift')
   const before=await observePagedPart(c,catalog,page),statsBefore=Number((await c.query("SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::text AS n FROM pg_stat_xact_user_tables WHERE schemaname='memory'")).rows[0].n)
   const outputBoundary=await nativeOutputBoundary(c)
   await c.query('SET LOCAL search_path=memory,pg_catalog');await applyStagedSessionPage(c,page,config.tombstoneHmacKeys)
   await assertPagedJobPayloads(c,page.records)
   const changed=Number((await c.query("SELECT COALESCE(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::text AS n FROM pg_stat_xact_user_tables WHERE schemaname='memory'")).rows[0].n)-statsBefore
   if(changed>1024)throw Error('paged_native_effect_capacity')
   const after=await observePagedPart(c,catalog,page),nativeOutputs=await observeNativeOutputs(c,page,outputBoundary,after)
   if(page.records.length+nativeOutputs.length>1024)throw Error('paged_native_effect_capacity')
   const workBytes=before.reduce((n,r)=>n+BigInt(r.actual?.bytes??0),0n)+after.reduce((n,r)=>n+BigInt(r.actual?.bytes??0),0n)+nativeOutputs.reduce((n,r)=>n+BigInt(r.actual.bytes),0n)
   if(workBytes>8388608n)throw Error('paged_native_work_byte_capacity')
   for(let i=0;i<page.records.length;i++){
    if(page.records[i].disposition==='preserve'&&pagedHash(before[i])!==pagedHash(after[i]))throw Error('paged_protected_original_changed')
   }
   await updatePagedExpectedBatch(c,header,page,after)
   await assertPagedEdges(c,catalog,header,roots)
   await writePagedReceipt(c,header,page,prefix.tailHash,pagedHash(before),pagedHash(after),[...after,...nativeOutputs])
   await assertPagedOriginalState(c,catalog,header)
   await c.query('SET LOCAL search_path=pg_catalog');await checkWindow(c,identity,config,header,roots,true)
   return true
  })
  if(committed)await options.afterCommit?.(page.ordinal)
 }
 return verifyPagedCleanup(config,directory,options)
}
export const resumePagedCleanup=applyPagedCleanup
/** A process-local preparation handle, never a serialized receipt or authority.
 * Actual private files are authenticated before the caller's final transaction. */
export interface PreparedPagedCleanupVerification {readonly kind:'prepared-paged-cleanup-verification'}
interface PreparedPagedCleanupState {config:PagedCleanupConfig;configHash:string;header:PagedCleanupHeader;roots:readonly PagedRoot[];fileStateRoot:string;prefix:{completed:string;tailHash:string}}
const preparedPagedCleanupVerifications=new WeakMap<object,PreparedPagedCleanupState>()
function freezePagedPreparation<T>(value:T):T{
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezePagedPreparation(child);Object.freeze(value)}
 return value
}
export async function preparePagedCleanupVerification(config:PagedCleanupConfig,directory:string,options:PagedCleanupOptions={}):Promise<PreparedPagedCleanupVerification>{
 // Snapshot before the first await. Neither the caller nor the public handle
 // retains a mutable reference to config, keys, header, roots or file anchor.
 const snapshot=freezePagedPreparation(structuredClone(config)),configHash=hash(snapshot)
 const prepared=await authenticatePagedVerificationFiles(snapshot,directory,options)
 const checked=await pagedWindow(snapshot,options,true,(c,identity)=>checkPagedVerificationCurrent(c,identity,snapshot,prepared.header,prepared.roots,prepared.fileStateRoot,false))
 if(!checked.verification.privacyCatchupReadyForReopen)throw Error('paged_current_cleanup_incomplete')
 const capability=Object.freeze({kind:'prepared-paged-cleanup-verification' as const})
 preparedPagedCleanupVerifications.set(capability,freezePagedPreparation({config:snapshot,configHash,...structuredClone(prepared),prefix:structuredClone(checked.prefix)}))
 return capability
}
/** Query only the passed backend. No BEGIN/COMMIT/savepoint, connection,
 * window, probe or file IO. The outer bounded maintenance caller owns the
 * physical <=10 s deadline through COMMIT and global native lock ordering.
 * This guard cannot control a caller's delayed COMMIT after returning. */
async function currentPagedTransaction(c:pg.Client,expected:PagedCleanupConfig['database']['expected']){
 if(!(c instanceof pg.Client)||c.getTransactionStatus()!=='T')throw Error('paged_current_transaction_required')
 const row=(await c.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",
  inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",
  pg_backend_pid()::text AS backend,transaction_timestamp()::text AS started,
  (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_started,
  current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
  current_setting('search_path') AS path,current_setting('row_security') AS row_security,current_setting('TimeZone') AS timezone,
  (SELECT setting::numeric>0 AND setting::numeric<=5000 FROM pg_settings WHERE name='statement_timeout') AS statement_bounded,
  (SELECT setting::numeric>0 AND setting::numeric<=1000 FROM pg_settings WHERE name='lock_timeout') AS lock_bounded,
  clock_timestamp()-transaction_timestamp() < interval '10 seconds' AS age_bounded,
  (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS administrator
  FROM pg_database d WHERE datname=current_database()`)).rows[0]
 if(!row||row.isolation!=='read committed'||row.read_only!=='off'||row.path!=='pg_catalog'||row.row_security!=='off'||row.timezone!=='UTC'||row.statement_bounded!==true||row.lock_bounded!==true||row.age_bounded!==true||row.administrator!==true)throw Error('paged_current_transaction_contract')
 const actual={database:row.database,databaseOid:row.databaseOid,role:row.role,serverAddress:row.serverAddress,serverPort:row.serverPort}
 if(hash(actual)!==hash(expected))throw Error('paged_current_preparation_binding_drift')
 return {backend:row.backend,started:row.started,backendStarted:row.backend_started}
}
export async function verifyPagedCleanupCurrent(client:pg.Client,identity:string,config:PagedCleanupConfig,capability:PreparedPagedCleanupVerification):Promise<ReturnType<typeof receipt>>{
 // Object identity is checked before any caller config/client/token fields.
 if(!capability||typeof capability!=='object'||!preparedPagedCleanupVerifications.has(capability))throw Error('paged_current_preparation_required')
 const prepared=preparedPagedCleanupVerifications.get(capability)!
 if(identity!==prepared.header.identity||hash(config)!==prepared.configHash)throw Error('paged_current_preparation_binding_drift')
 const transaction=await currentPagedTransaction(client,prepared.config.database.expected)
 const checked=await checkPagedVerificationCurrent(client,identity,prepared.config,prepared.header,prepared.roots,prepared.fileStateRoot,true)
 if(!checked.verification.privacyCatchupReadyForReopen)throw Error('paged_current_cleanup_incomplete')
 if(pagedHash(checked.prefix)!==pagedHash(prepared.prefix))throw Error('paged_current_preparation_binding_drift')
 if(pagedHash(await currentPagedTransaction(client,prepared.config.database.expected))!==pagedHash(transaction))throw Error('paged_current_transaction_changed')
 return checked.verification
}
async function authenticatePagedVerificationFiles(config:PagedCleanupConfig,directory:string,options:PagedCleanupOptions={}){
 const {opened,roots}=await rootsFromManifest(directory),header=opened.header;normalizedPagedRoots(config,roots)
 let fileStateRoot=pagedFileStateSeed(header)
 for await(const page of readPagedCleanupParts(opened)){
  const witness=await pagedWindow(config,options,true,async(c,identity)=>{
   await checkWindow(c,identity,config,header,roots,false);await requirePagedSeal(c,header)
   return assertStoredPagedPart(c,header,page)
  })
  fileStateRoot=extendPagedFileState(fileStateRoot,witness)
 }
 return {header,roots,fileStateRoot}
}
async function checkPagedVerificationCurrent(c:pg.Client,identity:string,config:PagedCleanupConfig,header:PagedCleanupHeader,roots:readonly PagedRoot[],fileStateRoot:string,locked:boolean){
 const catalog=await checkWindow(c,identity,config,header,roots,locked);await requirePagedSeal(c,header,fileStateRoot)
 // Strict verification must acquire the complete Memory relation locks before
 // reading original accounting/native-output state. The public readonly path
 // retains its prior original-state then negative-edge check order.
 if(locked)await assertPagedEdges(c,catalog,header,roots,true)
 await assertPagedOriginalState(c,catalog,header)
 if(!locked)await assertPagedEdges(c,catalog,header,roots)
 const prefix=await pagedPrefix(c,header)
  let ready=prefix.completed===header.partCount
  if((await c.query(`SELECT 1 FROM memory.work_episodes e JOIN ${pagedRelation('items')} i ON i.table_name='work_episodes' AND i.original->'key'->>'episode_id'=e.episode_id::text WHERE i.plan_hash=$1 AND i.original->>'disposition'='invalidate' AND(e.state<>'invalidated' OR e.document<>'{}'::jsonb OR e.evidence_manifest<>'{}'::jsonb OR e.summary<>'{}'::jsonb) LIMIT 1`,[header.manifestHash])).rowCount)ready=false
  for(const root of roots){if((await c.query("SELECT 1 FROM memory.memory_generation_runs WHERE installation_id=$1 AND operation='compile_context' AND subject_kind='session' AND subject_key_hash=decode(md5($2),'hex') AND state IN('queued','running') LIMIT 1",[root.installationId,root.sessionId])).rowCount)ready=false
   if(!(await c.query('SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[root.installationId,root.sessionId])).rowCount)ready=false
   if((await c.query("SELECT 1 FROM memory.source_sessions WHERE installation_id=$1 AND session_id=$2 AND(deleted_at IS NULL OR agent_type IS NOT NULL OR daemon_id IS NOT NULL OR status IS NOT NULL OR cwd_observation IS NOT NULL OR worktree_path IS NOT NULL OR worktree_branch IS NOT NULL) LIMIT 1",[root.installationId,root.sessionId])).rowCount)ready=false
   if((await c.query("SELECT 1 FROM memory.work_episodes WHERE installation_id=$1 AND session_id=$2 AND(state<>'invalidated' OR document<>'{}'::jsonb OR evidence_manifest<>'{}'::jsonb OR summary<>'{}'::jsonb) LIMIT 1",[root.installationId,root.sessionId])).rowCount)ready=false
  }return {verification:receipt(header,prefix.completed,ready),prefix}
}

export async function verifyPagedCleanup(config:PagedCleanupConfig,directory:string,options:PagedCleanupOptions={}){
 const prepared=await authenticatePagedVerificationFiles(config,directory,options)
 // Keep the existing independent read-only windows and incomplete ready=false
 // semantics. Strict preparation is deliberately not on this public path.
 return pagedWindow(config,options,true,async(c,identity)=>(await checkPagedVerificationCurrent(c,identity,config,prepared.header,prepared.roots,prepared.fileStateRoot,false)).verification)
}
