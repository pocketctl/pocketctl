/** Opt-in maintenance stages. Existing public purgeSession semantics are not
 * changed. The maintenance caller supplies an audited complete native closure,
 * current authority and original-key guards in the same bounded transaction. */
import type pg from 'pg'
import type {TombstoneHmacKey} from '../config.js'
import {invalidateDerivedEpisodes,cancelSessionContextGenerationRows} from './repository.js'
import type {PagedCleanupPart,PagedCleanupRecord} from '../migrations/shared-forward/paged-cleanup-manifest.js'
import {qi} from '../migrations/shared-forward/source-maintenance-common.js'
import {minimizeFeedbackRows} from '../claims/feedback-policy.js'
const leafTables=new Set(['source_events','source_artifacts','source_turns','work_episodes','memory_feed_inbox','memory_snapshot_events','memory_source_retention_receipts','memory_source_processing_receipts','memory_session_scene_frames','memory_task_bundle_sources','memory_task_bundles','memory_context_packs','memory_skill_replay_runs','memory_skill_executions'])
type Client=Pick<pg.PoolClient,'query'>
export async function lockStagedSessionPurge(c:Client,installationId:string,sessions:readonly string[]){
 for(const session of [...new Set(sessions)].sort())await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))",[installationId,session])
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[installationId])
}
async function deleteRows(c:Client,table:string,rows:readonly PagedCleanupRecord[]){
 if(!leafTables.has(table))throw Error('paged_native_delete_policy_missing')
 for(const row of rows){const columns=Object.keys(row.key);if(!columns.length)throw Error('paged_native_key_required');await c.query(`DELETE FROM ${qi(table)} WHERE ${columns.map((k,i)=>`${qi(k)}::text IS NOT DISTINCT FROM $${i+1}::text`).join(' AND ')}`,columns.map(k=>row.key[k]))}
}
export async function applyStagedSessionPage(c:Client,page:PagedCleanupPart,keys:readonly TombstoneHmacKey[]){
 await lockStagedSessionPurge(c,page.root.installationId,[page.root.sessionId,...page.records.filter(r=>r.table==='work_episodes').map(r=>r.references.session_id).filter((s):s is string=>!!s)])
 if(page.phase==='authority')return
 if(page.phase==='feedback'){
  await minimizeFeedbackRows(c,page.root.installationId,page.records.filter(r=>r.table==='memory_feedback'&&r.disposition==='minimize').map(r=>r.key.feedback_id!));return
 }
 if(page.phase==='derived'){
  const episodes=page.records.filter(r=>r.table==='work_episodes'&&r.disposition==='invalidate')
  // Existing reclaimed bodies are immutable. Safe already-minimal rows need
  // no body rewrite; unknown frozen body shapes refuse before policy writes.
  const frozen=(await c.query("SELECT episode_id::text,document,evidence_manifest,summary FROM work_episodes WHERE installation_id=$1 AND episode_id=ANY($2::uuid[]) AND body_reclaimed_at IS NOT NULL",[page.root.installationId,episodes.map(r=>r.key.episode_id)])).rows
  if(frozen.some(r=>JSON.stringify(r.document)!=='{}'||JSON.stringify(r.evidence_manifest)!=='{}'||JSON.stringify(r.summary)!=='{}'))throw Error('paged_reclaimed_skeleton_shape_unproved')
  const frozenIds=new Set(frozen.map(r=>r.episode_id))
  // Native source-loss policy owns Claim replacement, HMACs, independent
  // capsules, feedback and Skill/Git trigger effects. Never duplicate it here.
  await invalidateDerivedEpisodes(c,{installationId:page.root.installationId,episodeIds:episodes.filter(r=>!frozenIds.has(r.key.episode_id)).map(r=>r.key.episode_id!)},keys)
  if(frozen.length)await c.query("UPDATE work_episodes SET state='invalidated',compiled_at=NULL WHERE installation_id=$1 AND episode_id=ANY($2::uuid[]) AND state<>'invalidated'",[page.root.installationId,[...frozenIds]])
  await deleteRows(c,'work_episodes',episodes.filter(r=>!r.retainReason))
  return
 }
 if(page.phase==='operational'){
  await cancelSessionContextGenerationRows(c,page.root,{runIds:page.records.filter(r=>r.table==='memory_generation_runs'&&r.disposition==='invalidate').map(r=>r.key.run_id!),preserveError:true});return
 }
 if(page.phase==='raw'){
  const tables=[...new Set(page.records.filter(r=>r.disposition==='delete').map(r=>r.table))]
  for(const table of tables)await deleteRows(c,table,page.records.filter(r=>r.table===table&&r.disposition==='delete'))
  return
 }
 if(page.phase==='final'){
  const [installation,session]=[page.root.installationId,page.root.sessionId],reason=page.records.find(r=>r.table==='source_sessions')?.references.barrier_reason_key
  if(reason!=='user_deleted'&&reason!=='access_revoked')throw Error('paged_final_native_reason_unproved')
  // No unbounded tombstone trigger is used as a final cleanup shortcut.
  for(const table of ['source_events','source_artifacts','source_turns','memory_feed_inbox','memory_snapshot_events','memory_context_packs','memory_task_bundles','memory_skill_executions'])if((await c.query(`SELECT 1 FROM ${qi(table)} WHERE installation_id=$1 AND session_id=$2 LIMIT 1`,[installation,session])).rowCount)throw Error('paged_final_native_residual')
  if((await c.query("SELECT 1 FROM work_episodes WHERE installation_id=$1 AND session_id=$2 AND(state<>'invalidated' OR document<>'{}'::jsonb OR evidence_manifest<>'{}'::jsonb OR summary<>'{}'::jsonb) LIMIT 1",[installation,session])).rowCount)throw Error('paged_final_episode_body_residual')
  if((await c.query(`SELECT 1 FROM memory_skill_task_runs r JOIN work_episodes e USING(installation_id,episode_id) JOIN memory_skill_tasks task USING(installation_id,task_id)
     LEFT JOIN memory_generation_runs g ON g.run_id=r.generation_run_id
     WHERE e.installation_id=$1 AND e.session_id=$2 AND(r.state IN('pending','running','candidate') OR g.state IN('queued','running')
      OR(r.state='cancelled' AND r.generation=task.current_generation AND task.state<>'cancelled')
      OR NOT EXISTS(SELECT 1 FROM memory_schema_migrations WHERE version=95)
      OR EXISTS(SELECT 1 FROM memory_jobs j WHERE j.installation_id=r.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running') AND j.payload->>'task_id'=r.task_id::text AND j.payload->>'generation'=r.generation::text))
    UNION ALL SELECT 1 FROM memory_skill_archives a JOIN work_episodes e USING(installation_id,episode_id) WHERE e.installation_id=$1 AND e.session_id=$2
    UNION ALL SELECT 1 FROM memory_skill_replay_cases WHERE installation_id=$1 AND session_id=$2
    UNION ALL SELECT 1 FROM memory_git_snapshot_sources s JOIN work_episodes e USING(installation_id,episode_id) WHERE e.installation_id=$1 AND e.session_id=$2 LIMIT 1`,[installation,session])).rowCount)throw Error('paged_final_native_trigger_residual_requires_staging')
  if(!(await c.query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[installation,session])).rowCount)await c.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,source_feed_id,purged_at) VALUES($1,$2,$3,NULL,clock_timestamp())",[installation,session,reason])
  await c.query("UPDATE source_sessions SET agent_type=NULL,daemon_id=NULL,status=NULL,cwd_observation=NULL,worktree_path=NULL,worktree_branch=NULL,deleted_at=COALESCE(deleted_at,clock_timestamp()),delete_reason=$3 WHERE installation_id=$1 AND session_id=$2",[installation,session,reason])
  return
 }
 throw Error('paged_native_phase_unsupported')
}
