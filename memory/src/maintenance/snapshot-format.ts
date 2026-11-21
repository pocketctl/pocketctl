import pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {canonicalJsonString,parseMemorySourceProvenance} from '@pocketctl/session-source'
import {assertSnapshotReaderContract} from '../migrations/shared-db/namespace.js'
import {compactSnapshotShapeSql} from '../migrations/shared-db/snapshot-provenance-migration.js'
import {snapshotProvenanceSql} from '../sources/snapshot-provenance.js'

type Action = 'preview' | 'pack' | 'restore'
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** One resumable primary-key page. A conflict rolls back the entire page;
 * callers checkpoint its cursor only after COMMIT has been acknowledged. */
export async function snapshotFormatPage(client:pg.ClientBase, action:Action, installation:string, after:string|null) {
  if (!['preview','pack','restore'].includes(action) || !uuid.test(installation) || (after!==null && !uuid.test(after))) {
    throw Error('invalid_snapshot_format_page')
  }
  const restore=action==='restore'
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ '+(action==='preview'?'READ ONLY':'READ WRITE'))
  try {
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='5s'")
    if (action==='pack') await assertSnapshotReaderContract(client)
    const params=after?[installation,after]:[installation]
    const {rows}=await client.query(`WITH page AS MATERIALIZED (
      SELECT s.source_event_id,s.snapshot_format,s.xmin AS revision,${restore?'NULL::jsonb AS proof,0 AS bytes':`
        CASE WHEN s.snapshot_format=0 AND (${compactSnapshotShapeSql('s.')})
         AND s.source_provenance->'memory'=s.classification->'memory_source'
         AND pg_column_size(s.source_provenance)<=32768 THEN s.source_provenance->'memory' END AS proof,
        CASE WHEN jsonb_typeof(s.source_provenance)='object' THEN
         pg_column_size(s.source_provenance)-pg_column_size(s.source_provenance-'memory') END AS bytes`},
        s.canonical_key,s.session_id,s.turn_id,s.content_hash
      FROM memory.source_events s WHERE s.installation_id=$1 ${after?'AND s.source_event_id>$2::uuid':''}
      ORDER BY s.source_event_id LIMIT 64)
      SELECT p.source_event_id AS id,p.snapshot_format,p.revision::text,p.bytes,
       ${restore?'NULL::jsonb':`CASE WHEN p.proof IS NOT NULL AND EXISTS(
        SELECT 1 FROM public.extension_installations i JOIN public.events e ON
         e.id=CASE WHEN p.canonical_key ~ '^[1-9][0-9]{0,18}$'
          THEN CASE WHEN p.canonical_key::numeric<=9223372036854775807 THEN p.canonical_key::bigint END END
         AND e.user_id=i.owner_user_id AND NOT e.owner_retired
        WHERE i.installation_id=$1 AND i.owner_scope_kind='personal' AND i.provider_id='pocketctl-memory' AND i.status='active'
          AND e.effect_status IN ('none','completed') AND e.logical_source_session_id=p.session_id
          AND e.source_header_version=1 AND e.source_classification->'memory_source'=p.proof
          AND e.canonical_payload_hash=encode(p.content_hash,'hex')
          AND NOT EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts r
            WHERE r.installation_id=i.installation_id AND r.turn_id=p.turn_id)
       ) THEN p.proof END`} AS proof
      FROM page p ORDER BY p.source_event_id`,params)
    const eligible=rows.filter(row=>{
      if (restore) return row.snapshot_format===1
      const parsed=parseMemorySourceProvenance(row.proof)
      return parsed!==null && canonicalJsonString(parsed)===canonicalJsonString(row.proof)
    })
    let changed=0
    if (action!=='preview' && eligible.length) {
      const target=restore?0:1
      const result=await client.query(`WITH prior AS MATERIALIZED (
        SELECT s.source_event_id,${snapshotProvenanceSql('s')} AS proof
        FROM memory.source_events s JOIN jsonb_to_recordset($2::jsonb) k(id uuid,revision text)
         ON s.source_event_id=k.id AND s.xmin::text=k.revision
        WHERE s.installation_id=$1 AND s.snapshot_format<>$3 ORDER BY s.source_event_id FOR UPDATE OF s NOWAIT)
        UPDATE memory.source_events s SET snapshot_format=$3 FROM prior
        WHERE s.source_event_id=prior.source_event_id
        RETURNING s.snapshot_format=$3 AND ${snapshotProvenanceSql('s')}=prior.proof AS equivalent`,
        [installation,JSON.stringify(eligible.map(({id,revision})=>({id,revision}))),target])
      if (result.rowCount!==eligible.length || result.rows.some(r=>r.equivalent!==true)) throw Error('snapshot_page_changed')
      changed=result.rowCount
    }
    await client.query('COMMIT')
    return {scanned:rows.length,eligible:eligible.length,skipped:rows.length-eligible.length,changed,
      candidateBytes:restore?0:eligible.reduce((sum,row)=>sum+Number(row.bytes),0),
      through:rows.at(-1)?.id??after,done:rows.length<64}
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

async function main() {
  const [action,database,installation,after,...rest]=process.argv.slice(2)
  const url=process.env.MEMORY_MIGRATION_DATABASE_URL
  if (!url || !database || !installation || rest.length || !['preview','pack','restore'].includes(action)) {
    throw Error('usage: snapshot-format preview|pack|restore EXPECTED_DATABASE INSTALLATION_UUID [AFTER_UUID]')
  }
  const client=new pg.Client({connectionString:url,application_name:'memory-snapshot-format'})
  await client.connect()
  try {
    if ((await client.query('SELECT current_database() AS name')).rows[0].name!==database) throw Error('database_identity_mismatch')
    console.log(JSON.stringify(await snapshotFormatPage(client,action as Action,installation,after??null)))
  } finally {await client.end()}
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{console.error(error instanceof Error?error.message:'snapshot_format_failed');process.exitCode=1})
}
