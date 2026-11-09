import {DELIVERY_FACT_COLUMNS,SNAPSHOT_FACT_COLUMNS,DELIVERY_FACT_TYPES,DELIVERY_FACT_REQUIRED,SNAPSHOT_FACT_TYPES,SNAPSHOT_FACT_REQUIRED} from './transport-metadata-migration.js'
import type pg from 'pg'
import {sourcePoolContext} from './pool-context.js'
/** Only an administrator-written shared contract retires legacy input. Missing
 * contract rows are errors, never an implicit successful empty source. */
export async function legacyTransportRetired(db:Pick<pg.Pool,'query'>,sharedMaintenance=false):Promise<boolean>{
 if(!sharedMaintenance&&sourcePoolContext(db).namespace!=='memory')return false
 const rows=(await db.query("SELECT COALESCE((to_jsonb(c)->>'legacy_transport_retired')::boolean,FALSE) AS retired FROM shared.memory_source_contract c")).rows
 if(rows.length!==1||typeof rows[0].retired!=='boolean')throw Error('legacy_transport_contract_unavailable')
 return rows[0].retired
}

/** Startup pins exact unfiltered projections; an empty replacement view must
 * never hide an oversized gap. Missing raw tables require the explicit admin
 * retirement marker and real metadata tables with stable primary keys. */
export async function assertTransportMetadataContract(db:Pick<pg.Pool,'query'>):Promise<void>{
 const retired=await legacyTransportRetired(db,true),invalid=()=>Error('legacy_transport_metadata_contract_invalid')
 const raw=['memory_feed_inbox','memory_snapshot_events','memory_snapshot_runs','memory_inbox_checkpoints']
 const presence=(await db.query("SELECT name,to_regclass('memory.'||name)::text AS relation FROM unnest($1::text[]) name",[raw])).rows
 if(presence.some(r=>retired?r.relation!==null:r.relation===null))throw invalid()
 for(const [view,original,receipt,columns,keys,types,required] of [
  ['memory_source_delivery_facts','memory_feed_inbox','memory_source_delivery_receipts',DELIVERY_FACT_COLUMNS,['installation_id','feed_id'],DELIVERY_FACT_TYPES,DELIVERY_FACT_REQUIRED],
  ['memory_source_snapshot_facts','memory_snapshot_runs','memory_source_snapshot_receipts',SNAPSHOT_FACT_COLUMNS,['run_id'],SNAPSHOT_FACT_TYPES,SNAPSHOT_FACT_REQUIRED],
 ] as const){
  const base=retired?receipt:original
  const row=(await db.query(`SELECT v.relkind,pg_get_viewdef(v.oid,TRUE) AS definition,b.relkind AS base_kind,b.relrowsecurity,b.relforcerowsecurity,b.relpersistence,
   EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhparent=b.oid OR i.inhrelid=b.oid) AS inherits,
   ARRAY(SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a WHERE a.attrelid=v.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS types,
   ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=b.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND a.attname=ANY($3::text[]) ORDER BY a.attnum) AS required,
   ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=v.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns,
   ARRAY(SELECT a.attname::text FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY key(num,n)
    JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=key.num WHERE k.conrelid=b.oid AND k.contype='p' ORDER BY key.n) AS primary_key
   FROM pg_class v JOIN pg_class b ON b.oid=to_regclass($2) WHERE v.oid=to_regclass($1) AND v.relkind='v'`,['memory.'+view,'memory.'+base,columns.split(',')])).rows[0]
  const expected='select'+columns+'from'+base+';'
  if(!row||row.relkind!=='v'||row.base_kind!=='r'||row.relpersistence!=='p'||row.relrowsecurity||row.relforcerowsecurity||row.inherits
   ||row.columns.join(',')!==columns||JSON.stringify(row.types)!==JSON.stringify(types)||JSON.stringify(row.required)!==JSON.stringify(required)
   ||row.definition.replace(/\bmemory\./g,'').replaceAll(base+'.','').replace(/\s+/g,'').toLowerCase()!==expected
   ||retired&&JSON.stringify(row.primary_key)!==JSON.stringify(keys))throw invalid()
  if(retired){
   const actual=(await db.query("SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum",['memory.'+base])).rows.map(r=>r.attname)
   if(actual.join(',')!==columns)throw invalid()
  }
 }
}
