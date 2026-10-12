export const FEEDBACK_RETENTION_MIGRATION={version:59,statements:[
 `CREATE TABLE memory_feedback_rollups(
   period_day DATE NOT NULL,action TEXT NOT NULL CHECK(action IN('candidate_accepted','candidate_corrected','candidate_rejected',
     'claim_corrected','claim_expired','claim_revoked','claim_deleted','recall_used','recall_incorrect','recall_not_useful')),
   reason_code TEXT NOT NULL CHECK(reason_code IN('incorrect','unsupported','insufficient_evidence','outdated','duplicate','wrong_scope','scope_mismatch','not_useful','not_supported','too_specific','unsafe','user_rejected','other')),
   total_count BIGINT NOT NULL CHECK(total_count>0),PRIMARY KEY(period_day,action,reason_code))`
]}
