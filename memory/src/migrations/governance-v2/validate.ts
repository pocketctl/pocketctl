import type pg from 'pg'
import {decodeMigrationBaseline} from './baseline-snapshot.js'
import {migrationTransaction,captureMigrationBaseline,type MigrationBaseline} from './backfill.js'
export interface MigrationValidation {invariants:{number:number;name:string;passed:boolean}[];counts:{updated:number;unchanged:number;quarantined:number;retry:number};violations:string[]}
export async function validateGovernanceMigration(pool:pg.Pool,runId:string):Promise<MigrationValidation>{return migrationTransaction(pool,async c=>{
 const run=(await c.query('SELECT manifest FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0];if(!run)throw new Error('migration_run_missing')
 const before=decodeMigrationBaseline(run.manifest),after=await captureMigrationBaseline(c,before.installationIds)
 const immutable=['knowledge_versions','knowledge_evidence','knowledge_evidence_capsules','memory_promotion_candidate_versions','memory_promotion_evidence','memory_authority_records','memory_review_policy_versions','memory_review_decisions','memory_review_automation_policies','memory_review_automation_runs','memory_review_automation_decisions']
 const purged=new Set((await c.query("SELECT installation_id FROM memory_installations WHERE local_status='purged'")).rows.map(i=>i.installation_id))
 const explicitlyPurged=(table:string,id:string)=>{const owners=before.owners?.[table]?.[id]??[];return owners.length>0&&owners.every(i=>purged.has(i))}
 let ids=true,bodies=true
 for(const [table,rows] of Object.entries(before.rows))for(const [id,hash] of Object.entries(rows)){if(!after.rows[table]?.[id]){if(!explicitlyPurged(table,id))ids=false;}else if(immutable.includes(table)&&after.rows[table][id]!==hash)bodies=false}
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
 if(!violations.length)await c.query("UPDATE memory_governance_migration_runs SET state='validated' WHERE run_id=$1",[runId])
 return {invariants,counts,violations}
})}
