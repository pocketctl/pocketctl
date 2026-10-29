import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import { requireTeamAccess } from './access.js'
import { artifactDigest, boundedText, positiveRevision, stableDigest } from './delivery-contract.js'
import { TeamRepositoryError } from './repository.js'

export interface EvidenceConnector {
  id: string; team_id: string; principal_user_id: number; kind: 'ci' | 'review'
  repository: string; checks: string[]; token_sha256: string
}
export function evidenceConnectors(env: Record<string, string | undefined> = process.env): EvidenceConnector[] {
  const raw = env.TEAM_EVIDENCE_CONNECTORS_JSON ?? '[]'
  try {
    if (Buffer.byteLength(raw) > 65536) throw Error()
    const value = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > 100) throw Error()
    const ids = new Set<string>()
    for (const c of value) {
      if (!c || typeof c !== 'object' || Object.keys(c).some(k => !['id','team_id','principal_user_id','kind','repository','checks','token_sha256'].includes(k))
        || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.id) || ids.has(c.id) || typeof c.team_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.team_id)
        || !Number.isSafeInteger(c.principal_user_id) || c.principal_user_id < 1 || !['ci','review'].includes(c.kind)
        || typeof c.repository !== 'string' || c.repository.length < 1 || c.repository.length > 240 || c.repository.includes('\0')
        || !Array.isArray(c.checks) || !c.checks.length || c.checks.length > 32 || new Set(c.checks).size !== c.checks.length
        || c.checks.some((s: unknown) => typeof s !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(s))
        || typeof c.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.token_sha256)) throw Error()
      ids.add(c.id)
    }
    return value
  } catch { throw new Error('invalid TEAM_EVIDENCE_CONNECTORS_JSON') }
}

export interface TrustedEvidenceInput {
  submission_id: string; spec_revision: number; code_revision: string; repository: string
  run_id: string; check_id: string; result: 'passed' | 'failed' | 'unverified'
  report_base64: string; report_sha256: string; expires_at: string; publish_scope: 'team'
}

export const TRUSTED_EVIDENCE_COLUMNS = 'evidence_id,submission_id,connector_id,principal_user_id,connector_kind,repository,run_id,check_id,spec_revision,code_revision,result,report_sha256,received_at'

/** Connector credentials are separate from user/daemon JWTs. Reports are
 * immutable contributions; this service cannot issue human acceptance. */
export class TeamEvidenceService {
  constructor(private readonly pool: pg.Pool, private readonly connectors: EvidenceConnector[],
    private readonly enabledForTeam: (teamId: string) => boolean = () => false) {}

