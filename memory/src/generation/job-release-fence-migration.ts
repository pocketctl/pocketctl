import {JOB_COMMIT_FENCE_MIGRATION} from './job-commit-fence-migration.js'
/** A release is an explicit fenced transition, never an extension of a lease. */
export const JOB_RELEASE_FENCE_MIGRATION={version:66,statements:[
 JOB_COMMIT_FENCE_MIGRATION.statements[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION')
 .replace("SELECT claimed_by=stamp->>'claimedBy' AND claim_epoch=(stamp->>'claimEpoch')::bigint", "SELECT claim_epoch=(stamp->>'claimEpoch')::bigint AND ((claimed_by=stamp->>'claimedBy'")
 .replace("INTO owned FROM memory_jobs", "OR (state=stamp->>'releaseState' AND state IN('pending','dead') AND claimed_by IS NULL AND claim_expires_at IS NULL AND clock_timestamp()<(stamp->>'leaseUntil')::timestamptz))) INTO owned FROM memory_jobs")
]} as const
