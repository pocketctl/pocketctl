import type pg from 'pg'
export const FEEDBACK_REASON_CODES=Object.freeze(['incorrect','unsupported','insufficient_evidence','outdated','duplicate','wrong_scope','scope_mismatch','not_useful','not_supported','too_specific','unsafe','user_rejected','other'] as const)
export function normalizeFeedbackReason(value?:string|null):string|null{
 if(value==null||value==='')return null
 return(FEEDBACK_REASON_CODES as readonly string[]).includes(value)?value:'other'
}
/** Only observed rows are rolled up. Anonymous day/action totals contain no
 * installation, actor, source identifiers, bodies, details or arbitrary reason.
 */
export async function rollupFeedbackBeforeInstallationPurge(client:Pick<pg.PoolClient,'query'>,installationId:string):Promise<void>{
 await client.query(`INSERT INTO memory_feedback_rollups(period_day,action,reason_code,total_count)
   SELECT (created_at AT TIME ZONE 'UTC')::date,action,
     CASE WHEN reason_code=ANY($2::text[]) THEN reason_code ELSE 'other' END,count(*)
   FROM memory_feedback WHERE installation_id=$1
   GROUP BY (created_at AT TIME ZONE 'UTC')::date,action,CASE WHEN reason_code=ANY($2::text[]) THEN reason_code ELSE 'other' END
   ON CONFLICT(period_day,action,reason_code) DO UPDATE SET total_count=memory_feedback_rollups.total_count+EXCLUDED.total_count`,[installationId,[...FEEDBACK_REASON_CODES]])
}
/** Session deletion retains the observed action while removing content-bearing
 * metadata and identifiers for feedback linked to the deleted source. */
export async function minimizeSessionFeedback(client:Pick<pg.PoolClient,'query'>,installationId:string,sessionId:string):Promise<void>{
 await client.query(`UPDATE memory_feedback f SET reason_code=CASE WHEN reason_code=ANY($3::text[]) THEN reason_code ELSE 'other' END,
   details='{}'::jsonb,request_id=NULL,candidate_id=NULL,claim_id=NULL,version_id=NULL
   WHERE f.installation_id=$1 AND (f.details->>'session_id'=$2
     OR f.candidate_id IN(SELECT c.candidate_id FROM memory_candidates c JOIN work_episodes w USING(installation_id,episode_id)
       WHERE c.installation_id=$1 AND w.session_id=$2)
     OR f.version_id IN(SELECT e.version_id FROM knowledge_evidence e JOIN work_episodes w USING(installation_id,episode_id)
       WHERE e.installation_id=$1 AND w.session_id=$2))`,[installationId,sessionId,[...FEEDBACK_REASON_CODES]])
}
