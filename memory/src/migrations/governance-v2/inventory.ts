import {createHash,randomUUID} from 'node:crypto'
import type pg from 'pg'
import {canonicalReviewPolicyHash,parseReviewPolicyDocument} from '../../governance/review-policy.js'
import {MEMORY_MIGRATIONS} from '../../schema.js'
import type {MigrationInventoryManifest,MigrationInventoryItem,FindingCertainty,ScopeObservation,TeamSourceObservation} from './manifest.js'
export interface InventoryOptions {onFindingBatch?:(items:MigrationInventoryItem[])=>Promise<void>;onScopeBatch?:(items:ScopeObservation[])=>Promise<void>;onTeamSourceBatch?:(items:TeamSourceObservation[])=>Promise<void>}
const tables={claims:'knowledge_claims',versions:'knowledge_versions',evidence:'knowledge_evidence',capsules:'knowledge_evidence_capsules',proposals:'memory_promotion_candidates',proposalRevisions:'memory_promotion_candidate_versions',decisions:'memory_review_decisions',authorityRecords:'memory_authority_records',jobs:'memory_jobs',feedback:'memory_feedback',contextPacks:'memory_context_packs',tombstones:'knowledge_tombstones',installations:'memory_installations',repositories:'repositories',snapshots:'repo_snapshots',episodes:'work_episodes',sourceEvents:'source_events',searchDocuments:'claim_search_documents',wikiVersions:'memory_wiki_versions',skillVersions:'memory_skill_versions',gitRevisionLinks:'memory_git_revision_links',featureSettings:'memory_feature_settings',sessionTombstones:'memory_session_tombstones',repositoryTombstones:'memory_repository_tombstones',snapshotTombstones:'memory_source_snapshot_tombstones'} as const
/** Independent consistent read-only snapshot. No startup, model call, or authority write. */
export async function inventoryMemory(pool:pg.Pool,options:InventoryOptions={}):Promise<MigrationInventoryManifest>{
 const started=performance.now(),client=await pool.connect()
 const manifest:MigrationInventoryManifest={schemaVersion:0,compatible:false,blockers:[],runId:randomUUID(),createdAt:new Date().toISOString(),environmentFingerprint:'',codeSchemaVersion:Math.max(...MEMORY_MIGRATIONS.map(m=>m.version)),counts:{},items:[],itemLimit:100,itemsTruncated:false,tableBytes:{},findingCounts:{recoverable:0,unknown:0,confirmed_violation:0,unproven:0},watermarks:{snapshotAt:''},queryElapsedMs:0,scopes:[],scopesTruncated:false,teamSources:[],teamSourcesTruncated:false,limitations:['Findings are per rule, not disjoint migrated-row totals; a record can have multiple reasons.','Current membership does not prove historical authorization.','Preview is bounded; full redacted details use keyset pages in this same snapshot.','Production recovery/cutover budgets need representative measured rehearsals.']}
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SET LOCAL statement_timeout='5s'")
  const identity=(await client.query('SELECT current_database() AS db,current_user AS role,version() AS version,inet_server_addr()::text AS server,pg_postmaster_start_time()::text AS started,CURRENT_TIMESTAMP::text AS snapshot_at')).rows[0]
  manifest.watermarks.snapshotAt=identity.snapshot_at
  const {snapshot_at,...environment}=identity
  manifest.environmentFingerprint=createHash('sha256').update(JSON.stringify(environment)).digest('hex')
  if(!(await client.query("SELECT to_regclass('public.memory_schema_migrations') IS NOT NULL AS present")).rows[0].present){manifest.blockers.push('missing_schema');await client.query('COMMIT');return manifest}
  const versions=(await client.query<{version:number}>('SELECT version FROM memory_schema_migrations ORDER BY version')).rows.map(r=>Number(r.version))
  manifest.schemaVersion=Math.max(0,...versions)
  if(versions.some(v=>!MEMORY_MIGRATIONS.some(m=>m.version===v))||manifest.schemaVersion<50)manifest.blockers.push('unsupported_schema')
  if(versions.some((v,i)=>v!==i+1))manifest.blockers.push('incomplete_schema_history')
  for(const table of Object.values(tables))if(!(await client.query('SELECT to_regclass($1) IS NOT NULL AS present',['public.'+table])).rows[0].present)manifest.blockers.push('missing_table:'+table)
  if(manifest.blockers.length){await client.query('COMMIT');return manifest}
  const scalar=async(key:string,sql:string)=>{manifest.counts[key]=Number((await client.query(sql)).rows[0].n)}
  for(const [key,table] of Object.entries(tables)){
   await scalar(key,`SELECT COUNT(*)::bigint AS n FROM ${table}`)
   manifest.tableBytes[table]=Number((await client.query('SELECT pg_total_relation_size($1::regclass)::bigint AS n',[table])).rows[0].n)
  }
  // Schema 50 inventory stays supported; retention counts only exist at v72.
  if(manifest.schemaVersion>=72){
   for(const table of ['source_events','source_artifacts','work_episodes','memory_candidates'])await scalar(`retention.${table}.reclaimed`,
    `SELECT count(*) AS n FROM ${table} WHERE body_reclaimed_at IS NOT NULL`)
   await scalar('retention.turns.reclaiming',`SELECT count(*) AS n FROM memory_source_retention_receipts WHERE state='reclaiming'`)
   await scalar('retention.turns.reclaimed',`SELECT count(*) AS n FROM memory_source_retention_receipts WHERE state='reclaimed'`)
   await scalar('retention.migrations.stalled',`SELECT count(*) AS n FROM memory_governance_migration_runs WHERE sealed_at IS NULL AND abandoned_at IS NULL AND started_at<CURRENT_TIMESTAMP-INTERVAL '14 days'`)
   await scalar('retention.episodes.unextractedOverdue',`SELECT count(*) AS n FROM work_episodes e WHERE e.body_reclaimed_at IS NULL
    AND COALESCE(e.terminal_at,e.updated_at)<CURRENT_TIMESTAMP-INTERVAL '14 days' AND NOT EXISTS(SELECT 1 FROM memory_extraction_runs r
      WHERE r.installation_id=e.installation_id AND r.episode_id=e.episode_id AND r.episode_source_digest=e.source_digest AND r.state='succeeded')`)
  }
  async function rule(key:string,sql:string,kind:string,reason:string,action:MigrationInventoryItem['action'],certainty:FindingCertainty,parameters:unknown[]=[]){
   const n=Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM (${sql}) finding`,parameters)).rows[0].n)
   manifest.counts[key]=n;manifest.findingCounts[certainty]+=n
   if(!n)return
   let after='',afterRecord=''
   do{
    const rows=(await client.query(`SELECT * FROM (${sql}) finding WHERE (id,COALESCE(to_jsonb(finding)->>'scan_key',id))>($${parameters.length+1},$${parameters.length+2}) ORDER BY id,COALESCE(to_jsonb(finding)->>'scan_key',id) LIMIT 100`,[...parameters,after,afterRecord])).rows
    const items=rows.map(row=>({kind,id:row.id,installationId:row.installation_id,reason,action,certainty,...(row.scan_key?{sourceRecordId:row.scan_key}:{}),...(row.source_version_id?{sourceVersionId:row.source_version_id}:{})}))
    const remaining=manifest.itemLimit-manifest.items.length
    manifest.itemsTruncated ||= items.length>remaining
    manifest.items.push(...items.slice(0,remaining))
    await options.onFindingBatch?.(items)
    if(rows.length<100||!options.onFindingBatch)break
    after=rows[rows.length-1].id;afterRecord=rows[rows.length-1].scan_key??after
   }while(true)
   manifest.itemsTruncated ||= n>100
  }
  const validPolicies:string[]=[],invalidPolicies:string[]=[]
  let policyAfter=''
  while(true){
   const rows=(await client.query(`SELECT p.policy_version_id::text AS id,p.document,p.content_hash FROM memory_review_policy_versions p WHERE p.policy_version_id::text>$1 ORDER BY p.policy_version_id LIMIT 100`,[policyAfter])).rows
   for(const row of rows){const policy=parseReviewPolicyDocument(row.document);(policy&&canonicalReviewPolicyHash(policy)===row.content_hash?validPolicies:invalidPolicies).push(row.id)}
   if(rows.length<100)break
   policyAfter=rows[rows.length-1].id
  }
  await rule('reviewPolicyIntegrityUnproven',`SELECT p.policy_version_id::text AS id,s.installation_id::text FROM memory_review_policy_versions p JOIN memory_review_policy_sets s USING(policy_id) WHERE p.policy_version_id=ANY($1::uuid[])`,'review_policy','review_policy_integrity_unproven','review','unproven',[invalidPolicies])
  await rule('v2IdentityCollisions',`SELECT MIN(claim_id::text) AS id,installation_id::text FROM knowledge_claims c WHERE c.state='active' AND to_jsonb(c)->>'normalized_key_v2' IS NOT NULL GROUP BY installation_id,to_jsonb(c)->>'normalized_key_v2' HAVING COUNT(*)>1`,'claim','v2_identity_collision','review','unknown')
  await rule('revisionTimeOrderUnknown',`SELECT older.version_id::text AS id,older.installation_id::text FROM knowledge_versions older JOIN knowledge_versions newer ON newer.installation_id=older.installation_id AND newer.claim_id=older.claim_id AND newer.version_number=older.version_number+1 WHERE older.created_at>newer.created_at`,'version','revision_time_order_unknown','quarantine','unknown')
  await rule('missingRepository',`SELECT c.claim_id::text AS id,c.installation_id::text FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id WHERE c.scope_kind IN('repository','snapshot','branch') AND v.repository_id IS NULL`,'claim','missing_repository','quarantine','unknown')
  await rule('invalidCurrentPointer',`SELECT c.claim_id::text AS id,c.installation_id::text FROM knowledge_claims c LEFT JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id WHERE c.state='active' AND v.version_id IS NULL`,'claim','invalid_current_pointer','hold','confirmed_violation')
  await rule('revisionsWithoutEvidence',`SELECT v.candidate_revision_id::text AS id,c.target_installation_id::text AS installation_id FROM memory_promotion_candidate_versions v JOIN memory_promotion_candidates c USING(candidate_id) WHERE NOT EXISTS(SELECT 1 FROM memory_promotion_evidence e WHERE e.candidate_revision_id=v.candidate_revision_id)`,'proposal_revision','missing_revision_evidence','review','unknown')
  await rule('expiredOpenProposals',`SELECT candidate_id::text AS id,target_installation_id::text AS installation_id FROM memory_promotion_candidates WHERE state IN('proposed','approved','changes_requested','conflict') AND expires_at<=CURRENT_TIMESTAMP`,'proposal','expired_open_proposal','recover','recoverable')
  await scalar('multipleOpenVersions',`SELECT COUNT(*) AS n FROM(SELECT claim_id FROM knowledge_versions WHERE valid_until IS NULL GROUP BY installation_id,claim_id HAVING COUNT(*)>1)x`)
  await rule('revisionIntervalMissing',`SELECT v.version_id::text AS id,v.installation_id::text FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id) JOIN knowledge_versions current ON current.installation_id=c.installation_id AND current.version_id=c.current_version_id WHERE v.version_number<current.version_number AND v.created_at<=current.created_at AND to_jsonb(v)->>'effective_until' IS NULL AND NOT EXISTS(SELECT 1 FROM knowledge_versions before JOIN knowledge_versions after ON after.installation_id=before.installation_id AND after.claim_id=before.claim_id AND after.version_number=before.version_number+1 WHERE before.installation_id=v.installation_id AND before.claim_id=v.claim_id AND before.created_at>after.created_at)`,'version','legacy_revision_interval_missing','review','recoverable')
  await rule('missingSourceVersions',`SELECT c.candidate_id::text AS id,c.target_installation_id::text AS installation_id FROM memory_promotion_candidates c WHERE NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.installation_id=c.source_installation_id AND v.version_id=c.source_version_id)`,'proposal','missing_source_version','quarantine','unknown')
  await rule('legacyPublisherCountViolation',`SELECT v.claim_id::text AS id,a.installation_id::text,a.authority_id::text AS scan_key,a.version_id::text AS source_version_id FROM memory_authority_records a JOIN knowledge_versions v ON v.installation_id=a.installation_id AND v.version_id=a.version_id JOIN memory_review_policy_versions p ON p.policy_version_id=a.review_policy_version_id WHERE p.policy_version_id=ANY($1::uuid[]) AND p.document->>'publisher_may_count_as_reviewer'='false' AND EXISTS(SELECT 1 FROM memory_review_decisions d WHERE d.decision_id=ANY(a.counted_decision_ids) AND d.membership_id=a.publisher_membership_id AND d.candidate_revision_id=a.candidate_revision_id AND d.decision='approve')`,'claim','publisher_counted_against_policy','hold','confirmed_violation',[validPolicies])
  await rule('parallelPolicyUnproven',`SELECT c.claim_id::text AS id,c.installation_id::text FROM knowledge_claims c JOIN memory_authority_records a ON a.installation_id=c.installation_id AND a.version_id=c.current_version_id JOIN memory_review_policy_versions p ON p.policy_version_id=a.review_policy_version_id WHERE c.state='active' AND c.conflict_group_id IS NOT NULL AND p.document->>'allow_parallel_conflicts'='false' AND (SELECT COUNT(*) FROM knowledge_claims other WHERE other.installation_id=c.installation_id AND other.conflict_group_id=c.conflict_group_id AND other.state='active')>1`,'claim','parallel_history_requires_proof','review','unproven')
  await rule('revokedPublisherUnproven',`SELECT a.authority_id::text AS id,a.installation_id::text FROM memory_authority_records a JOIN memory_scope_memberships member ON member.installation_id=a.installation_id AND member.membership_id=a.publisher_membership_id WHERE member.state<>'active'`,'authority','historical_authorization_unproven','review','unproven')
  await rule('sharedApplicabilityLoss',`SELECT target.claim_id::text AS id,target.installation_id::text,a.authority_id::text AS scan_key,a.version_id::text AS source_version_id FROM memory_authority_records a JOIN knowledge_versions target ON target.installation_id=a.installation_id AND target.version_id=a.version_id JOIN memory_promotion_candidate_versions revision ON revision.candidate_revision_id=a.candidate_revision_id JOIN memory_promotion_candidates proposal USING(candidate_id) JOIN knowledge_versions source ON source.installation_id=proposal.source_installation_id AND source.version_id=proposal.source_version_id WHERE (source.repository_id IS NOT NULL AND target.repository_id IS NULL) OR (source.repo_snapshot_id IS NOT NULL AND target.repo_snapshot_id IS NULL) OR (source.branch IS NOT NULL AND target.branch IS NULL) OR (source.valid_until IS NOT NULL AND target.valid_until IS DISTINCT FROM source.valid_until)`,'claim','shared_applicability_or_time_lost','review','unknown')
  await scalar('budgetOmissions',`SELECT COUNT(*) AS n FROM memory_jobs WHERE job_type='extract_candidates' AND state='completed' AND last_error_code IN('budget_exceeded','budget_unavailable')`)
  await rule('budgetSourceUnproven',`SELECT j.job_id::text AS id,j.installation_id::text FROM memory_jobs j WHERE j.job_type='extract_candidates' AND j.state='completed' AND j.last_error_code IN('budget_exceeded','budget_unavailable') AND NOT EXISTS(SELECT 1 FROM work_episodes e WHERE e.installation_id=j.installation_id AND e.turn_id=j.payload->>'turn_id' AND e.state='ready' AND encode(e.source_digest,'hex')=j.payload->>'source_digest')`,'job','budget_source_unproven','review','unproven')
  await rule('explicitConsumptionHolds',`SELECT claim_id::text AS id,installation_id::text FROM knowledge_claims c WHERE to_jsonb(c)->>'consumption_hold_reason' IS NOT NULL`,'claim','explicit_consumption_hold','unchanged','unknown')
  for(const row of (await client.query('SELECT job_type,state,COUNT(*)::int AS n FROM memory_jobs GROUP BY job_type,state')).rows)manifest.counts[`jobs.${row.job_type}.${row.state}`]=row.n
  for(const row of (await client.query('SELECT key_id,COUNT(*)::int AS n FROM knowledge_tombstones GROUP BY key_id')).rows)manifest.counts[`tombstones.keyVersion.${row.key_id}`]=row.n
  manifest.watermarks.feedId=(await client.query('SELECT COALESCE(MAX(feed_id),0)::text AS id FROM memory_feed_inbox')).rows[0].id
  let scopeAfter='',sourceAfter='',scopeCount=0,sourceCount=0
  while(true){
   const rows=(await client.query<ScopeObservation>(`SELECT installation_id::text AS "installationId",owner_scope_kind AS "ownerKind",owner_scope_id::text AS "ownerId",authorization_epoch::text AS epoch,state FROM memory_owner_scopes WHERE installation_id::text>$1 ORDER BY installation_id LIMIT 100`,[scopeAfter])).rows
   scopeCount+=rows.length;manifest.scopes.push(...rows.slice(0,100-manifest.scopes.length))
   await options.onScopeBatch?.(rows)
   if(rows.length<100)break
   scopeAfter=rows[rows.length-1].installationId
  }
  while(true){
   const rows=(await client.query<TeamSourceObservation>(`SELECT source_event_id::text AS id,installation_id::text AS "installationId",payload->'team_source'->'read_scope'->>'team_memory_binding_id' AS "bindingId",payload->'team_source'->'read_scope'->>'team_memory_binding_revision' AS "bindingRevision",payload->'team_source'->>'team_id' AS "teamId",payload->'team_source'->>'team_session_id' AS "sessionId",payload->'team_source'->'read_scope'->>'participant_user_id' AS "participantId",payload->'team_source'->'read_scope'->>'participant_revision' AS "participantRevision",payload->'team_source'->'read_scope'->>'target_installation_id' AS "targetInstallationId",payload->'team_source'->'read_scope'->>'target_owner_scope_kind' AS "targetOwnerKind",payload->'team_source'->'read_scope'->>'target_owner_scope_id' AS "targetOwnerId" FROM source_events WHERE payload ? 'team_source' AND source_event_id::text>$1 ORDER BY source_event_id LIMIT 100`,[sourceAfter])).rows
   sourceCount+=rows.length
   manifest.teamSources.push(...rows.slice(0,100-manifest.teamSources.length).map(row=>({id:row.id,installationId:row.installationId,participantFingerprint:createHash('sha256').update(row.id+'\n'+String(row.participantId)).digest('hex')})))
   await options.onTeamSourceBatch?.(rows)
   if(rows.length<100)break
   sourceAfter=rows[rows.length-1].id
  }
  manifest.scopesTruncated=scopeCount>100;manifest.teamSourcesTruncated=sourceCount>100
  manifest.counts.scopes=scopeCount;manifest.counts.teamSources=sourceCount
  manifest.compatible=true
  await client.query('COMMIT')
  return manifest
 }catch(error){await client.query('ROLLBACK');throw error}finally{manifest.queryElapsedMs=Math.round(performance.now()-started);client.release()}
}