  private authenticate(connectorId: string, authorization: string | undefined): EvidenceConnector {
    const connector = this.connectors.find(c => c.id === connectorId)
    const token = authorization?.startsWith('Evidence ') ? authorization.slice(9) : ''
    if (!connector || token.length < 32 || token.length > 256
      || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(connector.token_sha256, 'hex'))) {
      throw new TeamRepositoryError('authorization_required', 'connector authorization required')
    }
    return connector
  }

  async readReport(taskId: string, evidenceId: string, actor: number) {
    boundedText(taskId, 'task_id', 128)
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(evidenceId)) throw new TeamRepositoryError('invalid_request', 'invalid evidence identity')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client, actor, true)
      const identity = (await client.query('SELECT team_id FROM team_tasks WHERE task_id=$1', [taskId])).rows[0]
      if (!identity) throw new TeamRepositoryError('team_not_found', 'task not found')
      const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [identity.team_id])).rows[0]
      const member = (await client.query("SELECT 1 FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE", [identity.team_id, actor])).rows[0]
      if (!team || !member || !(await client.query("SELECT 1 FROM team_tasks WHERE task_id=$1 AND state<>'deleted' FOR SHARE", [taskId])).rows[0]) throw new TeamRepositoryError('team_not_found', 'task not found')
      const report = (await client.query('SELECT report_bytes,report_sha256 FROM team_trusted_evidence WHERE task_id=$1 AND evidence_id=$2', [taskId, evidenceId])).rows[0]
      if (!report) throw new TeamRepositoryError('team_not_found', 'evidence report not found')
      if (artifactDigest(report.report_bytes) !== report.report_sha256) throw new TeamRepositoryError('artifact_integrity', 'evidence report integrity failure')
      await client.query('COMMIT')
      return { bytes: Buffer.from(report.report_bytes), sha256: report.report_sha256 as string }
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }

  async receive(taskId: string, connectorId: string, authorization: string | undefined, input: TrustedEvidenceInput) {
    const connector = this.authenticate(connectorId, authorization)
    boundedText(taskId, 'task_id', 128)
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['submission_id','spec_revision','code_revision','repository','run_id','check_id','result','report_base64','report_sha256','expires_at','publish_scope'].includes(k))) throw new TeamRepositoryError('invalid_request', 'invalid evidence envelope')
    if (typeof input.submission_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.submission_id)) throw new TeamRepositoryError('invalid_request', 'invalid submission identity')
    positiveRevision(input.spec_revision)
    boundedText(input.code_revision, 'code_revision', 200); boundedText(input.run_id, 'run_id', 128)
    if (input.repository !== connector.repository || !connector.checks.includes(input.check_id) || input.publish_scope !== 'team'
      || !['passed','failed','unverified'].includes(input.result)) throw new TeamRepositoryError('invalid_request', 'evidence outside connector scope')
    if (typeof input.report_base64 !== 'string' || input.report_base64.length > 2796204 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.report_base64)
      || typeof input.report_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.report_sha256)) throw new TeamRepositoryError('invalid_request', 'invalid evidence report')
    const report = Buffer.from(input.report_base64, 'base64')
    if (!report.length || report.length > 2097152 || report.toString('base64') !== input.report_base64 || artifactDigest(report) !== input.report_sha256) throw new TeamRepositoryError('artifact_integrity', 'evidence report hash mismatch')
    if (typeof input.expires_at !== 'string' || !Number.isFinite(Date.parse(input.expires_at))) throw new TeamRepositoryError('invalid_request', 'invalid evidence expiry')
    const fingerprint = stableDigest({ task_id: taskId, input }), client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await requireTeamAccess(client, connector.principal_user_id, true)
      const team = (await client.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE", [connector.team_id])).rows[0]
      const member = (await client.query("SELECT 1 FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' AND role='admin' FOR SHARE", [connector.team_id, connector.principal_user_id])).rows[0]
      if (!team || !member) throw new TeamRepositoryError('team_access_denied', 'connector authority revoked')
      const task = (await client.query("SELECT * FROM team_tasks WHERE task_id=$1 AND team_id=$2 AND state<>'deleted' FOR UPDATE", [taskId, connector.team_id])).rows[0]
      if (!task) throw new TeamRepositoryError('team_not_found', 'task not found')
      // Same run/check across Tasks is serialized too; a reused identity cannot
      // expose another Task's receipt or create two conflicting proof records.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`team:evidence:${connectorId}:${input.run_id}:${input.check_id}`])
      const prior = (await client.query('SELECT request_hash,receipt FROM team_trusted_evidence WHERE connector_id=$1 AND run_id=$2 AND check_id=$3', [connectorId, input.run_id, input.check_id])).rows[0]
      if (prior) {
        if (prior.request_hash !== fingerprint) throw new TeamRepositoryError('idempotency_conflict', 'connector run identity reused')
        await client.query('COMMIT'); return prior.receipt
      }
      if (!this.enabledForTeam(connector.team_id)) throw new TeamRepositoryError('team_feature_disabled', 'trusted evidence disabled')
      const expiry = Date.parse(input.expires_at), now = Date.now()
      if (expiry <= now || expiry > now + 24 * 60 * 60 * 1000) throw new TeamRepositoryError('invalid_request', 'evidence callback expired or exceeds validity window')
      if (!['open','in_progress'].includes(task.state)) throw new TeamRepositoryError('invalid_state', 'task is not accepting evidence')
      const submission = (await client.query(`SELECT s.*,a.attempt_id,a.step_id,a.attempt_no FROM team_task_submissions s
        LEFT JOIN team_task_step_attempts a ON a.call_id=s.source_call_id AND a.task_id=s.task_id WHERE s.task_id=$1 AND s.submission_id=$2`, [taskId, input.submission_id])).rows[0]
      if (!submission || submission.state !== 'published' || submission.delivery_role !== 'primary' || Number(submission.spec_revision) !== input.spec_revision || submission.code_revision !== input.code_revision) throw new TeamRepositoryError('revision_conflict', 'evidence must match the published delivery and code revision')
      const head = submission.attempt_id
        ? (await client.query('SELECT * FROM team_step_delivery_heads WHERE attempt_id=$1', [submission.attempt_id])).rows[0]
        : (await client.query('SELECT * FROM team_task_delivery_heads WHERE task_id=$1', [taskId])).rows[0]
      if (head?.latest_submission_id !== input.submission_id || Number(head.spec_revision) !== input.spec_revision
        || (submission.attempt_id && (await client.query('SELECT 1 FROM team_task_step_attempts WHERE task_id=$1 AND step_id=$2 AND attempt_no>$3', [taskId, submission.step_id, submission.attempt_no])).rows[0])) throw new TeamRepositoryError('revision_conflict', 'evidence target is no longer current')
      if ((await client.query('SELECT 1 FROM team_acceptance_decisions WHERE submission_id=$1', [input.submission_id])).rows[0]) throw new TeamRepositoryError('invalid_state', 'reviewed delivery cannot receive new evidence')
      const usage = (await client.query('SELECT count(*)::int count,COALESCE(sum(octet_length(report_bytes)),0) bytes FROM team_trusted_evidence WHERE task_id=$1', [taskId])).rows[0]
      if (usage.count >= 128 || Number(usage.bytes) + report.length > 32 * 1024 * 1024) throw new TeamRepositoryError('input_limit_exceeded', 'trusted evidence storage limit exceeded')
      const evidenceId = randomUUID(), revision = Number(head.revision) + 1
      const receipt = { evidence_id: evidenceId, task_id: taskId, submission_id: input.submission_id, connector_id: connectorId,
        source_kind: connector.kind, principal_user_id: connector.principal_user_id, run_id: input.run_id, check_id: input.check_id, report_sha256: input.report_sha256, revision, human_acceptance_created: false }
      await client.query(`INSERT INTO team_trusted_evidence(evidence_id,task_id,submission_id,connector_id,connector_kind,repository,run_id,check_id,spec_revision,code_revision,result,report_sha256,report_bytes,request_hash,receipt,principal_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`, [evidenceId,taskId,input.submission_id,connectorId,connector.kind,input.repository,input.run_id,input.check_id,input.spec_revision,input.code_revision,input.result,input.report_sha256,report,fingerprint,JSON.stringify(receipt),connector.principal_user_id])
      if (submission.attempt_id) await client.query('UPDATE team_step_delivery_heads SET revision=revision+1 WHERE attempt_id=$1', [submission.attempt_id])
      else await client.query('UPDATE team_task_delivery_heads SET revision=revision+1 WHERE task_id=$1', [taskId])
      await client.query("INSERT INTO team_delivery_outbox(event_id,task_id,kind,payload) VALUES($1,$2,'trusted_evidence_received',$3::jsonb)", [randomUUID(),taskId,JSON.stringify({evidence_id:evidenceId,submission_id:input.submission_id,attempt_id:submission.attempt_id??null})])
      await client.query('COMMIT'); return receipt
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
}
