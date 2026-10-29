import type pg from 'pg'
import { artifactDigest, stableDigest, type ArtifactManifest, type SubmissionEvidence } from './delivery-contract.js'
import { stepDigest, type TaskPlanStep } from './plan-contract.js'
import { TeamRepositoryError } from './repository.js'

export interface PlanInputSelection { step_id: string; attempt_id: string; submission_id: string }
export interface FrozenPlanInput extends PlanInputSelection {
  plan_revision: number
  source_call_id: string
  submission_version: number
  spec_revision: number
  context_version: number
  context_hash: string | null
  decision_id: string
  reviewer_user_id: number
  verified_checks: string[]
  code_revision: string | null
  manifest_sha256: string
  evidence_sha256: string
  artifacts: ArtifactManifest[]
  evidence: SubmissionEvidence[]
  trusted_evidence?: Array<{ evidence_id: string; connector_id: string; principal_user_id: number | null; connector_kind: string; repository: string; run_id: string; check_id: string; spec_revision: number; code_revision: string; result: string; report_sha256: string }>
  trusted_evidence_sha256?: string
}

/** Internal transaction primitive, not an authorization boundary. The scheduler
 * must first authorize the Task and hold its UPDATE lock, then persist this
 * snapshot and the dispatch intent in that SAME transaction. No latest pointer
 * is resolved after reservation, and this function never dispatches a Call. */
export async function freezeAcceptedPlanInputs(db: Pick<pg.PoolClient, 'query'>, taskId: string, revision: number, stepId: string, selections: PlanInputSelection[]): Promise<FrozenPlanInput[]> {
  const target = (await db.query('SELECT definition FROM team_task_plan_steps WHERE task_id=$1 AND plan_revision=$2 AND step_id=$3', [taskId, revision, stepId])).rows[0]?.definition as TaskPlanStep | undefined
  if (!target) throw new TeamRepositoryError('invalid_request', 'step does not belong to this plan revision')
  if (selections.length !== target.depends_on.length || new Set(selections.map(s => s.step_id)).size !== selections.length || selections.some(s => !target.depends_on.includes(s.step_id))) {
    throw new TeamRepositoryError('invalid_request', 'freeze requires exactly one explicit accepted input per dependency')
  }
  const result: FrozenPlanInput[] = []
  for (const selected of [...selections].sort((a, b) => a.step_id.localeCompare(b.step_id))) {
    if (![selected.attempt_id, selected.submission_id].every(id => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new TeamRepositoryError('invalid_request', 'invalid input identity')
    const row = (await db.query(`SELECT a.plan_revision,a.state AS attempt_state,a.call_id,
        old.definition AS attempt_definition,current.definition AS current_definition,s.*,d.decision_id,d.decision,d.reviewer_user_id,d.verified_checks
      FROM team_task_step_attempts a
      JOIN team_task_plan_steps old ON old.task_id=a.task_id AND old.plan_revision=a.plan_revision AND old.step_id=a.step_id
      JOIN team_task_plan_steps current ON current.task_id=a.task_id AND current.plan_revision=$2 AND current.step_id=a.step_id
      JOIN team_task_submissions s ON s.task_id=a.task_id AND s.source_call_id=a.call_id AND s.submission_id=$5 AND s.submission_id=a.accepted_submission_id
      JOIN team_call_delivery_specs cs ON cs.call_id=a.call_id AND cs.task_id=a.task_id AND cs.spec_revision=s.spec_revision
      JOIN team_acceptance_decisions d ON d.submission_id=s.submission_id AND d.task_id=s.task_id AND d.spec_revision=s.spec_revision
      WHERE a.task_id=$1 AND a.step_id=$3 AND a.attempt_id=$4`, [taskId, revision, selected.step_id, selected.attempt_id, selected.submission_id])).rows[0]
    if (!row || row.attempt_state !== 'accepted' || row.state !== 'published' || row.decision !== 'accepted' || row.delivery_role !== 'primary') throw new TeamRepositoryError('acceptance_required', 'dependency needs an accepted delivery from the selected attempt')
    const definition = row.attempt_definition as TaskPlanStep
    if (stepDigest(definition) !== stepDigest(row.current_definition)) throw new TeamRepositoryError('revision_conflict', 'dependency definition changed across plan revisions')
    if (Number(row.reviewer_user_id) !== definition.review_policy.reviewer_user_id || row.source_offer_id !== definition.review_policy.primary_offer_id
      || !definition.review_policy.required_checks.every(id => row.verified_checks.includes(id) && row.evidence.some((e: SubmissionEvidence) => e.check_id === id && ['passed', 'unverified'].includes(e.result)))) {
      throw new TeamRepositoryError('evidence_required', 'accepted input does not satisfy the frozen step policy')
    }
    const files = (await db.query(`SELECT f.artifact_id,f.content_bytes,f.sha256,f.byte_size,r.artifact_id AS revoked
      FROM team_submission_artifacts f LEFT JOIN team_artifact_revocations r USING(submission_id,artifact_id) WHERE f.submission_id=$1`, [selected.submission_id])).rows
    // Freeze every explicitly published artifact, not merely the required ones.
    // A missing/revoked optional artifact must not be advertised as readable.
    if ((row.manifest as ArtifactManifest[]).some(artifact => {
      const file = files.find(f => f.artifact_id === artifact.id)
      return !file || file.revoked || Number(file.byte_size) !== artifact.byte_size || file.sha256 !== artifact.sha256 || artifactDigest(file.content_bytes) !== artifact.sha256
    })) throw new TeamRepositoryError('artifact_unavailable', 'dependency files are missing, revoked or corrupt')
    const trusted = (await db.query(`SELECT evidence_id,connector_id,principal_user_id,connector_kind,repository,run_id,check_id,spec_revision,code_revision,result,report_sha256
      FROM team_trusted_evidence WHERE task_id=$1 AND submission_id=$2 ORDER BY evidence_id`, [taskId, selected.submission_id])).rows.map(r => ({ ...r, spec_revision: Number(r.spec_revision) })) as NonNullable<FrozenPlanInput['trusted_evidence']>
    result.push({ ...selected, plan_revision: Number(row.plan_revision), source_call_id: row.call_id,
      submission_version: Number(row.version), spec_revision: Number(row.spec_revision), context_version: Number(row.context_version), context_hash: row.context_hash,
      decision_id: row.decision_id, reviewer_user_id: Number(row.reviewer_user_id), verified_checks: row.verified_checks, code_revision: row.code_revision,
      manifest_sha256: row.manifest_sha256, evidence_sha256: stableDigest(row.evidence), artifacts: row.manifest, evidence: row.evidence,
      ...(trusted.length ? { trusted_evidence: trusted, trusted_evidence_sha256: stableDigest(trusted) } : {}) })
  }
  return result
}
