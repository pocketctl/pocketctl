import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Client } from 'pg'
import { RETAINED_NATIVE_SOURCE_PROFILE_JSON, RETAINED_NATIVE_SOURCE_PROFILE_SHA256 } from './retained-authority-native-profile.js'

/** Success is structural validation of the finite isolated slice only. */
export interface RetainedCatalogIdentity {
  database: string; databaseOid: string; role: string; roleOid: string
  serverAddress: string; serverPort: string; serverVersionNum: '130023' | '170010'
}
export interface RetainedCatalogCurrentIdentity extends RetainedCatalogIdentity {
  configSha256: string
  sourceProfileSha256: string
  reviewSha256: string
  enclosingRegistrySha256: string
}
export interface RetainedCatalogPreparation {
  identity: RetainedCatalogIdentity
  configSha256: string; sourceProfileSha256: string; reviewSha256: string
  enclosingRegistry: { scope: 'isolated-three-object-prototype'; sourceSha256: string }
  tablespace: { name: string; oid: string; ownerOid: string }
}
declare const preparedBrand: unique symbol
export interface PreparedRetainedCatalog { readonly [preparedBrand]: never }
type Json = null | boolean | string | number | Json[] | { [key: string]: Json }
type Row = { [key: string]: Json }
type Rows = Record<string, Row[]>
interface Column { name: string; sqlType: string; nullable: boolean; collation: string; statisticsTarget: number }
interface Table { schema: string; name: string; columns: Column[]; checks: { name: string; referencedColumns: string[] }[] }
interface Index { name: string; table: string; keys: string[]; primary: boolean; unique: boolean; constraintName: string | null; opclasses: string[]; collations: (string | null)[] }
interface ForeignKey { name: string; child: string; parent: string; columns: string[]; referencedColumns: string[]; referencedIndex: string }
interface Profile {
  major: string
  intrinsicAttributeTypes: Record<string, { length: string; byval: boolean; alignment: string; storage: string }>
  checkReferences: { functions: Record<string,Record<string,string>>; operators: Record<string,Record<string,string>>; boundary: string }
  nativeInternalLanguageOid: string
  nativeBootstrapOwnerOid: string
  native: {
    functions: Record<string, Record<string, string>>
    classes: Record<string, { inputType: string; family: string; source: Record<string, string> }>
    operators: { class: string; strategy: string; operator: string; type: string; function: string; source: Record<string, string> }[]
    supportFunctions: { class: string; slot: string; function: string; source: Record<string, string> }[]
  }
  operators: Record<string, Record<string, string>>
  definitions: { constraints: Record<string, string>; indexes: Record<string, string> }
}
interface Source {
  format: string; inputs: Record<string, string>
  descriptor: { tables: Table[]; indexes: Index[]; foreignKeys: ForeignKey[] }
  profiles: Record<string, Profile>
}
interface Binding { config: RetainedCatalogPreparation; profile: Profile; client?: Client; backendPid?: number; transactionStart?: string; auditStarted?: number }
const bindings = new WeakMap<PreparedRetainedCatalog, Binding>()
const SHA = /^[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_ROWS = 1024
const MAX_WIRE_BYTES = 8 * 1024 * 1024
function refuse(reason: string): never { throw new Error('retained_catalog_' + reason) }
function requireThat(value: unknown, reason: string): asserts value { if (!value) refuse(reason) }
function object(value: Json | undefined, reason = 'object'): Row {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), reason)
  return value
}
function list(value: Json | undefined, reason = 'array'): Json[] { requireThat(Array.isArray(value), reason); return value }
function str(value: Json | undefined, reason = 'string'): string { requireThat(typeof value === 'string', reason); return value }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
function equal(actual: unknown, expected: unknown, reason: string): void { requireThat(canonical(actual) === canonical(expected), reason) }
function fields(actual: Row, expected: Row, reason: string): void { for (const [key, value] of Object.entries(expected)) equal(actual[key], value, reason + '/' + key) }
function exactKeys(actual: Row, keys: string[], reason: string): void { equal(Object.keys(actual).sort(), [...keys].sort(), reason + '/fields') }
function one(rows: Row[], where: Row, reason: string): Row {
  const found = rows.filter(r => Object.entries(where).every(([key, value]) => canonical(r[key]) === canonical(value)))
  requireThat(found.length === 1, reason + '/cardinality'); return found[0]!
}
function sorted(values: unknown[]): string[] { return values.map(canonical).sort() }
function roster(rows: Row[], expected: unknown[], select: (r: Row) => unknown, reason: string): void { equal(sorted(rows.map(select)), sorted(expected), reason + '/roster') }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Cold preparation: no target queries, file I/O, connections, or serialized authority. */
export function prepareRetainedCatalog(config: RetainedCatalogPreparation): PreparedRetainedCatalog {
  requireThat(config && config.sourceProfileSha256 === RETAINED_NATIVE_SOURCE_PROFILE_SHA256 && sha(RETAINED_NATIVE_SOURCE_PROFILE_JSON) === RETAINED_NATIVE_SOURCE_PROFILE_SHA256, 'source_profile')
  requireThat(SHA.test(config.configSha256) && SHA.test(config.reviewSha256) && SHA.test(config.enclosingRegistry?.sourceSha256), 'review_binding')
  requireThat(config.enclosingRegistry.scope === 'isolated-three-object-prototype', 'enclosing_registry_unsupported')
  const source = JSON.parse(RETAINED_NATIVE_SOURCE_PROFILE_JSON) as Source
  requireThat(source.format === 'pocketctl-retained-native-source-profile/v1', 'source_profile_version')
  const profile = source.profiles[config.identity.serverVersionNum]
  requireThat(profile && Object.keys(profile.native.functions).length === (profile.major === '13' ? 71 : 72), 'source_profile_finite_roster')
  requireThat(Object.values(config.identity).every(v => typeof v === 'string' && v.length > 0 && v.length < 256), 'identity_binding')
  requireThat(DECIMAL.test(config.identity.databaseOid) && DECIMAL.test(config.identity.roleOid) && DECIMAL.test(config.identity.serverPort), 'identity_binding')
  requireThat(config.tablespace.name.length > 0 && DECIMAL.test(config.tablespace.oid) && DECIMAL.test(config.tablespace.ownerOid), 'tablespace_binding')
  exactKeys(config as unknown as Row, ['identity','configSha256','sourceProfileSha256','reviewSha256','enclosingRegistry','tablespace'], 'preparation')
  exactKeys(config.identity as unknown as Row, ['database','databaseOid','role','roleOid','serverAddress','serverPort','serverVersionNum'], 'identity_binding')
  exactKeys(config.enclosingRegistry as unknown as Row, ['scope','sourceSha256'], 'enclosing_registry')
  exactKeys(config.tablespace as unknown as Row, ['name','oid','ownerOid'], 'tablespace_binding')
  const opaque = Object.freeze({}) as PreparedRetainedCatalog
  bindings.set(opaque, { config: structuredClone(config), profile })
  return opaque
}

/**
 * The supplied physical client must already own an active bounded READ COMMITTED RW
 * transaction. This function never BEGINs, connects, ends, or commits it. Caller
 * holds global fences before derived locks, invokes this again after locks, and
 * enforces a transport-level total 10s deadline through COMMIT (including abort).
 * The third argument binds the caller's CURRENT config/source/review/registry
 * hashes, so a prepared profile cannot silently survive configuration changes.
 * This component cannot approve an application enclosing registry or global state.
 */
export async function assertRetainedCatalogCurrent(client: Client, prepared: PreparedRetainedCatalog, expectedIdentity: RetainedCatalogCurrentIdentity): Promise<void> {
  const binding = bindings.get(prepared)
  requireThat(binding, 'prepared_profile')
  const { configSha256, sourceProfileSha256, reviewSha256, enclosingRegistrySha256, ...physicalIdentity } = expectedIdentity
  equal(physicalIdentity, binding.config.identity, 'identity_binding')
  equal({ configSha256, sourceProfileSha256, reviewSha256, enclosingRegistrySha256 }, { configSha256: binding.config.configSha256, sourceProfileSha256: binding.config.sourceProfileSha256, reviewSha256: binding.config.reviewSha256, enclosingRegistrySha256: binding.config.enclosingRegistry.sourceSha256 }, 'current_configuration_binding')
  requireThat(client && typeof client.query === 'function' && typeof client.getTransactionStatus === 'function' && client.getTransactionStatus() === 'T', 'active_transaction')
  requireThat(!binding.client || binding.client === client, 'physical_client_binding')
  binding.client = client
  const started = performance.now()
  if (binding.auditStarted === undefined) binding.auditStarted = started
  requireThat(started - binding.auditStarted < 10000, 'physical_deadline')
  // This fixed one-row/one-boolean result cannot transfer unbounded setting
  // text. Qualify the function, operator and type before trusting search_path;
  // the JSON guard/catalog queries are used only after this native preflight.
  const preflight = await client.query("SELECT pg_catalog.current_setting('search_path'::pg_catalog.text) OPERATOR(pg_catalog.=) 'pg_catalog'::pg_catalog.text AS safe_path")
  requireThat(preflight.rows.length === 1 && preflight.rows[0]?.safe_path === true && Object.keys(preflight.rows[0]).length === 1 && client.getTransactionStatus() === 'T', 'safe_search_path')
  const identity = await currentIdentity(client, binding)
  const queries = catalogQueries(binding.profile)
  const rows: Rows = {}
  for (const [name, query] of Object.entries(queries)) rows[name] = await boundedRows(client, query, binding)
  validateCatalog(rows, binding, identity)
  await currentIdentity(client, binding)
}

async function currentIdentity(client: Client, binding: Binding): Promise<Row> {
  requireThat(client.getTransactionStatus() === 'T', 'active_transaction')
  const rows = await boundedRows(client, `SELECT current_database() AS database, d.oid::text AS database_oid, current_user AS role, session_user AS session_role, r.oid::text AS role_oid, r.rolsuper, host(inet_server_addr()) AS server_address, inet_server_port()::text AS server_port, pg_backend_pid()::text AS backend_pid, current_setting('server_version_num') AS server_version_num, current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, current_setting('search_path') AS search_path, current_setting('row_security') AS row_security, current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout, current_setting('idle_in_transaction_session_timeout') AS idle_timeout, current_setting('TimeZone') AS timezone, current_setting('jit') AS jit, a.xact_start::text AS transaction_start, (a.xact_start<a.query_start) AS explicit_transaction FROM pg_database d JOIN pg_roles r ON r.rolname=current_user JOIN pg_stat_activity a ON a.pid=pg_backend_pid() WHERE d.datname=current_database()`, binding)
  requireThat(rows.length === 1, 'current_identity_cardinality')
  const r = rows[0]!, e = binding.config.identity
  fields(r, { database: e.database, database_oid: e.databaseOid, role: e.role, session_role: e.role, role_oid: e.roleOid, rolsuper: true, server_address: e.serverAddress, server_port: e.serverPort, server_version_num: e.serverVersionNum, isolation: 'read committed', read_only: 'off', search_path: 'pg_catalog', row_security: 'off', timezone: 'UTC', jit: 'off', explicit_transaction: true }, 'current_identity')
  for (const [key, cap] of [['statement_timeout', 5000], ['lock_timeout', 1000], ['idle_timeout', 10000]] as const) {
    const text = str(r[key]); const match = /^(\d+)(ms|s|min)?$/.exec(text)
    requireThat(match, 'bounded_setting/' + key)
    const ms = Number(match[1]) * (match[2] === 'min' ? 60000 : match[2] === 's' ? 1000 : 1)
    requireThat(Number.isSafeInteger(ms) && ms > 0 && ms <= cap, 'bounded_setting/' + key)
  }
  const backend = Number(r.backend_pid)
  requireThat(Number.isSafeInteger(backend) && backend > 0 && (!binding.backendPid || binding.backendPid === backend), 'backend_binding')
  requireThat((client as Client & { processID?: number }).processID === backend, 'physical_backend_binding')
  binding.backendPid = backend
  if (binding.transactionStart) equal(r.transaction_start, binding.transactionStart, 'transaction_binding')
  else binding.transactionStart = str(r.transaction_start)
  return r
}

