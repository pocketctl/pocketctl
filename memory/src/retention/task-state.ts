import type pg from 'pg'
import {lifecycleSourceDigest,type LifecycleDigestEvent} from '../curation/task-repository.js'
import {LIFECYCLE_SOURCE_POLICY} from '../episodes/source-admission.js'

/** Also applies when lifecycle shadow tasks coexist with a legacy Episode. */
export function taskSourceProtectedSql(installation='e.installation_id',turn='e.turn_id'):string {
 return `EXISTS(SELECT 1 FROM memory_task_bundle_sources bs JOIN source_events se USING(installation_id,source_event_id)
  JOIN memory_task_bundles b USING(installation_id,bundle_id)
  WHERE bs.installation_id=${installation} AND se.turn_id=${turn} AND(
   b.state NOT IN('completed','skipped_unresolved') OR bs.source_digest<>se.payload_hash
   OR EXISTS(SELECT 1 FROM memory_task_bundles parent WHERE parent.installation_id=b.installation_id AND parent.bundle_id=b.parent_bundle_id AND(parent.revision<>b.parent_revision OR parent.state NOT IN('completed','skipped_unresolved')))
   OR EXISTS(SELECT 1 FROM memory_curation_runs r WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id AND
    ((r.bundle_revision=b.revision AND r.state<>'completed') OR r.state='provider_result_unknown'))
   OR EXISTS(SELECT 1 FROM memory_curation_decisions d JOIN memory_curation_runs r USING(installation_id,run_id)
    WHERE r.installation_id=b.installation_id AND r.bundle_id=b.bundle_id AND d.state='proposed')
   OR EXISTS(SELECT 1 FROM memory_candidates c WHERE c.installation_id=b.installation_id AND c.bundle_id=b.bundle_id AND c.status IN('validated','conflict') AND c.review_expires_at>clock_timestamp())))`
}

/** Caller holds the exclusive installation/session retention locks. Digest is
 * computed with the exact producer algorithm, including trusted provenance.
 * The digest depends on frozen metadata, never source bodies or archive IO. */
export async function lifecycleSourceRetentionProof(client:pg.PoolClient,input:{installationId:string;sessionId:string;turnId:string;bodyDays:number}){
 const events=(await client.query<LifecycleDigestEvent & {session_id:string|null;body_reclaimed_at:Date|null}>(`SELECT source_event_id::text,session_id,event_type,occurred_at,payload_hash,source_provenance,body_reclaimed_at
  FROM source_events WHERE installation_id=$1 AND turn_id=$2 ORDER BY source_event_id`,[input.installationId,input.turnId])).rows
 if(!events.length||events.some(e=>e.body_reclaimed_at||e.session_id!==input.sessionId))return null
 const digest=lifecycleSourceDigest(input.installationId,events)
 const row=(await client.query(`SELECT r.* FROM memory_source_processing_receipts r
  JOIN source_turns t USING(installation_id,turn_id) JOIN memory_curation_policies p USING(installation_id)
  WHERE r.installation_id=$1 AND r.turn_id=$2 AND r.session_id=$3 AND r.source_digest=$4 AND r.policy_version=$5 AND r.complete
   AND p.mode='enabled' AND p.reclaim_mode='enabled' AND t.terminal_at IS NOT NULL AND t.state IN('completed','interrupted','failed','abandoned')
   AND t.updated_at<=r.created_at AND r.created_at<=clock_timestamp()-($6::int*interval '24 hours')
   AND NOT ${taskSourceProtectedSql('r.installation_id','r.turn_id')}
   AND NOT EXISTS(SELECT 1 FROM memory_feed_inbox f WHERE f.installation_id=r.installation_id AND f.session_id=r.session_id
    AND(f.turn_id IS NULL OR f.turn_id=r.turn_id) AND(f.projection_state='pending' OR(f.projection_state='quarantined' AND f.error_code='oversized_content')))
   AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.installation_id=r.installation_id AND j.state IN('pending','running') AND
    (j.job_type='snapshot_reconcile' OR j.payload->>'turn_id'=r.turn_id OR EXISTS(SELECT 1 FROM memory_task_bundles b
      JOIN memory_task_bundle_sources bs USING(installation_id,bundle_id) JOIN source_events se USING(installation_id,source_event_id)
      WHERE b.installation_id=r.installation_id AND se.turn_id=r.turn_id AND b.bundle_id::text=j.payload->>'bundle_id')))
   AND NOT EXISTS(SELECT 1 FROM knowledge_evidence k WHERE k.installation_id=r.installation_id AND(
    k.source_event_id IN(SELECT source_event_id FROM source_events WHERE installation_id=r.installation_id AND turn_id=r.turn_id) OR
    k.artifact_id IN(SELECT artifact_id FROM source_artifacts WHERE installation_id=r.installation_id AND turn_id=r.turn_id)))
   AND NOT EXISTS(SELECT 1 FROM memory_skill_archive_sources k WHERE k.installation_id=r.installation_id AND(
    k.source_event_id IN(SELECT source_event_id FROM source_events WHERE installation_id=r.installation_id AND turn_id=r.turn_id) OR
    k.artifact_id IN(SELECT artifact_id FROM source_artifacts WHERE installation_id=r.installation_id AND turn_id=r.turn_id)))
  ORDER BY r.created_at DESC LIMIT 1`,[input.installationId,input.turnId,input.sessionId,digest,LIFECYCLE_SOURCE_POLICY,input.bodyDays])).rows[0]
 return row??null
}

/** A bundle is frozen only after every member body is fenced/reclaimed.
 * Retain task identity, digest and decisions, drop model/result prose. */
export async function reclaimSettledTaskState(client:pg.PoolClient,installationId:string,turnId:string):Promise<void>{
 const rows=(await client.query(`SELECT DISTINCT b.bundle_id FROM memory_task_bundles b
  JOIN memory_task_bundle_sources bs USING(installation_id,bundle_id) JOIN source_events s USING(installation_id,source_event_id)
  WHERE b.installation_id=$1 AND s.turn_id=$2 AND b.state IN('completed','skipped_unresolved') AND b.body_state='present'
   AND NOT EXISTS(SELECT 1 FROM memory_task_bundle_sources members JOIN source_events se USING(installation_id,source_event_id)
    WHERE members.installation_id=b.installation_id AND members.bundle_id=b.bundle_id AND se.body_reclaimed_at IS NULL)`,[installationId,turnId])).rows
 for(const row of rows){
  await client.query("UPDATE memory_curation_runs SET result=NULL WHERE installation_id=$1 AND bundle_id=$2 AND state='completed'",[installationId,row.bundle_id])
  await client.query(`UPDATE memory_candidates SET retained_content_hash=encode(sha256(convert_to(jsonb_build_object('statement',statement,'structured_content',structured_content,'evidence_handles',evidence_handles)::text,'UTF8')),'hex'),
   statement='[content reclaimed]',structured_content='{}',evidence_handles='[]',body_reclaimed_at=clock_timestamp(),revision=revision+1,
   status=CASE WHEN status IN('validated','conflict') AND review_expires_at<=clock_timestamp() THEN 'expired' ELSE status END
   WHERE installation_id=$1 AND bundle_id=$2 AND body_reclaimed_at IS NULL`,[installationId,row.bundle_id])
  await client.query("UPDATE memory_task_bundles SET body_state='reclaimed',topic_descriptor='',spans='[]',updated_at=clock_timestamp() WHERE installation_id=$1 AND bundle_id=$2",[installationId,row.bundle_id])
 }
}
