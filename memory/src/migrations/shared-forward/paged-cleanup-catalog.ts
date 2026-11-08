import {assertNativeTeamSemanticCompatible} from '../shared-db/input-start-contract.js'
import type pg from 'pg'
import {inventoryDatabase} from '../shared-source/inventory.js'
import type {Snapshot} from '../shared-source/database.js'
import {TABLE_POLICY} from '../shared-source/table-policy.js'
import {JSON_COLUMN_POLICY} from '../shared-source/json-reference-policy.js'
import {pagedTables} from './paged-cleanup-receipts.js'
import {pagedHash,PAGED_CLEANUP_MAX_BYTES} from './paged-cleanup-manifest.js'
export const PAGED_METADATA_PREFIX='memory_forward_cleanup_v4_'
export interface PagedTable {table:string;pk:string[];columns:string[];references:string[]}
export interface PagedEdge {child:string;parent:string;childColumns:string[];parentColumns:string[]}
export interface PagedCatalog {hash:string;tables:PagedTable[];edges:PagedEdge[]}
/** Produces a candidate catalog fingerprint, not approval. Production config
 * must supply its independently reviewed expected hash. All native functions,
 * triggers, ACLs, indexes, defaults, roles and FK definitions are included. */
export async function inspectPagedCleanupCatalog(c:pg.Client):Promise<PagedCatalog>{
 if((await c.query("SELECT current_setting('search_path') AS path")).rows[0].path!=='pg_catalog')throw Error('paged_catalog_search_path_required')
 // An exact finite NOT VALID native header is allowed only after the full
 // independent native marker/shape/trigger/owner/ACL gate. It remains in the
 // inventory/fingerprint; no native object receives a prefix exclusion.
 await assertNativeTeamSemanticCompatible(c as unknown as Pick<pg.Pool,'query'>)
 const nativeHeader=(await c.query("SELECT contype,convalidated,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid=to_regclass('public.collaboration_events') AND conname='native_team_content_eligibility_pair'")).rows
 const approvedNativeHeader=nativeHeader.length===1&&nativeHeader[0].contype==='c'&&nativeHeader[0].convalidated===false
  &&nativeHeader[0].definition==='CHECK (native_team_content_eligibility_version IS NULL AND native_team_content_eligible IS NULL OR native_team_content_eligibility_version IS NOT NULL AND native_team_content_eligibility_version = 1 AND native_team_content_eligible IS NOT NULL) NOT VALID'
 const inventory=await inventoryDatabase({client:c} as unknown as Snapshot,'memory',{})
 const metadataNames=Object.values(pagedTables) as string[]
 const excluded=(o:typeof inventory.objects[number])=>o.schema==='shared'&&(
  ['table','permission'].includes(o.kind)&&metadataNames.includes(o.name)
  ||o.kind==='index'&&metadataNames.some(name=>o.name===name+'_pkey')
  ||o.kind==='constraint'&&metadataNames.some(name=>o.parent===name&&o.name===name+'.'+name+'_pkey')
  ||o.kind==='json-column'&&['plans.header','pages.page','items.original','receipts.outputs'].some(pair=>{const [table,column]=pair.split('.');return o.name===pagedTables[table as keyof typeof pagedTables]+'.'+column}))
 const objects=inventory.objects.filter(o=>o.kind!=='sequence-state'&&!excluded(o))
 if(objects.length>20000||Buffer.byteLength(JSON.stringify(objects))>PAGED_CLEANUP_MAX_BYTES)throw Error('paged_catalog_capacity')
 const legacyConstraint=(await c.query("SELECT contype,convalidated,pg_get_constraintdef(oid,true) AS definition FROM pg_constraint WHERE conrelid='memory.source_events'::regclass AND conname='source_events_verified_legacy_archive'")).rows
 const nativeLegacyDefinition=`CHECK (mapping_state <> 'verified'::text OR source_kind <> 'legacy_archive'::text OR legacy_owner_user_id IS NOT NULL AND legacy_manifest_hash IS NOT NULL AND canonical_key = source_event_id::text AND session_id IS NOT NULL AND "left"(session_id, 5) <> 'team_'::text AND canonical_session_key = session_id AND (origin = ANY (ARRAY['feed'::text, 'snapshot'::text])) AND adapter_version = 'legacy-archive-v1'::text AND NOT source_provenance ? 'team'::text AND NOT source_provenance ? 'accepted_delivery'::text) NOT VALID`
 if(legacyConstraint.length!==1||legacyConstraint[0].contype!=='c'||legacyConstraint[0].convalidated!==false||legacyConstraint[0].definition!==nativeLegacyDefinition)throw Error('paged_native_legacy_constraint_drift')
 if(objects.some(o=>o.ready===false||o.valid===false&&!(o.kind==='constraint'&&o.schema==='memory'&&o.name==='source_events.source_events_verified_legacy_archive'||approvedNativeHeader&&o.kind==='constraint'&&o.schema==='public'&&o.name==='collaboration_events.native_team_content_eligibility_pair')))throw Error('paged_catalog_invalid_object')
 for(const object of objects){
  if(object.schema==='memory'&&object.kind==='table'&&!Object.hasOwn(TABLE_POLICY,object.name))throw Error('paged_catalog_unreviewed_table')
  if(object.schema==='memory'&&object.kind==='json-column'&&!Object.hasOwn(JSON_COLUMN_POLICY,object.name))throw Error('paged_catalog_unreviewed_json')
 }
 const tables=(await c.query(`SELECT t.relname AS table,
 ARRAY(SELECT a.attname::text FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.num WHERE p.conrelid=t.oid AND p.contype='p' ORDER BY k.n) AS pk,
 ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
 ARRAY(SELECT DISTINCT a.attname::text FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped AND(a.attname ~ '_id$' OR a.attname IN('canonical_session_key','idempotency_key','logical_key','identity_hmac','generation','sequence','revision','ordinal','version')) ORDER BY a.attname::text) AS references
 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='memory' AND t.relkind IN('r','p') ORDER BY t.relname`)).rows as PagedTable[]
 if(!tables.length||tables.length>256||tables.some(t=>!t.pk.length))throw Error('paged_catalog_primary_key_required')
 const edges=(await c.query(`SELECT ch.relname AS child,p.relname AS parent,
 ARRAY(SELECT a.attname::text FROM unnest(f.conkey)WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=ch.oid AND a.attnum=k.num ORDER BY k.n) AS "childColumns",
 ARRAY(SELECT a.attname::text FROM unnest(f.confkey)WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.n) AS "parentColumns"
 FROM pg_constraint f JOIN pg_class ch ON ch.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace JOIN pg_namespace cn ON cn.oid=ch.relnamespace
 WHERE f.contype='f' AND pn.nspname='memory' AND cn.nspname='memory' ORDER BY ch.relname,f.conname`)).rows as PagedEdge[]
 if((await c.query("SELECT 1 FROM pg_constraint f JOIN pg_class p ON p.oid=f.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace JOIN pg_class ch ON ch.oid=f.conrelid JOIN pg_namespace cn ON cn.oid=ch.relnamespace WHERE f.contype='f' AND pn.nspname='memory' AND cn.nspname<>'memory' LIMIT 1")).rowCount)throw Error('paged_catalog_external_child')
 // Exclude allocation/estimates and sequence value changes, never definitions.
 return {hash:pagedHash(objects.map(o=>[o.key,o.definitionHash])),tables,edges}
}