// Count and byte guards execute before payload exposure. The exact UTF-8 JSON
// envelope, including row count, separators and brackets, is what is measured.
async function boundedRows(client: Client, query: string, binding: Binding): Promise<Row[]> {
  requireThat(performance.now() - binding.auditStarted! < 10000, 'physical_deadline')
  const result = await client.query(`WITH candidates AS MATERIALIZED (SELECT to_jsonb(candidate) AS value FROM (${query}) AS candidate LIMIT 1025), encoded AS MATERIALIZED (SELECT count(*) AS n, '{"rowCount":"' || count(*)::text || '","rows":[' || COALESCE(string_agg(value::text, ','), '') || ']}' AS wire FROM candidates), measured AS MATERIALIZED (SELECT n, octet_length(wire) AS bytes, wire FROM encoded) SELECT n::text AS row_count, bytes::text AS wire_bytes, CASE WHEN n <= 1024 AND bytes <= 8388608 THEN wire ELSE NULL END AS wire FROM measured`)
  requireThat(performance.now() - binding.auditStarted! < 10000 && client.getTransactionStatus() === 'T', 'physical_deadline_or_transaction')
  requireThat(result.rows.length === 1, 'wire_frame')
  const frame = result.rows[0] as { row_count?: unknown; wire_bytes?: unknown; wire?: unknown }
  requireThat(typeof frame.row_count === 'string' && DECIMAL.test(frame.row_count) && typeof frame.wire_bytes === 'string' && DECIMAL.test(frame.wire_bytes), 'wire_counts')
  requireThat(BigInt(frame.row_count) <= BigInt(MAX_ROWS) && BigInt(frame.wire_bytes) <= BigInt(MAX_WIRE_BYTES), 'wire_overflow')
  requireThat(typeof frame.wire === 'string' && Buffer.byteLength(frame.wire) === Number(frame.wire_bytes), 'wire_bytes')
  // All catalog numeric values here are native OIDs/metadata, never payload
  // numerics. Keep decimal strings so NULL/absence and integer fields stay exact.
  const parsed = JSON.parse(frame.wire, (_key, value: unknown) => typeof value === 'number' ? String(value) : value) as { rowCount?: unknown; rows?: unknown }
  requireThat(parsed.rowCount === frame.row_count && Array.isArray(parsed.rows) && parsed.rows.length === Number(frame.row_count), 'wire_roster')
  return parsed.rows.map(value => object(value as Json, 'wire_row'))
}

// Finite catalog SELECTs adapted from the source-bound reviewed isolated SQL capture.
const BASE_QUERIES: Readonly<Record<string, string>> = {
  "tables": "SELECT c.oid::text AS relation_oid,c.relname,c.relkind,c.relpersistence,c.relowner::text AS owner_oid,c.relreplident,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,c.relacl,c.reltoastrelid::text AS toast_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' ORDER BY c.relname",
  "columns": "SELECT c.relname,a.attnum::text,a.attname,format_type(a.atttypid,a.atttypmod) AS type_name,a.atttypid::text AS type_oid,a.atttypmod::text,a.attnotnull,a.attgenerated,a.attidentity,a.atthasdef,a.attisdropped,a.attstattarget::text,a.attcollation::text,a.attacl,a.attoptions,pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='shared' AND c.relkind='r' AND a.attnum>0 ORDER BY c.relname,a.attnum",
  "constraints": "SELECT c.relname,x.oid::text AS constraint_oid,x.conname,x.contype,x.convalidated,x.condeferrable,x.condeferred,x.conislocal,x.coninhcount::text,x.connoinherit,x.conrelid::text,x.confrelid::text,x.conindid::text,x.conkey::text,x.confkey::text,x.conpfeqop::text,x.conppeqop::text,x.conffeqop::text,x.confupdtype,x.confdeltype,x.confmatchtype,pg_get_constraintdef(x.oid) AS definition FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' ORDER BY c.relname,x.conname",
  "indexes": "SELECT c.relname,i.indexrelid::text,i.indrelid::text,i.indnatts::text,i.indnkeyatts::text,i.indisunique,i.indisprimary,i.indimmediate,i.indisvalid,i.indisready,i.indislive,i.indkey::text,i.indcollation::text,i.indclass::text,i.indoption::text,pg_get_expr(i.indexprs,i.indrelid) AS expressions,pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' ORDER BY c.relname",
  "toast": "SELECT p.relname AS parent_name,t.oid::text AS toast_oid,t.relname,t.relkind,t.relowner::text,t.reloptions,i.oid::text AS index_oid,i.relname AS index_name,pg_get_indexdef(i.oid) AS index_definition FROM pg_class p JOIN pg_namespace n ON n.oid=p.relnamespace JOIN pg_class t ON t.oid=p.reltoastrelid JOIN pg_index x ON x.indrelid=t.oid JOIN pg_class i ON i.oid=x.indexrelid WHERE n.nspname='shared' ORDER BY p.relname",
  "indexKeys": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT ns.nspname AS index_schema,ic.relname AS index_name,ic.oid::text AS index_oid,pc.oid::text AS heap_oid,pc.relname AS heap_name,pn.nspname AS heap_schema,k.ord::text AS key_ordinal,a.attnum::text AS attribute_number,a.attname AS attribute_name,atn.nspname AS attribute_type_schema,at.typname AS attribute_type_name,a.atttypid::text AS attribute_type_oid,a.atttypmod::text AS attribute_typmod,o.oid::text AS opclass_oid,onsp.nspname AS opclass_schema,o.opcname AS opclass_name,o.opcdefault,o.opcowner::text AS opclass_owner_oid,o.opckeytype::text AS opclass_key_type_oid,itn.nspname AS opclass_input_type_schema,it.typname AS opclass_input_type_name,o.opcintype::text AS opclass_input_type_oid,f.oid::text AS opfamily_oid,fn.nspname AS opfamily_schema,f.opfname AS opfamily_name,f.opfowner::text AS opfamily_owner_oid,am.amname AS access_method,am.oid::text AS access_method_oid,am.amtype,am.amhandler::regprocedure::text AS access_method_handler,ix.indcollation[(k.ord-1)::int]::text AS collation_oid,cn.nspname AS collation_schema,co.collname AS collation_name,ix.indoption[(k.ord-1)::int]::text AS key_options FROM ix JOIN pg_class ic ON ic.oid=ix.indexrelid JOIN pg_namespace ns ON ns.oid=ic.relnamespace JOIN pg_class pc ON pc.oid=ix.indrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace CROSS JOIN LATERAL unnest(ix.indclass::oid[]) WITH ORDINALITY k(opc_oid,ord) JOIN pg_opclass o ON o.oid=k.opc_oid JOIN pg_namespace onsp ON onsp.oid=o.opcnamespace JOIN pg_opfamily f ON f.oid=o.opcfamily JOIN pg_namespace fn ON fn.oid=f.opfnamespace JOIN pg_am am ON am.oid=o.opcmethod JOIN pg_type it ON it.oid=o.opcintype JOIN pg_namespace itn ON itn.oid=it.typnamespace JOIN pg_attribute a ON a.attrelid=pc.oid AND a.attnum=ix.indkey[(k.ord-1)::int] JOIN pg_type at ON at.oid=a.atttypid JOIN pg_namespace atn ON atn.oid=at.typnamespace LEFT JOIN pg_collation co ON co.oid=ix.indcollation[(k.ord-1)::int] LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace ORDER BY ns.nspname,ic.relname,k.ord",
  "collations": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT n.nspname AS collation_schema,c.collname AS collation_name,c.oid::text AS collation_oid,to_jsonb(c) AS native_fields FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE c.oid IN(SELECT unnest(indcollation::oid[]) FROM ix UNION SELECT a.attcollation FROM pg_attribute a WHERE a.attrelid IN(SELECT oid FROM heaps) AND a.attnum>0) ORDER BY n.nspname,c.collname",
  "familyOperators": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT o.opcname AS opclass_name,f.oid::text AS family_oid,fn.nspname AS family_schema,f.opfname AS family_name,m.amopstrategy::text AS strategy,m.amoppurpose,m.amopmethod::text AS method_oid,m.amopsortfamily::text AS sort_family_oid,m.amoplefttype::text AS left_type_oid,ln.nspname AS left_type_schema,lt.typname AS left_type_name,m.amoprighttype::text AS right_type_oid,rn.nspname AS right_type_schema,rt.typname AS right_type_name,p.oid::text AS operator_oid,pn.nspname AS operator_schema,p.oprname AS operator_name,p.oprresult::text AS result_type_oid,p.oprcode::oid::text AS function_oid,p.oprcanmerge,p.oprcanhash FROM classes o JOIN pg_opfamily f ON f.oid=o.opcfamily JOIN pg_namespace fn ON fn.oid=f.opfnamespace JOIN pg_amop m ON m.amopfamily=f.oid AND m.amoplefttype=o.opcintype AND m.amoprighttype=o.opcintype JOIN pg_operator p ON p.oid=m.amopopr JOIN pg_namespace pn ON pn.oid=p.oprnamespace JOIN pg_type lt ON lt.oid=m.amoplefttype JOIN pg_namespace ln ON ln.oid=lt.typnamespace JOIN pg_type rt ON rt.oid=m.amoprighttype JOIN pg_namespace rn ON rn.oid=rt.typnamespace ORDER BY o.opcname,m.amopstrategy,m.amoppurpose",
  "familyFunctions": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT o.opcname AS opclass_name,fn.nspname AS family_schema,f.opfname AS family_name,f.oid::text AS family_oid,m.amprocnum::text AS support_number,m.amproclefttype::text AS left_type_oid,ln.nspname AS left_type_schema,lt.typname AS left_type_name,m.amprocrighttype::text AS right_type_oid,rn.nspname AS right_type_schema,rt.typname AS right_type_name,m.amproc::oid::text AS function_oid,pn.nspname AS function_schema,p.proname AS function_name FROM classes o JOIN pg_opfamily f ON f.oid=o.opcfamily JOIN pg_namespace fn ON fn.oid=f.opfnamespace JOIN pg_amproc m ON m.amprocfamily=f.oid AND m.amproclefttype=o.opcintype AND m.amprocrighttype=o.opcintype JOIN pg_proc p ON p.oid=m.amproc JOIN pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_type lt ON lt.oid=m.amproclefttype JOIN pg_namespace ln ON ln.oid=lt.typnamespace JOIN pg_type rt ON rt.oid=m.amprocrighttype JOIN pg_namespace rn ON rn.oid=rt.typnamespace ORDER BY o.opcname,m.amprocnum",
  "fkOperators": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT con.conname,con.oid::text AS constraint_oid,k.kind,k.ordinality::text AS key_ordinal,k.operator_oid::text,pn.nspname AS operator_schema,p.oprname AS operator_name,ln.nspname AS left_type_schema,lt.typname AS left_type_name,rn.nspname AS right_type_schema,rt.typname AS right_type_name,resn.nspname AS result_type_schema,res.typname AS result_type_name,p.oprcode::oid::text AS function_oid,p.oprcanmerge,p.oprcanhash FROM pg_constraint con CROSS JOIN LATERAL(SELECT 'parent_foreign' AS kind,operator_oid,ordinality FROM unnest(con.conpfeqop) WITH ORDINALITY o(operator_oid,ordinality) UNION ALL SELECT 'parent_parent',operator_oid,ordinality FROM unnest(con.conppeqop) WITH ORDINALITY o(operator_oid,ordinality) UNION ALL SELECT 'foreign_foreign',operator_oid,ordinality FROM unnest(con.conffeqop) WITH ORDINALITY o(operator_oid,ordinality)) k JOIN pg_operator p ON p.oid=k.operator_oid JOIN pg_namespace pn ON pn.oid=p.oprnamespace JOIN pg_type lt ON lt.oid=p.oprleft JOIN pg_namespace ln ON ln.oid=lt.typnamespace JOIN pg_type rt ON rt.oid=p.oprright JOIN pg_namespace rn ON rn.oid=rt.typnamespace JOIN pg_type res ON res.oid=p.oprresult JOIN pg_namespace resn ON resn.oid=res.typnamespace WHERE con.conrelid IN(SELECT oid FROM authored) AND con.contype='f' ORDER BY con.conname,k.kind,k.ordinality",
  "triggerLinks": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT t.oid::text AS trigger_oid,n.nspname AS relation_schema,c.relname AS relation_name,t.tgrelid::text AS relation_oid,t.tgname,t.tgparentid::text,t.tgtype::text,t.tgenabled,t.tgisinternal,t.tgdeferrable,t.tginitdeferred,t.tgconstraint::text,con.conname AS constraint_name,t.tgconstrrelid::text,othern.nspname AS other_schema,other.relname AS other_relation,t.tgconstrindid::text,idx.relname AS referenced_index,t.tgnargs::text,encode(t.tgargs,'hex') AS args_hex,t.tgattr::text,pg_get_expr(t.tgqual,t.tgrelid) AS qualifier,t.tgoldtable,t.tgnewtable,p.oid::text AS function_oid,pn.nspname AS function_schema,p.proname AS function_name,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_constraint con ON con.oid=t.tgconstraint JOIN pg_class other ON other.oid=t.tgconstrrelid JOIN pg_namespace othern ON othern.oid=other.relnamespace JOIN pg_class idx ON idx.oid=t.tgconstrindid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE t.tgrelid IN(SELECT oid FROM authored) ORDER BY con.conname,c.relname,p.proname",
  "relationStorage": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT n.nspname AS schema_name,c.relname,c.oid::text AS relation_oid,c.relkind,c.relpersistence,c.relowner::text AS owner_oid,c.relam::text AS access_method_oid,am.amname AS access_method,c.reltablespace::text AS explicit_tablespace_oid,COALESCE(NULLIF(c.reltablespace,0),d.dattablespace)::text AS effective_tablespace_oid,ts.spcname AS effective_tablespace_name,ts.spcowner::text AS tablespace_owner_oid,ts.spcacl,ts.spcoptions,c.reltoastrelid::text,c.relreplident,c.reloptions,c.relacl,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,c.relchecks::text,c.relhasrules,c.relhastriggers,EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_database d ON d.datname=current_database() LEFT JOIN pg_am am ON am.oid=c.relam JOIN pg_tablespace ts ON ts.oid=COALESCE(NULLIF(c.reltablespace,0),d.dattablespace) WHERE c.oid IN(SELECT oid FROM heaps UNION SELECT indexrelid FROM ix) ORDER BY n.nspname,c.relname",
  "allIndexFields": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT n.nspname AS index_schema,c.relname AS index_name,c.oid::text AS index_oid,to_jsonb(ix) AS native_index_fields,pg_get_indexdef(c.oid) AS definition FROM ix JOIN pg_class c ON c.oid=ix.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY n.nspname,c.relname",
  "toastSubordinates": "WITH authored AS(SELECT c.oid,c.reltoastrelid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS(SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), ix AS(SELECT i.* FROM pg_index i WHERE i.indrelid IN(SELECT oid FROM heaps)), classes AS(SELECT DISTINCT o.* FROM pg_opclass o JOIN ix ON o.oid=ANY(ix.indclass::oid[])) SELECT 'trigger' AS kind,t.oid::text AS object_oid,t.tgname AS object_name,t.tgrelid::text AS parent_oid FROM pg_trigger t WHERE t.tgrelid IN(SELECT reltoastrelid FROM authored) UNION ALL SELECT 'constraint',x.oid::text,x.conname,x.conrelid::text FROM pg_constraint x WHERE x.conrelid IN(SELECT reltoastrelid FROM authored) UNION ALL SELECT 'rule',r.oid::text,r.rulename,r.ev_class::text FROM pg_rewrite r WHERE r.ev_class IN(SELECT reltoastrelid FROM authored) UNION ALL SELECT 'policy',p.oid::text,p.polname,p.polrelid::text FROM pg_policy p WHERE p.polrelid IN(SELECT reltoastrelid FROM authored) UNION ALL SELECT 'statistics',s.oid::text,s.stxname,s.stxrelid::text FROM pg_statistic_ext s WHERE s.stxrelid IN(SELECT reltoastrelid FROM authored) ORDER BY kind,object_name",
  "namespacesAndSettings": "SELECT n.nspname,n.oid::text AS namespace_oid,n.nspowner::text AS owner_oid,n.nspacl,current_setting('server_version_num') AS server_version_num,current_setting('default_tablespace') AS default_tablespace,current_setting('default_table_access_method') AS default_table_access_method,current_setting('server_encoding') AS server_encoding FROM pg_namespace n WHERE n.nspname=ANY(ARRAY['shared','pg_catalog','pg_toast']) ORDER BY n.nspname"
}

