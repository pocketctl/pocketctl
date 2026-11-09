import {lockPagedNativeAuthority,pagedNativeFenceFacts} from './paged-cleanup-native-fence.js'
import {cancelPagedQuery,capturePagedBackend,confirmPagedBackendGone} from './paged-cleanup-cancel.js'
import type pg from 'pg'
import type {ForwardCleanupConfig} from './forward-cleanup.js'
import {assertPrivacyTargetClosed,readPrivacyFacts,lockPrivacyMetadata,type OverlayOptions} from './privacy-overlay.js'
import {connectMaintenance,hash} from './source-maintenance-common.js'
import {probeSystemdDrain,validateDrainEvidence} from './source-fence.js'
import {pagedHash} from './paged-cleanup-manifest.js'
import {auditPagedMetadata} from './paged-cleanup-receipts.js'
import {inspectPagedCleanupCatalog,type PagedCatalog} from './paged-cleanup-catalog.js'
export interface PagedRoot {installationId:string;sessionId:string}
export interface PagedCleanupConfig extends ForwardCleanupConfig {reviewedCatalogHash:string}
export interface PagedCleanupOptions extends OverlayOptions {afterCommit?:(ordinal:string)=>Promise<void>}
export function normalizedPagedRoots(config:PagedCleanupConfig,roots:readonly PagedRoot[]):PagedRoot[]{
 if(!roots.length||roots.length>4096||!config.installationIds?.length||config.installationIds.length>16||new Set(config.installationIds).size!==config.installationIds.length)throw Error('paged_fixed_root_scope_required')
 const result=roots.map(r=>({...r})).sort((a,b)=>a.installationId.localeCompare(b.installationId)||a.sessionId.localeCompare(b.sessionId)),seen=new Set<string>()
 for(const root of result){if(!config.installationIds.includes(root.installationId)||!/^[0-9a-f-]{36}$/.test(root.installationId)||typeof root.sessionId!=='string'||!root.sessionId||root.sessionId.length>512)throw Error('paged_fixed_root_scope_required');const key=pagedHash(root);if(seen.has(key))throw Error('paged_duplicate_root');seen.add(key)}
 return result
}
export function pagedConfigHash(config:PagedCleanupConfig){
 if(!/^[a-f0-9]{64}$/.test(config.reviewedCatalogHash??''))throw Error('paged_reviewed_catalog_required')
 if(!config.tombstoneHmacKeys?.length||config.tombstoneHmacKeys.length>16||config.tombstoneHmacKeys.some(k=>!k.key||!k.version)||new Set(config.tombstoneHmacKeys.map(k=>k.version)).size!==config.tombstoneHmacKeys.length)throw Error('paged_tombstone_keyring_required')
 return pagedHash({database:config.database.expected,installationIds:[...config.installationIds].sort(),units:config.units,catalog:config.reviewedCatalogHash,keys:config.tombstoneHmacKeys.map(k=>({version:k.version,fingerprint:pagedHash(k.key)})),policy:'native-paged-privacy-v4'})
}
export async function pagedWindow<T>(config:PagedCleanupConfig,options:PagedCleanupOptions,readOnly:boolean,body:(c:pg.Client,identity:string)=>Promise<T>):Promise<T>{
 if(options.signal?.aborted)throw Error('maintenance_interrupted')
 const ms=options.transactionTimeoutMs??10000;if(!Number.isSafeInteger(ms)||ms<1||ms>10000)throw Error('invalid_maintenance_timeout')
 const evidence=await(options.probe??probeSystemdDrain)(config.units);validateDrainEvidence(config.units,evidence)
 const db=await connectMaintenance(config.database,readOnly)
 let backend:Awaited<ReturnType<typeof capturePagedBackend>>
 try{backend=await capturePagedBackend(db.client)}catch(error){await db.close();throw error}
 const deadline=Date.now()+ms;let cancellation:Promise<void>|undefined,cancellationError:unknown,aborted=false
 const cancel=()=>{aborted=true;cancellation??=cancelPagedQuery(db.client).catch(error=>{cancellationError=error}).finally(async()=>{await db.close().catch(()=>{});await confirmPagedBackendGone(config.database,backend).catch(error=>{cancellationError=error})})},timer=setTimeout(cancel,ms)
 options.signal?.addEventListener('abort',cancel,{once:true})
 const check=()=>{if(options.signal?.aborted){cancel();throw Error('maintenance_interrupted')}if(aborted||Date.now()>=deadline){cancel();throw Error('paged_transaction_window_expired')}}
 const originalQuery=db.client.query.bind(db.client)
 db.client.query=((...args:unknown[])=>{check();return Reflect.apply(originalQuery,db.client,args)}) as pg.Client['query']
 try{check();await db.client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await db.client.query('SET LOCAL jit=off');const result=await body(db.client,db.identity);check();await db.client.query(readOnly?'ROLLBACK':'COMMIT');return result}
 catch(error){if(!aborted&&!options.signal?.aborted&&Date.now()<deadline)await db.client.query('ROLLBACK').catch(()=>{});check();throw error}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);await cancellation;await db.close();if(cancellationError)throw cancellationError}

}
export async function pagedAuthority(c:pg.Client,config:PagedCleanupConfig,roots:readonly PagedRoot[],locked=false):Promise<{hash:string;catalog:PagedCatalog;sessions:{installationId:string;sessionId:string;reason:'user_deleted'|'access_revoked'}[]}>{
 if(locked){await lockPagedNativeAuthority(c,roots);await lockPrivacyMetadata(c)}
 await assertPrivacyTargetClosed(c);await auditPagedMetadata(c)
 const catalog=await inspectPagedCleanupCatalog(c);if(catalog.hash!==config.reviewedCatalogHash)throw Error('paged_catalog_drift')
 const local=(await c.query("SELECT installation_id::text,owner_scope_kind FROM memory.memory_owner_scopes WHERE installation_id=ANY($1::uuid[])",[config.installationIds])).rows
 if(local.length!==config.installationIds.length||local.some(r=>r.owner_scope_kind!=='personal'))throw Error('paged_owner_lifecycle_adapter_required')
 // Preserve explicit Team withdrawal ownership. V4's initial personal adapter
 // cannot infer that ordinary personal acceptance severs a global Team source.
 if((await c.query(`SELECT 1 FROM memory.knowledge_evidence e WHERE installation_id=ANY($1::uuid[]) AND jsonb_path_exists(e.locator,'strict $.** ? (@.source_kind == "team_session")') LIMIT 1`,[config.installationIds])).rowCount)throw Error('paged_team_retained_authority_adapter_required')
 if((await c.query(`SELECT 1 FROM memory.source_events s JOIN jsonb_to_recordset($1::jsonb) r("installationId" uuid,"sessionId" text) ON s.installation_id=r."installationId" AND s.session_id=r."sessionId" WHERE s.source_kind IN('legacy_archive','team_collaboration','team_delivery') LIMIT 1`,[JSON.stringify(roots)])).rowCount)throw Error('paged_original_source_adapter_required')
 const closure={roots:[...roots],deliveries:[],capsules:[],references:[],unresolved:[],fingerprint:hash(roots)}
 const facts=await readPrivacyFacts(c,config,closure)
 if(facts.installations.length||facts.scopeBarriers.length||facts.memberBarriers.length)throw Error('paged_owner_lifecycle_adapter_required')
 if(facts.sessions.length!==roots.length||roots.some(root=>!facts.sessions.some(s=>s.installationId===root.installationId&&s.sessionId===root.sessionId)))throw Error('paged_current_privacy_authority_required')
 const native=await pagedNativeFenceFacts(c,roots)
 return {hash:pagedHash({current:facts.currentFactsHash,local:facts.localFactsHash,roots,native}),catalog,sessions:facts.sessions}
}
