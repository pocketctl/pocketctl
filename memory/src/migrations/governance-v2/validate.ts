import {assertMigrationOpen} from '../../retention/transaction.js'
import type pg from 'pg'
import {decodeMigrationBaseline} from './baseline-snapshot.js'
import {migrationTransaction,migrationRows,preservedBody,BACKFILL_FAMILIES,type MigrationBaseline} from './backfill.js'
import {automationHash} from '../../governance/automation-policy.js'
const immutable=['knowledge_versions','knowledge_evidence','knowledge_evidence_capsules','memory_promotion_candidate_versions','memory_promotion_evidence','memory_authority_records','memory_review_policy_versions','memory_review_decisions','memory_review_automation_policies','memory_review_automation_runs','memory_review_automation_decisions']

/** Durable identity checks do not need to materialize/hash source payloads.
 * All previously checked immutable body families still use their exact hash. */
async function captureValidationRows(c:pg.PoolClient,installationIds:string[]):Promise<MigrationBaseline['rows']>{
 const rows:MigrationBaseline['rows']={}
 for(const table of BACKFILL_FAMILIES){
  rows[table]={};let after=''
  while(true){
   const batch=await migrationRows(c,table,installationIds,after,200,!immutable.includes(table))
   for(const row of batch)rows[table][row.id]=immutable.includes(table)?automationHash(preservedBody(table,row.row)):'present'
   if(batch.length<200)break
   after=batch.at(-1)!.id
  }
 }
 return rows
}
export interface MigrationChangeStamp {count:string;maximum:string}
export interface MigrationSealProof {runXmin:string;installationIds:string[];startWatermark:string;changes:MigrationChangeStamp}
export interface MigrationValidation {invariants:{number:number;name:string;passed:boolean}[];counts:{updated:number;unchanged:number;quarantined:number;retry:number};violations:string[];lifecycle:{transientJobsMissing:number;sourceEventsPurged:number};sealProof?:MigrationSealProof}
/** Count detects a late commit with an already allocated sequence below MAX.
 * Open migrations protect this complete overlap from normal change-log GC. */