const SOURCE = JSON.parse(RETAINED_NATIVE_SOURCE_PROFILE_JSON) as Source
const SCOPE = `WITH authored AS (SELECT c.oid,c.reltoastrelid,c.reltype FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND c.relname=ANY(ARRAY['memory_retained_authority_v1_runs','memory_retained_authority_v1_pages','memory_retained_authority_v1_items'])), heaps AS (SELECT oid FROM authored UNION SELECT reltoastrelid FROM authored WHERE reltoastrelid<>0), relations AS (SELECT oid FROM heaps UNION SELECT indexrelid FROM pg_index WHERE indrelid IN(SELECT oid FROM heaps)), types AS (SELECT oid FROM pg_type WHERE typrelid IN(SELECT oid FROM heaps) UNION SELECT typarray FROM pg_type WHERE typrelid IN(SELECT oid FROM authored) AND typarray<>0), constraints AS (SELECT oid FROM pg_constraint WHERE conrelid IN(SELECT oid FROM heaps)), triggers AS (SELECT oid FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM heaps)), objects AS (SELECT 'pg_class'::regclass AS classid,oid AS objid FROM relations UNION ALL SELECT 'pg_type'::regclass,oid FROM types UNION ALL SELECT 'pg_constraint'::regclass,oid FROM constraints UNION ALL SELECT 'pg_trigger'::regclass,oid FROM triggers UNION ALL SELECT 'pg_namespace'::regclass,oid FROM pg_namespace WHERE nspname='shared')`
function literal(text: string): string { return "'" + text.replaceAll("'", "''") + "'" }
function catalogQueries(profile: Profile): Record<string, string> {
  const signatures = Object.entries(profile.native.functions).map(([_signature, row]) => literal('pg_catalog."' + row.proname!.replaceAll('"', '""') + '"(' + row.proargtypes!.split(' ').filter(Boolean).map(t => 'pg_catalog.' + t).join(',') + ')'))
  const closureSignatures = Object.values({ ...profile.native.functions, ...profile.checkReferences.functions }).map(row => literal('pg_catalog.\"' + row.proname!.replaceAll('\"','\"\"') + '\"(' + row.proargtypes!.split(' ').filter(Boolean).map(t => 'pg_catalog.' + t).join(',') + ')'))
  const closureOperators = [...new Set([...Object.keys(profile.operators), ...Object.keys(profile.checkReferences.operators)])].map(key => literal('pg_catalog.' + key.replace('(', '(pg_catalog.').replace(',', ',pg_catalog.')))
  const nativeScope = `WITH functions AS (SELECT p.* FROM pg_proc p WHERE p.oid=ANY(ARRAY[${closureSignatures.map(s => 'to_regprocedure(' + s + ')::oid').join(',')}])), classes AS (SELECT o.* FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace JOIN pg_am a ON a.oid=o.opcmethod WHERE n.nspname='pg_catalog' AND a.amname='btree' AND o.opcname IN('int4_ops','numeric_ops','oid_ops','text_ops','uuid_ops')), types AS (SELECT unnest(proargtypes::oid[]) AS oid FROM functions UNION SELECT prorettype FROM functions UNION SELECT a.atttypid FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' AND a.attnum>0), objects AS (SELECT 'pg_proc'::regclass AS classid,oid FROM functions UNION SELECT 'pg_opclass'::regclass,oid FROM classes UNION SELECT 'pg_opfamily'::regclass,opcfamily FROM classes UNION SELECT 'pg_am'::regclass,oid FROM pg_am WHERE amname IN('heap','btree') UNION SELECT 'pg_collation'::regclass,c.oid FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='pg_catalog' AND c.collname='C' AND c.collencoding=-1 UNION SELECT 'pg_namespace'::regclass,oid FROM pg_namespace WHERE nspname IN('pg_catalog','pg_toast') UNION SELECT 'pg_type'::regclass,oid FROM types UNION SELECT 'pg_operator'::regclass,o.oid FROM pg_operator o WHERE o.oid=ANY(ARRAY[${closureOperators.map(s => 'to_regoperator(' + s + ')::oid').join(',')}]))`
  return {
    ...BASE_QUERIES,
    nativeTypeIdentities: nativeScope + ` SELECT t.oid::text AS type_oid,n.nspname AS schema_name,t.typname,t.typowner::text,t.typnamespace::text FROM pg_type t LEFT JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.oid IN(SELECT oid FROM objects WHERE classid='pg_type'::regclass) ORDER BY t.oid`,
    nativeObjects: nativeScope + ` SELECT classid::regclass::text AS class_name,oid::text AS object_oid FROM objects ORDER BY classid,oid`,
    nativeDependencies: nativeScope + ` SELECT d.classid::regclass::text AS class_name,d.objid::text,d.objsubid::text,d.refclassid::regclass::text AS ref_class,d.refobjid::text,d.refobjsubid::text,d.deptype FROM pg_depend d WHERE EXISTS(SELECT 1 FROM objects o WHERE (o.classid=d.classid AND o.oid=d.objid) OR(o.classid=d.refclassid AND o.oid=d.refobjid)) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`,
    nativeOwnerPins: `SELECT d.dbid::text,d.classid::text,d.objid::text,d.objsubid::text,d.refclassid::regclass::text AS ref_class,d.refobjid::text,d.deptype FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=(SELECT nspowner FROM pg_namespace WHERE nspname='pg_catalog') AND d.deptype='p' ORDER BY d.dbid,d.classid,d.objid`,
    functions: `SELECT n.nspname AS schema_name,p.proname,to_jsonb(p) AS fields,l.lanname AS language,rn.nspname||'.'||r.typname AS result_type,ARRAY(SELECT an.nspname||'.'||t.typname FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(type_oid,ord) LEFT JOIN pg_type t ON t.oid=a.type_oid LEFT JOIN pg_namespace an ON an.oid=t.typnamespace ORDER BY a.ord) AS argument_types,ARRAY(SELECT t.oid::text FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(type_oid,ord) LEFT JOIN pg_type t ON t.oid=a.type_oid ORDER BY a.ord) AS argument_oids FROM pg_proc p LEFT JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN pg_language l ON l.oid=p.prolang LEFT JOIN pg_type r ON r.oid=p.prorettype LEFT JOIN pg_namespace rn ON rn.oid=r.typnamespace WHERE p.oid=ANY(ARRAY[${signatures.map(s => 'to_regprocedure(' + s + ')::oid').join(',')}]) ORDER BY p.oid`,
    operators: `SELECT n.nspname AS schema_name,p.oprname,to_jsonb(p) AS fields,p.oprcode::oid::text AS code_oid,p.oprrest::oid::text AS rest_oid,p.oprjoin::oid::text AS join_oid FROM pg_operator p LEFT JOIN pg_namespace n ON n.oid=p.oprnamespace LEFT JOIN pg_type t ON t.oid=p.oprleft LEFT JOIN pg_namespace tn ON tn.oid=t.typnamespace WHERE n.nspname='pg_catalog' AND tn.nspname='pg_catalog' AND t.typname=ANY(ARRAY['int4','numeric','oid','text','uuid']) AND p.oprleft=p.oprright AND p.oprname=ANY(ARRAY['<','<=','=','>=','>','<>']) ORDER BY p.oid`,
    classes: `SELECT n.nspname AS schema_name,to_jsonb(o) AS fields,fn.nspname AS family_schema,to_jsonb(f) AS family_fields FROM pg_opclass o LEFT JOIN pg_namespace n ON n.oid=o.opcnamespace LEFT JOIN pg_opfamily f ON f.oid=o.opcfamily LEFT JOIN pg_namespace fn ON fn.oid=f.opfnamespace LEFT JOIN pg_am a ON a.oid=o.opcmethod WHERE n.nspname='pg_catalog' AND a.amname='btree' AND o.opcname=ANY(ARRAY['int4_ops','numeric_ops','oid_ops','text_ops','uuid_ops']) ORDER BY o.oid`,
    accessMethods: `SELECT to_jsonb(a) AS fields,n.nspname AS handler_schema,p.proname AS handler_name,p.oid::text AS handler_oid FROM pg_am a LEFT JOIN pg_proc p ON p.oid=a.amhandler LEFT JOIN pg_namespace n ON n.oid=p.pronamespace WHERE a.amname IN('heap','btree') ORDER BY a.oid`,
    toastAllAttributes: SCOPE + ` SELECT c.oid::text AS relation_oid,c.relname,c.relkind,tn.nspname AS type_schema,t.typname AS type_name,to_jsonb(a) AS fields FROM relations o JOIN pg_class c ON c.oid=o.oid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=o.oid AND a.attnum>0 LEFT JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_namespace tn ON tn.oid=t.typnamespace WHERE n.nspname='pg_toast' ORDER BY c.oid,a.attnum`,
    allAttributes: SCOPE + ` SELECT c.oid::text AS relation_oid,c.relname,n.nspname AS schema_name,c.relkind,tn.nspname AS type_schema,t.typname AS type_name,t.oid::text AS type_oid,to_jsonb(a) AS fields FROM relations o JOIN pg_class c ON c.oid=o.oid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=o.oid AND a.attnum>0 LEFT JOIN pg_type t ON t.oid=a.atttypid LEFT JOIN pg_namespace tn ON tn.oid=t.typnamespace ORDER BY c.oid,a.attnum`,
    checkFunctionReferences: SCOPE + `, refs AS (SELECT DISTINCT (m[2])::oid AS oid FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(c.conbin::text, ':(funcid|opfuncid) ([0-9]+)', 'g') m WHERE c.conrelid IN(SELECT oid FROM authored) AND c.contype='c') SELECT refs.oid::text AS function_oid,n.nspname AS schema_name,p.proname,p.proowner::text,p.pronamespace::text,l.lanname AS language,rn.nspname||'.'||r.typname AS result_type,ARRAY(SELECT an.nspname||'.'||t.typname FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(type_oid,ord) LEFT JOIN pg_type t ON t.oid=a.type_oid LEFT JOIN pg_namespace an ON an.oid=t.typnamespace ORDER BY a.ord) AS argument_types FROM refs LEFT JOIN pg_proc p ON p.oid=refs.oid LEFT JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN pg_language l ON l.oid=p.prolang LEFT JOIN pg_type r ON r.oid=p.prorettype LEFT JOIN pg_namespace rn ON rn.oid=r.typnamespace ORDER BY refs.oid`,
    checkOperatorReferences: SCOPE + `, refs AS (SELECT DISTINCT (m[1])::oid AS oid FROM pg_constraint c CROSS JOIN LATERAL regexp_matches(c.conbin::text, ':opno ([0-9]+)', 'g') m WHERE c.conrelid IN(SELECT oid FROM authored) AND c.contype='c') SELECT refs.oid::text AS operator_oid,n.nspname AS schema_name,p.oprname,p.oprowner::text,p.oprnamespace::text,p.oprcode::oid::text AS function_oid,ln.nspname||'.'||lt.typname AS left_type,rn.nspname||'.'||rt.typname AS right_type,resn.nspname||'.'||res.typname AS result_type FROM refs LEFT JOIN pg_operator p ON p.oid=refs.oid LEFT JOIN pg_namespace n ON n.oid=p.oprnamespace LEFT JOIN pg_type lt ON lt.oid=p.oprleft LEFT JOIN pg_namespace ln ON ln.oid=lt.typnamespace LEFT JOIN pg_type rt ON rt.oid=p.oprright LEFT JOIN pg_namespace rn ON rn.oid=rt.typnamespace LEFT JOIN pg_type res ON res.oid=p.oprresult LEFT JOIN pg_namespace resn ON resn.oid=res.typnamespace ORDER BY refs.oid`,
    rawTriggers: SCOPE + ` SELECT t.oid::text AS trigger_oid,to_jsonb(t) AS fields FROM pg_trigger t WHERE t.tgrelid IN(SELECT oid FROM relations) ORDER BY t.oid`,
    rawConstraints: SCOPE + ` SELECT c.oid::text AS constraint_oid,to_jsonb(c) AS fields FROM pg_constraint c WHERE c.conrelid IN(SELECT oid FROM relations) ORDER BY c.oid`,
    rawRelations: SCOPE + ` SELECT c.oid::text AS relation_oid,to_jsonb(c) AS fields FROM pg_class c WHERE c.oid IN(SELECT oid FROM relations) ORDER BY c.oid`,
    nativeTypes: SCOPE + ` SELECT t.oid::text AS type_oid,n.nspname AS schema_name,to_jsonb(t) AS fields,t.typinput::oid::text AS input_oid,t.typoutput::oid::text AS output_oid,t.typreceive::oid::text AS receive_oid,t.typsend::oid::text AS send_oid,t.typanalyze::oid::text AS analyze_oid${profile.major === '17' ? ',t.typsubscript::oid::text AS subscript_oid' : ''} FROM pg_type t LEFT JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.oid IN(SELECT objid FROM objects WHERE classid='pg_type'::regclass) ORDER BY t.oid`,
    relationLinks: SCOPE + ` SELECT c.oid::text AS relation_oid,c.relname,n.nspname AS schema_name,c.reltype::text,c.relnamespace::text,c.relnatts::text,c.reloftype::text,c.reltoastrelid::text,c.relam::text FROM pg_class c LEFT JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid IN(SELECT oid FROM relations) ORDER BY c.oid`,
    dependencies: SCOPE + ` SELECT d.classid::regclass::text AS class_name,d.objid::text,d.objsubid::text,d.refclassid::regclass::text AS ref_class,d.refobjid::text,d.refobjsubid::text,d.deptype FROM pg_depend d WHERE EXISTS(SELECT 1 FROM objects o WHERE (o.classid=d.classid AND o.objid=d.objid) OR(o.classid=d.refclassid AND o.objid=d.refobjid)) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype`,
    sharedDependencies: SCOPE + ` SELECT d.dbid::text,d.classid::regclass::text AS class_name,d.objid::text,d.objsubid::text,d.refclassid::regclass::text AS ref_class,d.refobjid::text,d.deptype FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND EXISTS(SELECT 1 FROM objects o WHERE o.classid=d.classid AND o.objid=d.objid) ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.deptype`,
    enclosingObjects: `SELECT 'relation' AS kind,c.relname AS name,c.relkind::text AS subtype FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='shared' UNION ALL SELECT 'type',t.typname,t.typtype::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='shared' UNION ALL SELECT 'function',p.proname,p.prokind::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='shared' UNION ALL SELECT 'collation',c.collname,'' FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='shared' UNION ALL SELECT 'conversion',c.conname,'' FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='shared' UNION ALL SELECT 'opclass',c.opcname,'' FROM pg_opclass c JOIN pg_namespace n ON n.oid=c.opcnamespace WHERE n.nspname='shared' UNION ALL SELECT 'opfamily',c.opfname,'' FROM pg_opfamily c JOIN pg_namespace n ON n.oid=c.opfnamespace WHERE n.nspname='shared' UNION ALL SELECT 'operator',c.oprname,'' FROM pg_operator c JOIN pg_namespace n ON n.oid=c.oprnamespace WHERE n.nspname='shared' UNION ALL SELECT 'statistics',c.stxname,'' FROM pg_statistic_ext c JOIN pg_namespace n ON n.oid=c.stxnamespace WHERE n.nspname='shared' UNION ALL SELECT 'text-search-parser',c.prsname,'' FROM pg_ts_parser c JOIN pg_namespace n ON n.oid=c.prsnamespace WHERE n.nspname='shared' UNION ALL SELECT 'text-search-dictionary',c.dictname,'' FROM pg_ts_dict c JOIN pg_namespace n ON n.oid=c.dictnamespace WHERE n.nspname='shared' UNION ALL SELECT 'text-search-template',c.tmplname,'' FROM pg_ts_template c JOIN pg_namespace n ON n.oid=c.tmplnamespace WHERE n.nspname='shared' UNION ALL SELECT 'text-search-config',c.cfgname,'' FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname='shared'`,
    extras: SCOPE + ` SELECT 'rule' AS kind,r.oid::text FROM pg_rewrite r WHERE r.ev_class IN(SELECT oid FROM relations) UNION ALL SELECT 'policy',p.oid::text FROM pg_policy p WHERE p.polrelid IN(SELECT oid FROM relations) UNION ALL SELECT 'statistic',s.oid::text FROM pg_statistic_ext s WHERE s.stxrelid IN(SELECT oid FROM relations) UNION ALL SELECT 'inheritance',i.inhrelid::text FROM pg_inherits i WHERE i.inhrelid IN(SELECT oid FROM relations) OR i.inhparent IN(SELECT oid FROM relations) UNION ALL SELECT 'security-label',s.objoid::text FROM pg_seclabel s WHERE EXISTS(SELECT 1 FROM objects o WHERE o.classid=s.classoid AND o.objid=s.objoid)`,
    acl: SCOPE + ` SELECT 'relation' AS kind,c.oid::text AS object_oid,c.relowner::text AS owner_oid,a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN(SELECT oid FROM relations) AND c.relkind IN('r','t') UNION ALL SELECT 'type',t.oid::text,t.typowner::text,a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable FROM pg_type t CROSS JOIN LATERAL aclexplode(COALESCE(t.typacl,acldefault('T',t.typowner))) a WHERE t.oid IN(SELECT oid FROM types)`,
    namespaces: `SELECT n.oid::text,n.nspname,n.nspowner::text,a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname=ANY(ARRAY['shared','pg_catalog','pg_toast']) ORDER BY n.oid,a.grantee,a.privilege_type`,
    databaseTablespace: `SELECT d.oid::text AS database_oid,d.datdba::text,d.datallowconn,d.datistemplate,d.datconnlimit::text,d.datacl,d.dattablespace::text,t.spcname,t.spcowner::text,t.spcacl,t.spcoptions FROM pg_database d LEFT JOIN pg_tablespace t ON t.oid=d.dattablespace WHERE d.datname=current_database()`,
    databaseAcl: `SELECT d.oid::text AS object_oid,d.datdba::text AS owner_oid,a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database()`,
    roles: `SELECT to_jsonb(r)-'rolpassword' AS fields FROM pg_roles r WHERE r.rolsuper OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolname=current_user OR r.rolname IN('pg_read_all_data','pg_write_all_data','pg_maintain') ORDER BY r.oid`,
    memberships: `SELECT to_jsonb(m) AS fields,r.rolname AS role_name,u.rolname AS member_name FROM pg_auth_members m LEFT JOIN pg_roles r ON r.oid=m.roleid LEFT JOIN pg_roles u ON u.oid=m.member ORDER BY m.roleid,m.member`,
    defaultAcls: `SELECT d.oid::text,d.defaclrole::text,d.defaclnamespace::text,d.defaclobjtype,d.defaclacl FROM pg_default_acl d WHERE d.defaclrole=current_user::regrole OR d.defaclnamespace IN(SELECT oid FROM pg_namespace WHERE nspname='shared') ORDER BY d.oid`,
  }
}

