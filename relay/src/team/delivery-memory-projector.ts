import { recordDeliveryWithdrawal } from './delivery-withdrawal-ledger.js'
import type pg from 'pg'
import { buildAcceptedDeliveryMemorySourceRecords } from './accepted-delivery-memory-source.js'

type DB = Pick<pg.PoolClient, 'query'>
export interface DeliveryMemoryRevocation {
  teamId?: string
  teamSessionId?: string
  userId?: number
  participantRevision?: number
  bindingId?: string
  bindingRevision?: number
  submissionId?: string
  reason: 'artifact_revoked' | 'participant_removed' | 'binding_removed' | 'team_member_left' | 'team_member_removed' | 'team_dissolved'
}

/** Caller holds the live Team share lock and Task write lock in the acceptance
 * transaction. Membership/binding lifecycle uses the Team write lock; session
 * participant lifecycle uses the Session write lock acquired below. */
export async function projectAcceptedDeliveryMemory(client: DB, decisionId: string, teamId: string): Promise<number> {
  const accepted = (await client.query(`
    SELECT d.decision_id,d.created_at AS accepted_at,d.reviewer_user_id,
           s.submission_id,s.task_id,s.spec_revision,s.version,s.summary,s.manifest_sha256,
           s.source_call_id,s.source_offer_id,s.context_version,s.published_at,
           spec.goal,spec.acceptance,spec.created_by_user_id,spec.created_at AS spec_created_at,
           session.team_id,session.team_session_id
    FROM team_acceptance_decisions d
    JOIN team_task_submissions s ON s.submission_id=d.submission_id AND s.task_id=d.task_id AND s.spec_revision=d.spec_revision
    JOIN team_task_specs spec ON spec.task_id=s.task_id AND spec.revision=s.spec_revision AND spec.reviewer_user_id=d.reviewer_user_id
    JOIN collaboration_calls call ON call.call_id=s.source_call_id AND call.task_id=s.task_id
    JOIN collaboration_sessions session ON session.team_session_id=call.team_session_id
    JOIN collaboration_teams team ON team.team_id=session.team_id AND team.state='active'
    WHERE d.decision_id=$1 AND session.team_id=$2 AND d.decision='accepted' AND s.state='published'
      AND session.state IN ('active','paused')
      AND NOT EXISTS(SELECT 1 FROM team_artifact_revocations r WHERE r.submission_id=s.submission_id)
    FOR SHARE OF session
  `, [decisionId, teamId])).rows[0]
  if (!accepted) return 0
  const binding = (await client.query(`
    SELECT b.binding_id,b.revision,b.installation_id,b.owner_scope_kind,b.owner_scope_id
    FROM team_memory_bindings b
    JOIN extension_installations target ON target.installation_id=b.installation_id
      AND target.provider_id='pocketctl-memory' AND target.status='active'
      AND target.owner_scope_kind=b.owner_scope_kind AND target.owner_scope_id=b.owner_scope_id
    WHERE b.team_id=$1 AND b.state='active' FOR SHARE OF b,target
  `, [accepted.team_id])).rows[0]
  if (!binding) return 0
  const readers = (await client.query(`
    SELECT p.user_id,p.revision AS participant_revision
    FROM collaboration_session_participants p
    JOIN collaboration_team_memberships m ON m.team_id=$2 AND m.user_id=p.user_id AND m.state='active'
    JOIN users u ON u.id=p.user_id AND u.team_enabled
    JOIN extension_installations i ON i.owner_user_id=p.user_id AND i.owner_scope_kind='personal'
      AND i.provider_id='pocketctl-memory' AND i.status IN ('pending','active')
      AND i.subscriptions @> ARRAY['session.event.v1']::text[]
      AND i.enabled_services @> ARRAY['memory.manage']::text[]
      AND i.granted_scopes @> ARRAY['session:events:read']::text[]
    WHERE p.team_session_id=$1 AND p.state='active'
    ORDER BY p.user_id,i.installation_id FOR SHARE OF p,m,i
  `, [accepted.team_session_id, accepted.team_id])).rows
  const records = buildAcceptedDeliveryMemorySourceRecords({
    teamId: accepted.team_id, teamSessionId: accepted.team_session_id, taskId: accepted.task_id,
    callId: accepted.source_call_id, contextVersion: Number(accepted.context_version),
    binding: { id: binding.binding_id, revision: Number(binding.revision), installationId: binding.installation_id,
      ownerScopeKind: binding.owner_scope_kind, ownerScopeId: binding.owner_scope_id },
    spec: { revision: Number(accepted.spec_revision), goal: accepted.goal, acceptance: accepted.acceptance,
      authorUserId: Number(accepted.created_by_user_id), createdAt: accepted.spec_created_at },
    submission: { id: accepted.submission_id, version: Number(accepted.version), summary: accepted.summary,
      manifestSha256: accepted.manifest_sha256, authorOfferId: accepted.source_offer_id, publishedAt: accepted.published_at },
    decision: { id: accepted.decision_id, decision: 'accepted', reviewerUserId: Number(accepted.reviewer_user_id), createdAt: accepted.accepted_at },
    readers: readers.map(row => ({ userId: Number(row.user_id), participantRevision: Number(row.participant_revision) })),
  })
  let inserted = 0
  const captured = new Set<string>()
  for (const record of records) {
    if (record.payload.source_role === 'goal') {
      const scope = record.payload.read_scope as Record<string, unknown>
      const receipt = await client.query(`INSERT INTO team_delivery_memory_sources
        (source_session_id,decision_id,submission_id,team_id,team_session_id,binding_id,binding_revision,reader_user_id,participant_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(decision_id,reader_user_id) DO NOTHING RETURNING source_session_id`,
      [record.sessionId, decisionId, accepted.submission_id, accepted.team_id, accepted.team_session_id,
        binding.binding_id, binding.revision, record.ownerUserId, scope.participant_revision])
      if (receipt.rowCount) captured.add(record.sessionId)
    }
    if (!captured.has(record.sessionId)) continue
    const result = await client.query(`INSERT INTO extension_source_outbox
      (source_kind,source_id,owner_user_id,session_id,event_type,occurred_at,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(source_kind,source_id) DO NOTHING`,
    [record.sourceKind, record.sourceId, record.ownerUserId, record.sessionId, record.eventType, record.occurredAt, JSON.stringify(record.payload)])
    inserted += result.rowCount ?? 0
  }
  return inserted
}