export async function migrationChangeStamp(c:Pick<pg.PoolClient,'query'>,installationIds:string[],startWatermark:string):Promise<MigrationChangeStamp>{
 return (await c.query(`SELECT count(*)::text AS count,COALESCE(max(sequence),0)::text AS maximum
  FROM memory_governance_migration_changes WHERE installation_id=ANY($1::uuid[]) AND sequence>$2::bigint`,[installationIds,startWatermark])).rows[0]
}
export async function validateGovernanceMigration(pool:pg.Pool,runId:string,options:{prepareSeal?:boolean;readOnly?:boolean}={}):Promise<MigrationValidation>{return migrationTransaction(pool,async c=>{
 if(options.readOnly){
  if(!(await c.query('SELECT 1 FROM memory_governance_migration_runs WHERE run_id=$1 AND sealed_at IS NULL AND abandoned_at IS NULL AND details_reclaimed_at IS NULL',[runId])).rowCount)throw new Error('migration_run_not_resumable')
 }else await assertMigrationOpen(c,runId)
 const run=(await c.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0];if(!run)throw new Error('migration_run_missing')
 const before=decodeMigrationBaseline(run.manifest),after={rows:await captureValidationRows(c,before.installationIds)}
 const purged=new Set((await c.query("SELECT installation_id FROM memory_installations WHERE local_status='purged'")).rows.map(i=>i.installation_id))
 const explicitlyPurged=(table:string,id:string)=>{const owners=before.owners?.[table]?.[id]??[];return owners.length>0&&owners.every(i=>purged.has(i))}
 const missingSources=Object.keys(before.rows.source_events??{}).filter(id=>!after.rows.source_events?.[id]&&!explicitlyPurged('source_events',id))
 const sourceIds=missingSources.flatMap(id=>{try{const key=JSON.parse(id);return Array.isArray(key)&&key.length===1&&typeof key[0]==='string'?[key[0]]:[]}catch{return []}})
 const deleted=new Set<string>()
 if(sourceIds.length){
  // A raw DELETE receipt is insufficient: require the same committed purge
  // transaction to have inserted a still-present session tombstone in this
  // installation. Never admit cross-scope or unrelated/old tombstones.
  const proofs=await c.query(`WITH purges AS MATERIALIZED(
   SELECT DISTINCT t.installation_id,t.transaction_id FROM memory_governance_migration_changes t
   JOIN memory_session_tombstones s ON s.installation_id=t.installation_id AND s.session_id=(t.entity_id::jsonb->>'session_id')
   WHERE t.entity_kind='memory_session_tombstones' AND t.operation='INSERT' AND t.transaction_id IS NOT NULL
    AND t.installation_id=ANY($1::uuid[]) AND t.sequence>$2::bigint)
   SELECT d.installation_id,d.entity_id::jsonb->>'source_event_id' AS source_id FROM memory_governance_migration_changes d
   JOIN purges p ON p.installation_id=d.installation_id AND p.transaction_id=d.transaction_id
   WHERE d.entity_kind='source_events' AND d.operation='DELETE' AND d.sequence>$2::bigint
    AND d.installation_id=ANY($1::uuid[]) AND d.entity_id::jsonb->>'source_event_id'=ANY($3::text[])`,
  [before.installationIds,before.startWatermark,sourceIds])
  for(const row of proofs.rows)deleted.add(`${row.installation_id}:${row.source_id}`)
 }
 const lifecycle={transientJobsMissing:0,sourceEventsPurged:0}
 const lifecycleDeleted=(table:string,id:string)=>{
  const owners=before.owners?.[table]?.[id]??[]
  if(!owners.length||!owners.every(i=>before.installationIds.includes(i)))return false
  // Jobs are a transient queue (completed 24h / dead 7d), explicitly outside
  // governance change capture. Its IDs cannot be durable historical evidence;
  // original classification and the current writer/unique-domain checks stay.
  if(table==='memory_jobs'){lifecycle.transientJobsMissing++;return true}
  if(table==='source_events'){
   try{const key=JSON.parse(id);if(key.length===1&&owners.every(i=>deleted.has(`${i}:${key[0]}`))){lifecycle.sourceEventsPurged++;return true}}catch{}
  }
  return false
 }
 let ids=true,bodies=true
 for(const [table,rows] of Object.entries(before.rows))for(const [id,hash] of Object.entries(rows)){if(!after.rows[table]?.[id]){if(!explicitlyPurged(table,id)&&!lifecycleDeleted(table,id))ids=false;}else if(immutable.includes(table)&&after.rows[table][id]!==hash)bodies=false}
 const counts={updated:0,unchanged:0,quarantined:0,retry:0}
 for(const r of (await c.query('SELECT action,COUNT(*)::int n FROM memory_governance_migration_actions WHERE run_id=$1 GROUP BY action',[runId])).rows)counts[r.action as keyof typeof counts]=r.n
 const actions=(await c.query("SELECT entity_kind,change_summary->>'recordId' AS id FROM memory_governance_migration_actions WHERE run_id=$1",[runId])).rows
 const classified=new Set(actions.map(a=>`${a.entity_kind}:${a.id}`))
 const covered=Object.entries(before.rows).every(([table,rows])=>Object.keys(rows).every(id=>classified.has(`${table}:${id}`)||explicitlyPurged(table,id)))
 const unresolved=Number((await c.query("SELECT COUNT(*)::int n FROM memory_governance_migration_actions WHERE run_id=$1 AND action='retry' AND NOT(change_summary?'resolved_by')",[runId])).rows[0].n)
 const bad=async(sql:string)=>Number((await c.query(sql,[before.installationIds])).rows[0].n)>0
 const pointers=await bad(`SELECT COUNT(*)::int n FROM knowledge_claims c WHERE c.installation_id=ANY($1::uuid[]) AND c.state='active' AND NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id)`)
 const intervals=await bad(`SELECT COUNT(*)::int n FROM knowledge_versions a JOIN knowledge_versions b ON a.installation_id=b.installation_id AND a.claim_id=b.claim_id AND a.version_number<b.version_number WHERE a.installation_id=ANY($1::uuid[]) AND a.effective_from IS NOT NULL AND b.effective_from IS NOT NULL AND tstzrange(a.effective_from,a.effective_until,'[)')&&tstzrange(b.effective_from,b.effective_until,'[)')`)
 const unknown=await bad(`SELECT COUNT(*)::int n FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id WHERE c.installation_id=ANY($1::uuid[]) AND c.state='active' AND c.consumption_hold_reason IS NULL AND (c.normalized_key_v2 IS NULL OR c.duplicate_digest_v2 IS NULL OR v.applicability IS NULL OR v.applicability->>'status'<>'verified')`)
 const revoked=await bad(`SELECT COUNT(*)::int n FROM knowledge_claims c JOIN memory_installations i USING(installation_id) LEFT JOIN memory_owner_scopes s USING(installation_id) WHERE c.installation_id=ANY($1::uuid[]) AND c.state='active' AND c.consumption_hold_reason IS NULL AND (i.local_status IN('purging','purged','integrity_error') OR i.relay_status IN('revoking','revoked') OR s.state<>'active')`)
 const generation=await bad(`SELECT COUNT(*)::int n FROM memory_governance_v2_states s JOIN knowledge_claims c USING(installation_id) WHERE s.installation_id=ANY($1::uuid[]) AND s.identity_generation=2 AND c.state='active' AND c.consumption_hold_reason IS NULL AND c.identity_generation<>2`)
 const protectedIndex=(await c.query(`SELECT COUNT(*)::int n FROM pg_index WHERE indexrelid IN(to_regclass('knowledge_claims_active_identity_v1_idx'),to_regclass('knowledge_claims_active_identity_v2_idx')) AND indisvalid AND indisunique`)).rows[0].n===2
 const names=['historical_ids_retained','all_scans_classified','original_body_hashes_retained','revoked_sources_not_readmitted','current_pointer_and_intervals','unknown_inputs_held','v2_writer_unique_domain']
 const passes=[ids,covered&&unresolved===0,bodies,!revoked,!pointers&&!intervals,!unknown,!generation&&protectedIndex]
 const invariants=names.map((name,i)=>({number:i+1,name,passed:passes[i]})),violations=invariants.filter(i=>!i.passed).map(i=>i.name)
 if(!violations.length&&!options.readOnly)await c.query("UPDATE memory_governance_migration_runs SET state='validated' WHERE run_id=$1",[runId])
 const sealProof=options.prepareSeal&&!options.readOnly&&!violations.length?{
  runXmin:(await c.query('SELECT xmin::text AS revision FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0].revision,
  installationIds:before.installationIds,startWatermark:before.startWatermark,
  changes:await migrationChangeStamp(c,before.installationIds,before.startWatermark),
 }:undefined
 return {invariants,counts,violations,lifecycle,...(sealProof?{sealProof}:{})}
},{repeatableRead:options.prepareSeal,readOnly:options.readOnly})}