function validateCatalog(rows: Rows, binding: Binding, identity: Row): void {
  const profile = binding.profile, descriptor = SOURCE.descriptor, owner = binding.config.identity.roleOid
  const namespace = one(rows.namespacesAndSettings!, { nspname: 'pg_catalog' }, 'native_namespace')
  const nativeOwner = str(namespace.owner_oid), nativeNamespace = str(namespace.namespace_oid)
  equal(nativeOwner, profile.nativeBootstrapOwnerOid, 'native_bootstrap_owner_source')
  const sharedNamespace = str(one(rows.namespacesAndSettings!, { nspname: 'shared' }, 'shared_namespace').namespace_oid)
  const toastNamespace = str(one(rows.namespacesAndSettings!, { nspname: 'pg_toast' }, 'toast_namespace').namespace_oid)
  roster(rows.namespacesAndSettings!, ['pg_catalog', 'pg_toast', 'shared'], r => r.nspname, 'namespaces')
  for (const r of rows.namespacesAndSettings!) fields(r, { server_version_num: binding.config.identity.serverVersionNum, default_tablespace: '', default_table_access_method: 'heap', server_encoding: 'UTF8' }, 'namespace_settings')
  equal(one(rows.namespacesAndSettings!, { nspname: 'shared' }, 'shared_namespace').owner_oid, owner, 'shared_namespace_owner')
  equal(one(rows.namespacesAndSettings!, { nspname: 'pg_toast' }, 'toast_namespace').owner_oid, nativeOwner, 'toast_namespace_owner')
  const relationByName = new Map<string, Row>()
  const relationByOid = new Map<string, Row>()
  for (const r of rows.relationStorage!) {
    const name = str(r.schema_name) + '.' + str(r.relname), oid = str(r.relation_oid)
    requireThat(!relationByName.has(name) && !relationByOid.has(oid), 'relation_duplicate')
    relationByName.set(name, r); relationByOid.set(oid, r)
  }
  const relation = (name: string): Row => { const r = relationByName.get(name); requireThat(r, 'relation_missing/' + name); return r }
  const expectedRelations: string[] = [], expectedKeys: unknown[] = []
  for (const table of descriptor.tables) {
    const r = relation('shared.' + table.name), oid = str(r.relation_oid)
    expectedRelations.push('shared.' + table.name, 'pg_toast.pg_toast_' + oid, 'pg_toast.pg_toast_' + oid + '_index')
    fields(r, { relkind: 'r', relreplident: 'd', reloptions: ['autovacuum_enabled=false'], relchecks: String(table.checks.length), relhastriggers: descriptor.foreignKeys.some(f => f.child === 'shared.' + table.name || f.parent === 'shared.' + table.name) }, 'authored_heap')
    const toast = relation('pg_toast.pg_toast_' + oid)
    equal(r.reltoastrelid, toast.relation_oid, 'toast_parent_link')
    const columns = rows.columns!.filter(c => c.relname === table.name)
    equal(columns.length, table.columns.length, 'authored_columns')
    for (let i = 0; i < table.columns.length; i++) {
      const e = table.columns[i]!, c = one(columns, { attnum: String(i + 1) }, 'authored_column')
      fields(c, { attname: e.name, type_name: e.sqlType, attnotnull: !e.nullable, attgenerated: '', attidentity: '', atthasdef: false, attisdropped: false, attstattarget: String(e.statisticsTarget), attacl: null, attoptions: null, default_expression: null }, 'authored_column')
      if (e.collation === 'pg_catalog.C') equal(c.attcollation, one(rows.collations!, { collation_name: 'C' }, 'collation').collation_oid, 'column_collation_link')
      else equal(c.attcollation, '0', 'column_native_collation')
    }
    for (const [i, key] of ['chunk_id', 'chunk_seq'].entries()) expectedKeys.push(['pg_toast', str(toast.relname) + '_index', String(i + 1), key, 'pg_catalog.' + (i === 0 ? 'oid_ops' : 'int4_ops'), null])
  }
  for (const idx of descriptor.indexes) {
    expectedRelations.push('shared.' + idx.name)
    fields(relation('shared.' + idx.name), { relkind: 'i', relreplident: 'n', reloptions: null, relchecks: '0', relhastriggers: false, relacl: null, reltoastrelid: '0' }, 'authored_index_storage')
    idx.keys.forEach((key, i) => expectedKeys.push(['shared', idx.name, String(i + 1), key, idx.opclasses[i], idx.collations[i]]))
  }
  equal([...relationByName.keys()].sort(), [...expectedRelations].sort(), 'all_relations_roster')
  for (const r of rows.relationStorage!) {
    fields(r, { owner_oid: owner, relpersistence: 'p', explicit_tablespace_oid: '0', relrowsecurity: false, relforcerowsecurity: false, relispartition: false, inherited: false, relhasrules: false, effective_tablespace_oid: binding.config.tablespace.oid, effective_tablespace_name: binding.config.tablespace.name, tablespace_owner_oid: binding.config.tablespace.ownerOid, spcacl: null, spcoptions: null, access_method: r.relkind === 'i' ? 'btree' : 'heap' }, 'relation_storage')
    if (r.schema_name === 'pg_toast') fields(r, { relreplident: 'n', reloptions: null, relacl: null, relchecks: '0', relhastriggers: false, reltoastrelid: '0' }, 'toast_storage')
  }
  roster(rows.tables!, [...descriptor.tables.map(t => t.name), ...descriptor.indexes.map(i => i.name)], r => r.relname, 'authored_relation_roster')
  equal(rows.columns!.length, 59, 'authored_column_roster')
  equal(rows.extras!, [], 'unknown_subordinate')
  equal(rows.toastSubordinates!, [], 'toast_subordinate')
  roster(rows.enclosingObjects!, [
    ...descriptor.tables.map(t => ['relation', t.name, 'r']), ...descriptor.indexes.map(i => ['relation', i.name, 'i']),
    ...descriptor.tables.flatMap(t => [['type', t.name, 'c'], ['type', '_' + t.name, 'b']]),
  ], r => [r.kind, r.name, r.subtype], 'enclosing_registry')

  const functionByOid = new Map<string, string>(), functionBySignature = new Map<string, Row>(), typeOids = new Map<string, string>()
  function bindType(name: string, oid: Json | undefined): void {
    const id = str(oid, 'type_oid'); requireThat(DECIMAL.test(id) && id !== '0', 'type_oid')
    if (typeOids.has(name)) equal(typeOids.get(name), id, 'type_identity_link')
    typeOids.set(name, id)
  }
  for (const r of rows.functions!) {
    const args = list(r.argument_types).map(v => str(v)), fields = object(r.fields)
    const signature = str(r.schema_name) + '.' + str(r.proname) + '(' + args.join(',') + ')'
    requireThat(!functionBySignature.has(signature) && !functionByOid.has(str(fields.oid)), 'function_identity_duplicate')
    functionBySignature.set(signature, r); functionByOid.set(str(fields.oid), signature)
    const argOids = list(r.argument_oids)
    equal(args.length, argOids.length, 'function_arguments_cardinality')
    args.forEach((arg, i) => bindType(arg, argOids[i]))
    bindType(str(r.result_type), fields.prorettype)
  }
  equal([...functionBySignature.keys()].sort(), Object.keys(profile.native.functions).sort(), 'function_roster')
  for (const [signature, source] of Object.entries(profile.native.functions)) {
    const r = functionBySignature.get(signature)!, f = object(r.fields)
    const skip = new Set(['oid', 'oid_symbol', 'descr', 'pronamespace', 'proowner', 'prolang', 'prorettype', 'proargtypes'])
    const bools = new Set(['prosecdef', 'proleakproof', 'proisstrict', 'proretset'])
    exactKeys(f, [...new Set([...Object.keys(source).filter(k => !['oid_symbol', 'descr'].includes(k)), 'oid', 'pronargs'])], 'function_native_coverage')
    fields(r, { language: source.prolang!, result_type: 'pg_catalog.' + source.prorettype! }, 'function_identity')
    fields(f, { prolang: profile.nativeInternalLanguageOid, proowner: nativeOwner, pronamespace: nativeNamespace, pronargs: String(source.proargtypes!.split(' ').filter(Boolean).length), proargtypes: r.argument_oids! }, 'function_oid_links')
    for (const [key, value] of Object.entries(source)) {
      if (skip.has(key)) continue
      equal(f[key], value === '_null_' ? null : bools.has(key) ? value === 't' : key === 'prosupport' && value === '0' ? '-' : value, 'function_property/' + signature + '/' + key)
    }
  }
  const resolveFunctionName = (name: string): string => {
    const entries = [...functionBySignature.entries()].filter(([sig]) => sig.startsWith('pg_catalog.' + name + '('))
    requireThat(entries.length === 1, 'function_reference_identity/' + name)
    return str(object(entries[0]![1].fields).oid)
  }
  const methods = new Map<string, string>()
  roster(rows.accessMethods!, ['btree', 'heap'], r => object(r.fields).amname, 'access_methods')
  for (const r of rows.accessMethods!) {
    const f = object(r.fields), name = str(f.amname), handler = name === 'btree' ? 'bthandler' : 'heap_tableam_handler'
    exactKeys(f, ['oid', 'amname', 'amtype', 'amhandler'], 'access_method')
    fields(f, { amtype: name === 'btree' ? 'i' : 't', amhandler: handler }, 'access_method')
    fields(r, { handler_schema: 'pg_catalog', handler_name: handler, handler_oid: resolveFunctionName(handler) }, 'access_method_handler_link')
    methods.set(name, str(f.oid))
  }
  for (const r of rows.relationStorage!) equal(r.access_method_oid, methods.get(r.relkind === 'i' ? 'btree' : 'heap'), 'relation_access_method_link')
  const classes = new Map<string, Row>()
  roster(rows.classes!, Object.keys(profile.native.classes), r => object(r.fields).opcname, 'classes')
  for (const r of rows.classes!) {
    const f = object(r.fields), family = object(r.family_fields), name = str(f.opcname), source = profile.native.classes[name]!
    classes.set(name, r)
    fields(r, { schema_name: 'pg_catalog', family_schema: 'pg_catalog' }, 'opclass_namespace')
    exactKeys(f, ['oid','opcname','opcowner','opcfamily','opcintype','opcmethod','opcdefault','opckeytype','opcnamespace'], 'opclass')
    fields(f, { opcowner: nativeOwner, opcnamespace: nativeNamespace, opcdefault: true, opckeytype: '0', opcmethod: methods.get('btree')!, opcintype: typeOids.get(source.inputType)!, opcfamily: family.oid! }, 'opclass_properties')
    exactKeys(family, ['oid','opfname','opfowner','opfmethod','opfnamespace'], 'opfamily')
    fields(family, { opfowner: nativeOwner, opfnamespace: nativeNamespace, opfmethod: methods.get('btree')!, opfname: source.family.slice('pg_catalog.'.length) }, 'opfamily_properties')
  }
  const operators = new Map<string, Row>()
  for (const r of rows.operators!) {
    const f = object(r.fields), left = [...typeOids].find(([, oid]) => oid === f.oprleft)?.[0]
    requireThat(left, 'operator_input_link')
    const typ = left.slice('pg_catalog.'.length), key = str(f.oprname) + '(' + typ + ',' + typ + ')'
    requireThat(!operators.has(key), 'operator_duplicate'); operators.set(key, r)
  }
  equal([...operators.keys()].sort(), Object.keys(profile.operators).sort(), 'operator_roster')
  for (const [key, source] of Object.entries(profile.operators)) {
    const r = operators.get(key)!, f = object(r.fields)
    exactKeys(f, ['oid','oprcom','oprcode','oprjoin','oprkind','oprleft','oprname','oprrest','oprowner','oprright','oprnegate','oprresult','oprcanhash','oprcanmerge','oprnamespace'], 'operator_native_fields')
    fields(r, { schema_name: 'pg_catalog', code_oid: resolveFunctionName(source.oprcode!), rest_oid: resolveFunctionName(source.oprrest!), join_oid: resolveFunctionName(source.oprjoin!) }, 'operator_function_link')
    fields(f, { oprnamespace: nativeNamespace, oprowner: nativeOwner, oprkind: 'b', oprleft: typeOids.get('pg_catalog.' + source.oprleft!)!, oprright: typeOids.get('pg_catalog.' + source.oprright!)!, oprresult: typeOids.get('pg_catalog.' + source.oprresult!)!, oprcode: source.oprcode!, oprrest: source.oprrest!, oprjoin: source.oprjoin!, oprcanmerge: source.oprcanmerge === 't', oprcanhash: source.oprcanhash === 't' }, 'operator_source_properties')
    equal(f.oprcom, object(operators.get(source.oprcom!)!.fields).oid, 'operator_commutator_link')
    equal(f.oprnegate, object(operators.get(source.oprnegate!)!.fields).oid, 'operator_negator_link')
  }
  equal(rows.familyOperators!.length, 25, 'family_operator_count')
  for (const e of profile.native.operators) {
    const r = one(rows.familyOperators!, { opclass_name: e.class, strategy: e.strategy }, 'family_operator'), f = object(classes.get(e.class)!.family_fields), op = object(operators.get(e.operator + '(' + e.type + ',' + e.type + ')')!.fields)
    fields(r, { family_oid: f.oid!, family_schema: 'pg_catalog', family_name: f.opfname!, operator_oid: op.oid!, function_oid: resolveFunctionName(e.source.oprcode!), operator_schema: 'pg_catalog', operator_name: e.operator, left_type_schema: 'pg_catalog', left_type_name: e.type, right_type_schema: 'pg_catalog', right_type_name: e.type, left_type_oid: typeOids.get('pg_catalog.' + e.type)!, right_type_oid: typeOids.get('pg_catalog.' + e.type)!, result_type_oid: typeOids.get('pg_catalog.bool')!, amoppurpose: 's', sort_family_oid: '0', method_oid: methods.get('btree')!, oprcanmerge: e.source.oprcanmerge === 't', oprcanhash: e.source.oprcanhash === 't' }, 'family_operator_link')
  }
  equal(rows.familyFunctions!.length, 16, 'family_support_count')
  for (const e of profile.native.supportFunctions) {
    const r = one(rows.familyFunctions!, { opclass_name: e.class, support_number: e.slot }, 'family_support'), family = object(classes.get(e.class)!.family_fields), source = profile.native.classes[e.class]!
    fields(r, { family_oid: family.oid!, family_schema: 'pg_catalog', family_name: family.opfname!, function_oid: str(object(functionBySignature.get(e.function)!.fields).oid), function_schema: 'pg_catalog', function_name: profile.native.functions[e.function]!.proname!, left_type_schema: 'pg_catalog', left_type_name: source.inputType.slice(11), right_type_schema: 'pg_catalog', right_type_name: source.inputType.slice(11), left_type_oid: typeOids.get(source.inputType)!, right_type_oid: typeOids.get(source.inputType)! }, 'family_support_link')
  }
  equal(rows.collations!.length, 1, 'collation_roster')
  const collation = rows.collations![0]!, c = object(collation.native_fields)
  fields(collation, { collation_schema: 'pg_catalog', collation_name: 'C', collation_oid: c.oid! }, 'collation_identity')
  const collationFields: Row = { oid: collation.collation_oid!, collname: 'C', collnamespace: nativeNamespace, collowner: nativeOwner, collprovider: 'c', collisdeterministic: true, collencoding: '-1', collcollate: 'C', collctype: 'C', collversion: null }
  if (profile.major === '17') Object.assign(collationFields, { colllocale: null, collicurules: null })
  equal(c, collationFields, 'collation_properties')
  roster(rows.indexKeys!, expectedKeys, r => [r.index_schema, r.index_name, r.key_ordinal, r.attribute_name, str(r.opclass_schema) + '.' + str(r.opclass_name), r.collation_oid === '0' ? null : str(r.collation_schema) + '.' + str(r.collation_name)], 'index_keys')
  for (const k of rows.indexKeys!) {
    const sourceClass = profile.native.classes[str(k.opclass_name)]!
    fields(k, { opclass_schema: 'pg_catalog', opfamily_schema: 'pg_catalog', opfamily_name: sourceClass.family.slice(11), opclass_input_type_schema: 'pg_catalog', opclass_input_type_name: sourceClass.inputType.slice(11), attribute_type_schema: 'pg_catalog', attribute_type_name: sourceClass.inputType.slice(11) }, 'index_qualified_type_links')
    const rawAttribute = rows.allAttributes!.find(a => a.relation_oid === k.heap_oid && object(a.fields).attname === k.attribute_name)
    requireThat(rawAttribute, 'index_attribute_link')
    fields(k, { attribute_number: object(rawAttribute.fields).attnum!, attribute_typmod: object(rawAttribute.fields).atttypmod! }, 'index_attribute_link')
    const opclass = object(classes.get(str(k.opclass_name))!.fields), family = object(classes.get(str(k.opclass_name))!.family_fields)
    fields(k, { opclass_oid: opclass.oid!, opfamily_oid: family.oid!, access_method: 'btree', amtype: 'i', key_options: '0', opclass_input_type_oid: opclass.opcintype!, attribute_type_oid: opclass.opcintype!, access_method_oid: methods.get('btree')!, opclass_owner_oid: nativeOwner, opfamily_owner_oid: nativeOwner, opclass_key_type_oid: '0', opcdefault: true }, 'index_key_links')
    if (k.collation_oid !== '0') equal(k.collation_oid, collation.collation_oid, 'index_collation_link')
    equal(k.heap_oid, relation(str(k.heap_schema) + '.' + str(k.heap_name)).relation_oid, 'index_heap_link')
    equal(k.index_oid, relation(str(k.index_schema) + '.' + str(k.index_name)).relation_oid, 'index_relation_link')
  }
  validateIndexesConstraintsTriggers(rows, binding, relation, operators, resolveFunctionName)
  validateCheckReferences(rows, binding)
  validateRawCatalogs(rows, binding)
  validateAllAttributes(rows, binding)
  validateTypesToast(rows, binding, relation, nativeNamespace, sharedNamespace, toastNamespace, resolveFunctionName)
  validatePrivileges(rows, binding, nativeOwner)
  validateDependencies(rows, binding, relation)
  validateNativeDependencies(rows, binding)
  equal(identity.backend_pid, String(binding.backendPid), 'final_backend_binding')
}