/** Always available, even with capture disabled or the installation removed.
 * Caller owns the corresponding Team/Session/Task lifecycle lock. */
export async function revokeAcceptedDeliveryMemory(client: DB, input: DeliveryMemoryRevocation): Promise<number> {
  if (!input.submissionId && !input.teamSessionId && !(input.teamId && input.bindingId)) {
    throw new Error('accepted delivery revocation requires an exact source boundary')
  }
  const sources = (await client.query(`
    UPDATE team_delivery_memory_sources SET revoked_at=COALESCE(revoked_at,NOW()),revocation_reason=COALESCE(revocation_reason,$8),
      withdrawn_at=CASE WHEN $8='artifact_revoked' THEN NOW() ELSE withdrawn_at END
    WHERE (CASE WHEN $8='artifact_revoked' THEN withdrawn_at IS NULL ELSE revoked_at IS NULL END)
      AND ($1::text IS NULL OR team_id=$1)
      AND ($2::text IS NULL OR team_session_id=$2) AND ($3::int IS NULL OR reader_user_id=$3)
      AND ($4::bigint IS NULL OR participant_revision=$4) AND ($5::text IS NULL OR binding_id=$5)
      AND ($6::bigint IS NULL OR binding_revision=$6) AND ($7::uuid IS NULL OR submission_id=$7)
    RETURNING source_session_id,decision_id,submission_id,team_id,team_session_id,
      binding_id,binding_revision,reader_user_id,participant_revision
  `, [input.teamId ?? null, input.teamSessionId ?? null, input.userId ?? null, input.participantRevision ?? null,
    input.bindingId ?? null, input.bindingRevision ?? null, input.submissionId ?? null, input.reason])).rows
  let inserted = 0
  for (const source of sources) {
    if (input.reason === 'artifact_revoked') await recordDeliveryWithdrawal(client, source)
    const result = await client.query(`INSERT INTO extension_source_outbox
      (source_kind,source_id,owner_user_id,session_id,event_type,occurred_at,payload)
      VALUES('session_access_revoked',$1,$2,$3,'session_access_revoked',NOW(),$4::jsonb)
      ON CONFLICT(source_kind,source_id) DO NOTHING`,
    [`team-delivery-${input.reason === 'artifact_revoked' ? 'withdraw' : 'revoke'}:${source.source_session_id}`, source.reader_user_id, source.source_session_id, JSON.stringify({
      reason: input.reason, team_delivery_source_revoked: true,
      submission_id: source.submission_id, decision_id: source.decision_id,
      team_id: source.team_id, team_session_id: source.team_session_id,
      team_memory_binding_id: source.binding_id, team_memory_binding_revision: Number(source.binding_revision),
      participant_user_id: Number(source.reader_user_id), participant_revision: Number(source.participant_revision),
    })])
    inserted += result.rowCount ?? 0
  }
  return inserted
}