function validateIndexesConstraintsTriggers(rows: Rows, binding: Binding, relation: (name: string) => Row, operators: Map<string, Row>, resolveFunctionName: (name: string) => string): void {
  const profile = binding.profile, descriptor = SOURCE.descriptor
  equal(rows.allIndexFields!.length, 10, 'all_indexes_roster')
  for (const r of rows.allIndexFields!) {
    const f = object(r.native_index_fields), authored = r.index_schema === 'shared'
    const e = descriptor.indexes.find(i => i.name === r.index_name)
    requireThat(!authored || e, 'unknown_authored_index')
    const keys = authored ? e!.keys : ['chunk_id', 'chunk_seq']
    const heap = authored ? relation('shared.' + e!.table) : one(rows.relationStorage!, { relation_oid: f.indrelid! }, 'toast_index_parent')
    const attrs = authored ? rows.columns!.filter(c => c.relname === e!.table) : rows.toastAllAttributes!.filter(a => a.relation_oid === heap.relation_oid).map(a => object(a.fields))
    const attnums = keys.map(k => str(one(attrs, { [authored ? 'attname' : 'attname']: k }, 'index_key_attribute').attnum))
    const indclass = keys.map((_k, i) => {
      const key = one(rows.indexKeys!, { index_oid: r.index_oid!, key_ordinal: String(i + 1) }, 'index_full_key')
      return str(key.opclass_oid)
    })
    const collations = keys.map((_k, i) => str(one(rows.indexKeys!, { index_oid: r.index_oid!, key_ordinal: String(i + 1) }, 'index_full_key').collation_oid))
    const expected: Row = { indexrelid: r.index_oid!, indrelid: heap.relation_oid!, indnatts: String(keys.length), indnkeyatts: String(keys.length), indisunique: authored ? e!.unique : true, indisprimary: authored ? e!.primary : true, indisexclusion: false, indimmediate: true, indisclustered: false, indisvalid: true, indcheckxmin: false, indisready: true, indislive: true, indisreplident: false, indkey: attnums, indcollation: collations, indclass, indoption: keys.map(() => '0'), indexprs: null, indpred: null }
    if (profile.major === '17') expected.indnullsnotdistinct = false
    equal(f, expected, 'index_native_fields')
    if (authored) equal(r.definition, profile.definitions.indexes[str(r.index_name)], 'whole_index_definition')
    else equal(r.definition, 'CREATE UNIQUE INDEX ' + str(r.index_name) + ' ON pg_toast.' + str(heap.relname) + ' USING btree (chunk_id, chunk_seq)', 'whole_toast_index_definition')
    equal(r.index_oid, relation(str(r.index_schema) + '.' + str(r.index_name)).relation_oid, 'index_oid_link')
  }
  roster(rows.constraints!, Object.keys(profile.definitions.constraints), r => r.conname, 'constraints')
  for (const c of rows.constraints!) {
    const name = str(c.conname), table = descriptor.tables.find(t => t.name === c.relname)
    requireThat(table, 'constraint_parent')
    fields(c, { convalidated: true, condeferrable: false, condeferred: false, conislocal: true, coninhcount: '0', conrelid: relation('shared.' + table.name).relation_oid!, definition: profile.definitions.constraints[name]! }, 'constraint_whole_definition')
    const fk = descriptor.foreignKeys.find(f => f.name === name), idx = descriptor.indexes.find(i => i.constraintName === name)
    if (fk) {
      const parent = descriptor.tables.find(t => 'shared.' + t.name === fk.parent)!
      fields(c, { contype: 'f', connoinherit: true, confrelid: relation(fk.parent).relation_oid!, conindid: relation('shared.' + fk.referencedIndex).relation_oid!, conkey: '{' + fk.columns.map(n => table.columns.findIndex(x => x.name === n) + 1).join(',') + '}', confkey: '{' + fk.referencedColumns.map(n => parent.columns.findIndex(x => x.name === n) + 1).join(',') + '}', confupdtype: 'r', confdeltype: 'r', confmatchtype: 's' }, 'foreign_key_structure')
      const eq = fk.referencedColumns.map(n => {
        const column = parent.columns.find(x => x.name === n)!, typ = column.sqlType === 'text' ? 'text' : 'numeric'
        return str(object(operators.get('=(' + typ + ',' + typ + ')')!.fields).oid)
      })
      for (const key of ['conpfeqop', 'conppeqop', 'conffeqop']) equal(c[key], '{' + eq.join(',') + '}', 'foreign_key_equality_array')
    } else if (idx) {
      fields(c, { contype: idx.primary ? 'p' : 'u', connoinherit: true, confrelid: '0', conindid: relation('shared.' + idx.name).relation_oid!, conkey: '{' + idx.keys.map(n => table.columns.findIndex(x => x.name === n) + 1).join(',') + '}', confkey: null, conpfeqop: null, conppeqop: null, conffeqop: null, confupdtype: ' ', confdeltype: ' ', confmatchtype: ' ' }, 'unique_constraint_structure')
    } else {
      const sourceCheck = table.checks.find(x => x.name === name)
      requireThat(sourceCheck, 'unknown_check')
      equal(c.conkey, '{' + sourceCheck.referencedColumns.map(n => table.columns.findIndex(x => x.name === n) + 1).join(',') + '}', 'check_source_column_links')
      fields(c, { contype: 'c', connoinherit: false, conindid: '0', confrelid: '0', confkey: null, conpfeqop: null, conppeqop: null, conffeqop: null, confupdtype: ' ', confdeltype: ' ', confmatchtype: ' ' }, 'check_structure')
    }
  }
  equal(rows.fkOperators!.length, 12, 'foreign_key_operator_roster')
  for (const fk of descriptor.foreignKeys) {
    const parent = descriptor.tables.find(t => 'shared.' + t.name === fk.parent)!, constraint = one(rows.constraints!, { conname: fk.name }, 'foreign_key')
    for (const kind of ['parent_foreign', 'parent_parent', 'foreign_foreign']) {
      fk.referencedColumns.forEach((name, i) => {
        const column = parent.columns.find(x => x.name === name)!, typ = column.sqlType === 'text' ? 'text' : 'numeric'
        const op = object(operators.get('=(' + typ + ',' + typ + ')')!.fields), r = one(rows.fkOperators!, { conname: fk.name, kind, key_ordinal: String(i + 1) }, 'foreign_key_operator')
        fields(r, { constraint_oid: constraint.constraint_oid!, operator_oid: op.oid!, function_oid: resolveFunctionName(str(op.oprcode)), operator_schema: 'pg_catalog', operator_name: '=', left_type_schema: 'pg_catalog', left_type_name: typ, right_type_schema: 'pg_catalog', right_type_name: typ, result_type_schema: 'pg_catalog', result_type_name: 'bool' }, 'foreign_key_operator_link')
      })
    }
  }
  equal(rows.triggerLinks!.length, 8, 'trigger_roster')
  for (const fk of descriptor.foreignKeys) {
    const constraint = one(rows.constraints!, { conname: fk.name }, 'trigger_constraint')
    for (const [name, bits] of [['RI_FKey_check_ins','5'],['RI_FKey_check_upd','17'],['RI_FKey_restrict_del','9'],['RI_FKey_restrict_upd','17']]) {
      const r = one(rows.triggerLinks!, { constraint_name: fk.name, function_name: name! }, 'trigger_slot')
      const child = name!.startsWith('RI_FKey_check'), parent = child ? fk.child : fk.parent, other = child ? fk.parent : fk.child
      fields(r, { tgparentid: '0', tgtype: bits!, tgenabled: 'O', tgisinternal: true, tgdeferrable: false, tginitdeferred: false, tgconstraint: constraint.constraint_oid!, tgconstrrelid: relation(other).relation_oid!, tgconstrindid: relation('shared.' + fk.referencedIndex).relation_oid!, referenced_index: fk.referencedIndex, tgnargs: '0', args_hex: '', tgattr: '', qualifier: null, tgoldtable: null, tgnewtable: null, function_oid: resolveFunctionName(name!), function_schema: 'pg_catalog', relation_oid: relation(parent).relation_oid!, relation_schema: 'shared', relation_name: parent.slice(7), other_schema: 'shared', other_relation: other.slice(7), tgname: 'RI_ConstraintTrigger_' + (child ? 'c' : 'a') + '_' + str(r.trigger_oid) }, 'native_trigger')
    }
  }
}

function validateTypesToast(rows: Rows, binding: Binding, relation: (name: string) => Row, _nativeNamespace: string, sharedNamespace: string, toastNamespace: string, resolveFunctionName: (name: string) => string): void {
  const major = binding.profile.major, owner = binding.config.identity.roleOid
  equal(rows.nativeTypes!.length, major === '13' ? 9 : 6, 'native_type_roster')
  equal(rows.relationLinks!.length, 16, 'relation_link_roster')
  for (const t of SOURCE.descriptor.tables) {
    const heap = relation('shared.' + t.name), toast = relation('pg_toast.pg_toast_' + str(heap.relation_oid))
    for (const [schema, name, parent, array] of [
      ['shared', t.name, heap, false], ['shared', '_' + t.name, heap, true],
      ...(major === '13' ? [['pg_toast', str(toast.relname), toast, false]] : []),
    ] as [string, string, Row, boolean][]) {
      const found = rows.nativeTypes!.filter(x => x.schema_name === schema && object(x.fields).typname === name)
      requireThat(found.length === 1, 'native_type_identity')
      const r = found[0]!, f = object(r.fields), link = one(rows.relationLinks!, { relation_oid: parent.relation_oid! }, 'native_type_parent')
      const rowType = rows.nativeTypes!.find(x => x.schema_name === 'shared' && object(x.fields).typname === t.name)!
      const arrayType = rows.nativeTypes!.find(x => x.schema_name === 'shared' && object(x.fields).typname === '_' + t.name)!
      const callbackPrefix = array ? 'array' : 'record'
      const expected: Row = { oid: r.type_oid!, typname: name, typnamespace: schema === 'shared' ? sharedNamespace : toastNamespace, typowner: owner, typlen: '-1', typbyval: false, typtype: array ? 'b' : 'c', typcategory: array ? 'A' : 'C', typispreferred: false, typisdefined: true, typdelim: ',', typrelid: array ? '0' : parent.relation_oid!, typelem: array ? rowType.type_oid! : '0', typarray: schema === 'shared' && !array ? arrayType.type_oid! : '0', typinput: callbackPrefix + '_in', typoutput: callbackPrefix + '_out', typreceive: callbackPrefix + '_recv', typsend: callbackPrefix + '_send', typmodin: '-', typmodout: '-', typanalyze: array ? 'array_typanalyze' : '-', typalign: 'd', typstorage: 'x', typnotnull: false, typbasetype: '0', typtypmod: '-1', typndims: '0', typcollation: '0', typdefaultbin: null, typdefault: null, typacl: null }
      if (major === '17') expected.typsubscript = array ? 'array_subscript_handler' : '-'
      equal(f, expected, 'native_type_complete_fields')
      fields(r, { input_oid: resolveFunctionName(callbackPrefix + '_in'), output_oid: resolveFunctionName(callbackPrefix + '_out'), receive_oid: resolveFunctionName(callbackPrefix + '_recv'), send_oid: resolveFunctionName(callbackPrefix + '_send'), analyze_oid: array ? resolveFunctionName('array_typanalyze') : '0' }, 'native_type_callback_links')
      if (major === '17') equal(r.subscript_oid, array ? resolveFunctionName('array_subscript_handler') : '0', 'native_type_subscript_link')
      if (!array) equal(link.reltype, r.type_oid, 'native_type_relation_link')
    }
    if (major === '17') equal(one(rows.relationLinks!, { relation_oid: toast.relation_oid! }, 'pg17_toast').reltype, '0', 'pg17_no_toast_rowtype')
    for (const r of rows.relationLinks!.filter(x => x.relation_oid === heap.relation_oid || x.relation_oid === toast.relation_oid)) {
      equal(r.relnamespace, r.schema_name === 'shared' ? sharedNamespace : toastNamespace, 'relation_namespace_link')
      equal(r.reloftype, '0', 'no_typed_table')
      equal(r.relnatts, r.schema_name === 'shared' ? String(t.columns.length) : '3', 'relation_attribute_count')
    }
  }
  equal(rows.toastAllAttributes!.length, 15, 'toast_attribute_roster')
  const identities: unknown[] = []
  for (const r of rows.toastAllAttributes!) {
    const f = object(r.fields), ordinal = Number(f.attnum), heap = r.relkind === 't'
    requireThat(Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= (heap ? 3 : 2), 'toast_attribute_ordinal')
    const [name, type, length, byval] = [['chunk_id','oid','4',true],['chunk_seq','int4','4',true],['chunk_data','bytea','-1',false]][ordinal - 1]!
    const expected: Row = { attrelid: r.relation_oid!, attname: name!, atttypid: f.atttypid!, attstattarget: major === '13' ? '-1' : null, attlen: length!, attnum: String(ordinal), attndims: '0', attcacheoff: '-1', atttypmod: '-1', attbyval: byval!, attstorage: 'p', attalign: 'i', attnotnull: false, atthasdef: false, atthasmissing: false, attidentity: '', attgenerated: '', attisdropped: false, attislocal: true, attinhcount: '0', attcollation: '0', attacl: null, attoptions: null, attfdwoptions: null, attmissingval: null }
    if (major === '17') expected.attcompression = ''
    equal(f, expected, 'toast_attribute_complete_fields')
    const allAttribute = rows.allAttributes!.find(a => a.relation_oid === r.relation_oid && object(a.fields).attnum === f.attnum)
    requireThat(allAttribute, 'toast_full_attribute_link')
    equal(f, object(allAttribute.fields), 'toast_resolved_type_oid_link')
    fields(r, { type_schema: 'pg_catalog', type_name: type! }, 'toast_attribute_type')
    identities.push([r.relation_oid, f.attnum])
  }
  const expectedAttrs = rows.relationStorage!.filter(r => r.schema_name === 'pg_toast').flatMap(r => Array.from({ length: r.relkind === 't' ? 3 : 2 }, (_v, i) => [r.relation_oid, String(i + 1)]))
  equal(sorted(identities), sorted(expectedAttrs), 'toast_attribute_positive_negative_roster')
}

function validatePrivileges(rows: Rows, binding: Binding, nativeOwner: string): void {
  const owner = binding.config.identity.roleOid, major = binding.profile.major
  const expectedAcls: unknown[] = []
  const privileges = ['INSERT','SELECT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER', ...(major === '17' ? ['MAINTAIN'] : [])]
  for (const r of rows.relationStorage!.filter(r => r.relkind === 'r' || r.relkind === 't')) for (const p of privileges) expectedAcls.push(['relation',r.relation_oid,owner,owner,owner,p,false])
  // Native NULL type ACL is PUBLIC USAGE plus owner USAGE, never an empty set.
  for (const r of rows.nativeTypes!) for (const grantee of ['0', owner]) expectedAcls.push(['type',r.type_oid,owner,owner,grantee,'USAGE',false])
  roster(rows.acl!, expectedAcls, r => [r.kind,r.object_oid,r.owner_oid,r.grantor,r.grantee,r.privilege_type,r.is_grantable], 'effective_acl')
  const expectedNamespaces: unknown[] = []
  for (const r of rows.namespacesAndSettings!) {
    const nOwner = r.nspname === 'shared' ? owner : nativeOwner
    for (const p of ['CREATE','USAGE']) expectedNamespaces.push([r.namespace_oid,r.nspname,nOwner,nOwner,nOwner,p,false])
    if (r.nspname === 'pg_catalog') expectedNamespaces.push([r.namespace_oid,r.nspname,nOwner,nOwner,'0','USAGE',false])
  }
  roster(rows.namespaces!, expectedNamespaces, r => [r.oid,r.nspname,r.nspowner,r.grantor,r.grantee,r.privilege_type,r.is_grantable], 'effective_namespace_acl')
  equal(rows.databaseTablespace!.length, 1, 'database_tablespace_roster')
  fields(rows.databaseTablespace![0]!, { database_oid: binding.config.identity.databaseOid, datdba: owner, datallowconn: true, datistemplate: false, datconnlimit: '-1', dattablespace: binding.config.tablespace.oid, spcname: binding.config.tablespace.name, spcowner: binding.config.tablespace.ownerOid, spcacl: null, spcoptions: null }, 'database_tablespace')
  roster(rows.databaseAcl!, [
    ...['CREATE','CONNECT','TEMPORARY'].map(p => [owner,owner,owner,p,false]),
    ...['CONNECT','TEMPORARY'].map(p => [owner,owner,'0',p,false]),
  ], r => [r.owner_oid,r.grantor,r.grantee,r.privilege_type,r.is_grantable], 'effective_database_acl')
  equal(rows.defaultAcls!, [], 'default_acl')
  const roles = rows.roles!.map(r => object(r.fields))
  const admin = one(roles, { oid: owner }, 'configured_admin_role')
  fields(admin, { rolname: binding.config.identity.role, rolsuper: true, rolinherit: true, rolcreaterole: true, rolcreatedb: true, rolcanlogin: true, rolreplication: true, rolbypassrls: true, rolconnlimit: '-1', rolconfig: null, rolvaliduntil: null }, 'configured_admin_role_fields')
  for (const r of roles) {
    if (r.oid === owner || r.oid === nativeOwner) continue
    requireThat(r.rolsuper === false && r.rolcreaterole === false && r.rolreplication === false && r.rolbypassrls === false && ['pg_read_all_data','pg_write_all_data','pg_maintain'].includes(str(r.rolname)), 'unexpected_privileged_role')
    fields(r, { rolcanlogin: false, rolinherit: true, rolcreatedb: false, rolconnlimit: '-1', rolconfig: null, rolvaliduntil: null }, 'native_broad_role_fields')
  }
  // All membership edges are inspected, so transitive SET/INHERIT chains cannot
  // hide behind direct owner-only ACLs. Only initdb's monitor edges are allowed.
  for (const r of rows.memberships!) {
    const f = object(r.fields)
    requireThat(r.member_name === 'pg_monitor' && ['pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables'].includes(str(r.role_name)), 'effective_role_membership')
    fields(f, { admin_option: false, grantor: nativeOwner }, 'native_monitor_membership')
    if (major === '17') fields(f, { inherit_option: true, set_option: true }, 'native_membership_options')
    exactKeys(f, ['roleid','member','grantor','admin_option', ...(major === '17' ? ['oid','inherit_option','set_option'] : [])], 'membership_field_coverage')
  }
  roster(rows.memberships!, ['pg_read_all_settings','pg_read_all_stats','pg_stat_scan_tables'], r => r.role_name, 'native_monitor_memberships')
}

function validateDependencies(rows: Rows, binding: Binding, relation: (name: string) => Row): void {
  const expected: unknown[] = []
  const dep = (cls: string, id: Json, sub: string, ref: string, refId: Json, refSub: string, kind: string): void => { expected.push([cls,id,sub,ref,refId,refSub,kind]) }
  const ns = one(rows.namespacesAndSettings!, { nspname: 'shared' }, 'dependency_namespace').namespace_oid!
  for (const table of SOURCE.descriptor.tables) {
    const heap = relation('shared.' + table.name), toast = relation('pg_toast.pg_toast_' + str(heap.relation_oid)), toastIndex = relation('pg_toast.' + str(toast.relname) + '_index')
    dep('pg_class', heap.relation_oid!, '0', 'pg_namespace', ns, '0', 'n')
    dep('pg_class', toast.relation_oid!, '0', 'pg_class', heap.relation_oid!, '0', 'i')
    for (const pos of ['1','2']) dep('pg_class', toastIndex.relation_oid!, '0', 'pg_class', toast.relation_oid!, pos, 'a')
    const types = rows.nativeTypes!.filter(t => object(t.fields).typrelid === heap.relation_oid || object(t.fields).typrelid === toast.relation_oid)
    for (const t of types) dep('pg_type', t.type_oid!, '0', 'pg_class', object(t.fields).typrelid!, '0', 'i')
    const rowtype = one(rows.nativeTypes!, { type_oid: one(rows.relationLinks!, { relation_oid: heap.relation_oid! }, 'dep_row_type').reltype! }, 'dep_row_type')
    const array = rows.nativeTypes!.find(t => object(t.fields).typelem === rowtype.type_oid)
    requireThat(array, 'dep_array_type')
    dep('pg_type', array.type_oid!, '0', 'pg_type', rowtype.type_oid!, '0', 'i')
    for (const c of rows.constraints!.filter(c => c.relname === table.name)) {
      const conkey = str(c.conkey).slice(1,-1).split(',').filter(Boolean)
      if (c.contype === 'c') {
        for (const pos of conkey) {
          dep('pg_constraint', c.constraint_oid!, '0', 'pg_class', heap.relation_oid!, pos, 'a')
          dep('pg_constraint', c.constraint_oid!, '0', 'pg_class', heap.relation_oid!, pos, 'n')
        }
      } else {
        for (const pos of conkey) dep('pg_constraint', c.constraint_oid!, '0', 'pg_class', heap.relation_oid!, pos, 'a')
        if (c.contype === 'f') {
          dep('pg_constraint', c.constraint_oid!, '0', 'pg_class', c.conindid!, '0', 'n')
          for (const pos of str(c.confkey).slice(1,-1).split(',')) dep('pg_constraint', c.constraint_oid!, '0', 'pg_class', c.confrelid!, pos, 'n')
        } else dep('pg_class', c.conindid!, '0', 'pg_constraint', c.constraint_oid!, '0', 'i')
      }
    }
  }
  for (const idx of SOURCE.descriptor.indexes.filter(i => !i.constraintName)) {
    const table = SOURCE.descriptor.tables.find(t => t.name === idx.table)!
    for (const name of idx.keys) dep('pg_class', relation('shared.' + idx.name).relation_oid!, '0', 'pg_class', relation('shared.' + idx.table).relation_oid!, String(table.columns.findIndex(c => c.name === name) + 1), 'a')
  }
  for (const t of rows.triggerLinks!) dep('pg_trigger', t.trigger_oid!, '0', 'pg_constraint', t.tgconstraint!, '0', 'i')
  roster(rows.dependencies!, expected, r => [r.class_name,r.objid,r.objsubid,r.ref_class,r.refobjid,r.refobjsubid,r.deptype], 'complete_dependency_graph')
  // Object owners must be exact; no extra ACL/security/extension/tablespace role
  // dependency may enter this slice. Native TOAST follows its parent's owner.
  const sharedExpected: unknown[] = []
  for (const r of rows.relationStorage!) if (binding.config.identity.roleOid !== binding.profile.nativeBootstrapOwnerOid && r.schema_name === 'shared' && r.relkind === 'r') sharedExpected.push(['pg_class',r.relation_oid,'0','pg_authid',binding.config.identity.roleOid,'o'])
  // Dependent composite/array types and indexes inherit ownership; pinned
  // bootstrap owner references are omitted natively on both supported profiles.
  roster(rows.sharedDependencies!, sharedExpected, r => [r.class_name,r.objid,r.objsubid,r.ref_class,r.refobjid,r.deptype], 'complete_shared_dependency_graph')
}

function validateAllAttributes(rows: Rows, binding: Binding): void {
  const expectedKeys: unknown[] = []
  const descriptor = SOURCE.descriptor, major = binding.profile.major
  const typeNames: Record<string, string> = { text: 'text', 'numeric(30,0)': 'numeric', 'uuid[]': '_uuid', uuid: 'uuid', integer: 'int4', boolean: 'bool', 'timestamp with time zone': 'timestamptz', jsonb: 'jsonb' }
  for (const relation of rows.relationStorage!) {
    const toast = relation.schema_name === 'pg_toast', index = relation.relkind === 'i'
    const idx = descriptor.indexes.find(i => i.name === relation.relname)
    const table = descriptor.tables.find(t => t.name === (index ? idx?.table : relation.relname))
    requireThat(toast || table, 'attribute_relation')
    const names = toast ? (index ? ['chunk_id','chunk_seq'] : ['chunk_id','chunk_seq','chunk_data']) : index ? idx!.keys : table!.columns.map(c => c.name)
    const relationLink = one(rows.relationLinks!, { relation_oid: relation.relation_oid! }, 'all_relation_link')
    const namespace = one(rows.namespacesAndSettings!, { nspname: relation.schema_name! }, 'all_relation_namespace').namespace_oid!
    fields(relationLink, { relname: relation.relname!, schema_name: relation.schema_name!, relnamespace: namespace, relnatts: String(names.length), reloftype: '0', reltoastrelid: relation.reltoastrelid!, relam: relation.access_method_oid! }, 'all_relation_source_links')
    if (index) equal(relationLink.reltype, '0', 'index_has_no_rowtype')
    names.forEach((name, i) => expectedKeys.push([relation.relation_oid,String(i + 1),name]))
    for (const [i, name] of names.entries()) {
      const found = rows.allAttributes!.filter(x => x.relation_oid === relation.relation_oid && object(x.fields).attnum === String(i + 1))
      requireThat(found.length === 1, 'attribute_slot')
      const a = found[0]!, f = object(a.fields), column = table?.columns.find(c => c.name === name)
      const typ = toast ? ({ chunk_id: 'oid', chunk_seq: 'int4', chunk_data: 'bytea' } as Record<string,string>)[name]! : typeNames[column!.sqlType]!
      const shape = binding.profile.intrinsicAttributeTypes[typ]
      requireThat(shape, 'attribute_source_type')
      const collation = !toast && column!.collation === 'pg_catalog.C' ? rows.collations![0]!.collation_oid! : '0'
      fields(a, { type_schema: 'pg_catalog', type_name: typ }, 'attribute_type_identity')
      const expected: Row = { attrelid: relation.relation_oid!, attname: name, atttypid: a.type_oid!, attstattarget: index || toast ? (major === '13' ? '-1' : null) : String(column!.statisticsTarget), attlen: shape.length, attnum: String(i + 1), attndims: typ === '_uuid' ? '1' : '0', attcacheoff: '-1', atttypmod: typ === 'numeric' ? '1966084' : '-1', attbyval: shape.byval, attstorage: toast ? 'p' : shape.storage, attalign: shape.alignment, attnotnull: !index && !toast && !column!.nullable, atthasdef: false, atthasmissing: false, attidentity: '', attgenerated: '', attisdropped: false, attislocal: true, attinhcount: '0', attcollation: collation, attacl: null, attoptions: null, attfdwoptions: null, attmissingval: null }
      if (major === '17') expected.attcompression = ''
      equal(f, expected, 'all_attribute_complete_fields')
    }
  }
  roster(rows.allAttributes!, expectedKeys, r => [r.relation_oid,object(r.fields).attnum,object(r.fields).attname], 'all_attribute_slots')
}

function validateNativeDependencies(rows: Rows, binding: Binding): void {
  const objects = rows.nativeObjects!, major = binding.profile.major
  const expected = objects.map(o => ['-','0','0',o.class_name,o.object_oid,'0','p'])
  if (major === '13') {
    roster(rows.nativeDependencies!, expected, r => [r.class_name,r.objid,r.objsubid,r.ref_class,r.refobjid,r.refobjsubid,r.deptype], 'native_pin_dependency_graph')
    equal(rows.nativeOwnerPins!, [{ dbid: '0', classid: '0', objid: '0', objsubid: '0', ref_class: 'pg_authid', refobjid: binding.profile.nativeBootstrapOwnerOid, deptype: 'p' }], 'native_owner_pin')
  } else {
    equal(rows.nativeDependencies!, [], 'native_pin_dependency_graph')
    equal(rows.nativeOwnerPins!, [], 'native_owner_pin')
    for (const o of objects) requireThat(DECIMAL.test(str(o.object_oid)) && BigInt(str(o.object_oid)) < 12000n, 'pg17_source_pinned_oid_range')
  }
  const sourceTypeNames = new Set(Object.values({ ...binding.profile.native.functions, ...binding.profile.checkReferences.functions }).flatMap(f => [...f.proargtypes!.split(' ').filter(Boolean), f.prorettype!]))
  for (const t of SOURCE.descriptor.tables) for (const c of t.columns) sourceTypeNames.add(({ 'uuid[]': '_uuid', 'numeric(30,0)': 'numeric', integer: 'int4', boolean: 'bool', 'timestamp with time zone': 'timestamptz' } as Record<string,string>)[c.sqlType] ?? c.sqlType)
  roster(rows.nativeTypeIdentities!, [...sourceTypeNames], r => r.typname, 'builtin_type_identity_roster')
  const catalogNamespace = one(rows.namespacesAndSettings!, { nspname: 'pg_catalog' }, 'builtin_type_namespace').namespace_oid!
  for (const t of rows.nativeTypeIdentities!) {
    fields(t, { schema_name: 'pg_catalog', typowner: binding.profile.nativeBootstrapOwnerOid, typnamespace: catalogNamespace }, 'builtin_type_owner_identity')
    one(objects, { class_name: 'pg_type', object_oid: t.type_oid! }, 'builtin_type_oid_link')
  }
  const counts = new Map<string, number>()
  for (const o of objects) counts.set(str(o.class_name), (counts.get(str(o.class_name)) ?? 0) + 1)
  const sourceFunctions = new Set([...Object.keys(binding.profile.native.functions), ...Object.keys(binding.profile.checkReferences.functions)])
  const sourceOperators = new Set([...Object.keys(binding.profile.operators), ...Object.keys(binding.profile.checkReferences.operators)])
  for (const [kind, expectedCount] of [['pg_proc',sourceFunctions.size],['pg_opclass',5],['pg_opfamily',5],['pg_operator',sourceOperators.size],['pg_am',2],['pg_collation',1],['pg_namespace',2],['pg_type',sourceTypeNames.size]] as const) equal(counts.get(kind), expectedCount, 'native_object_roster/' + kind)
}

function validateRawCatalogs(rows: Rows, binding: Binding): void {
  roster(rows.rawTriggers!, rows.triggerLinks!.map(r => r.trigger_oid), r => r.trigger_oid, 'raw_trigger_two_way_roster')
  for (const r of rows.rawTriggers!) {
    const f = object(r.fields), t = one(rows.triggerLinks!, { trigger_oid: r.trigger_oid! }, 'raw_trigger_link')
    equal(f, { oid: t.trigger_oid, tgrelid: t.relation_oid, tgname: t.tgname, tgfoid: t.function_oid, tgtype: t.tgtype, tgenabled: 'O', tgisinternal: true, tgparentid: '0', tgconstrrelid: t.tgconstrrelid, tgconstrindid: t.tgconstrindid, tgconstraint: t.tgconstraint, tgdeferrable: false, tginitdeferred: false, tgnargs: '0', tgattr: [], tgargs: '\\x', tgqual: null, tgoldtable: null, tgnewtable: null }, 'complete_raw_trigger_fields')
  }
  roster(rows.rawConstraints!, rows.constraints!.map(r => r.constraint_oid), r => r.constraint_oid, 'raw_constraint_two_way_roster')
  const shared = one(rows.namespacesAndSettings!, { nspname: 'shared' }, 'raw_constraint_namespace').namespace_oid!
  for (const r of rows.rawConstraints!) {
    const f = object(r.fields), c = one(rows.constraints!, { constraint_oid: r.constraint_oid! }, 'raw_constraint_link')
    const expectedKeys = ['oid','conname','connamespace','contype','condeferrable','condeferred','convalidated','conrelid','contypid','conindid','conparentid','confrelid','confupdtype','confdeltype','confmatchtype','conislocal','coninhcount','connoinherit','conkey','confkey','conpfeqop','conppeqop','conffeqop','conexclop','conbin']
    if (binding.profile.major === '17') expectedKeys.push('confdelsetcols')
    exactKeys(f, expectedKeys, 'complete_raw_constraint_fields')
    if (binding.profile.major === '17') equal(f.confdelsetcols, null, 'pg17_foreign_key_set_columns')
    fields(f, { oid: c.constraint_oid!, conname: c.conname!, connamespace: shared, contype: c.contype!, condeferrable: false, condeferred: false, convalidated: true, conrelid: c.conrelid!, contypid: '0', conindid: c.conindid!, conparentid: '0', confrelid: c.confrelid!, confupdtype: c.confupdtype!, confdeltype: c.confdeltype!, confmatchtype: c.confmatchtype!, conislocal: true, coninhcount: '0', connoinherit: c.connoinherit!, conexclop: null }, 'raw_constraint_properties')
    for (const key of ['conkey','confkey','conpfeqop','conppeqop','conffeqop']) {
      const val = c[key]
      equal(f[key], val === null ? null : str(val).slice(1,-1).split(',').filter(Boolean), 'raw_constraint_array_links')
    }
    if (c.contype === 'c') requireThat(typeof f.conbin === 'string' && f.conbin.length > 0, 'raw_check_expression')
    else equal(f.conbin, null, 'raw_noncheck_expression')
  }
  roster(rows.rawRelations!, rows.relationStorage!.map(r => r.relation_oid), r => r.relation_oid, 'raw_relation_two_way_roster')
  for (const r of rows.rawRelations!) {
    const f = object(r.fields), c = one(rows.relationStorage!, { relation_oid: r.relation_oid! }, 'raw_relation_link'), link = one(rows.relationLinks!, { relation_oid: r.relation_oid! }, 'raw_relation_link')
    const runtime = ['relfilenode','relpages','reltuples','relallvisible','relfrozenxid','relminmxid']
    const expected: Row = { oid: r.relation_oid!, relname: c.relname!, relnamespace: link.relnamespace!, reltype: link.reltype!, reloftype: '0', relowner: c.owner_oid!, relam: c.access_method_oid!, reltablespace: '0', reltoastrelid: c.reltoastrelid!, relhasindex: c.relkind !== 'i', relisshared: false, relpersistence: 'p', relkind: c.relkind!, relnatts: link.relnatts!, relchecks: c.relchecks!, relhasrules: false, relhastriggers: c.relhastriggers!, relhassubclass: false, relrowsecurity: false, relforcerowsecurity: false, relispopulated: true, relreplident: c.relreplident!, relispartition: false, relrewrite: '0', relacl: c.relacl!, reloptions: c.reloptions!, relpartbound: null }
    exactKeys(f, [...Object.keys(expected), ...runtime], 'complete_raw_relation_fields')
    fields(f, expected, 'raw_relation_properties')
    for (const key of runtime) requireThat(typeof f[key] === 'string', 'physical_runtime_field/' + key)
  }
  for (const r of rows.roles!) exactKeys(object(r.fields), ['oid','rolname','rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolcanlogin','rolreplication','rolconnlimit','rolvaliduntil','rolbypassrls','rolconfig'], 'complete_role_fields')
}

function validateCheckReferences(rows: Rows, binding: Binding): void {
  const p = binding.profile, namespace = one(rows.namespacesAndSettings!, { nspname: 'pg_catalog' }, 'check_native_namespace')
  roster(rows.checkFunctionReferences!, Object.keys(p.checkReferences.functions), r => str(r.schema_name) + '.' + str(r.proname) + '(' + list(r.argument_types).map(v => str(v)).join(',') + ')', 'check_native_function_references')
  const bySourceName = new Map<string,string>()
  for (const r of rows.checkFunctionReferences!) {
    one(rows.nativeObjects!, { class_name: 'pg_proc', object_oid: r.function_oid! }, 'check_function_native_oid_link')
    const signature = str(r.schema_name) + '.' + str(r.proname) + '(' + list(r.argument_types).map(v => str(v)).join(',') + ')'
    const expected = p.checkReferences.functions[signature]!
    fields(r, { proowner: p.nativeBootstrapOwnerOid, pronamespace: namespace.namespace_oid!, language: expected.prolang!, result_type: 'pg_catalog.' + expected.prorettype! }, 'check_native_function_identity')
    bySourceName.set(expected.proname!, str(r.function_oid))
  }
  roster(rows.checkOperatorReferences!, Object.keys(p.checkReferences.operators).map(key => 'pg_catalog.' + key.replace('(', '(pg_catalog.').replace(',', ',pg_catalog.')), r => str(r.schema_name) + '.' + str(r.oprname) + '(' + str(r.left_type) + ',' + str(r.right_type) + ')', 'check_native_operator_references')
  for (const r of rows.checkOperatorReferences!) {
    one(rows.nativeObjects!, { class_name: 'pg_operator', object_oid: r.operator_oid! }, 'check_operator_native_oid_link')
    const key = str(r.oprname) + '(' + str(r.left_type).slice(11) + ',' + str(r.right_type).slice(11) + ')', expected = p.checkReferences.operators[key]!
    fields(r, { oprowner: p.nativeBootstrapOwnerOid, oprnamespace: namespace.namespace_oid!, result_type: 'pg_catalog.' + expected.oprresult!, function_oid: bySourceName.get(expected.oprcode!.split('(')[0]!)! }, 'check_native_operator_identity_link')
  }
}
