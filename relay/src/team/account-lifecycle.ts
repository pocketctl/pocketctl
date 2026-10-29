import type pg from 'pg'
import { TeamMemorySourceProjector } from './memory-source-projector.js'

/** Called only within deleteUserAccount's user-locked transaction. Shared
 * history survives; private account/daemon rows are still physically deleted.
 * Creator deletion follows the existing creator-must-dissolve policy. */
export async function revokeTeamAccount(client: pg.PoolClient, actor: number): Promise<void> {
  const teams = (await client.query(`SELECT t.team_id,t.creator_user_id,t.state FROM collaboration_teams t
    WHERE t.creator_user_id=$1
      OR EXISTS(SELECT 1 FROM collaboration_team_memberships m WHERE m.team_id=t.team_id AND m.user_id=$1)
      OR EXISTS(SELECT 1 FROM team_agent_offers o WHERE o.team_id=t.team_id AND o.owner_user_id=$1)
    ORDER BY t.team_id FOR UPDATE OF t`, [actor])).rows
  const owned = teams.filter(t => Number(t.creator_user_id) === actor).map(t => t.team_id)
  const affected = teams.map(t => t.team_id)
  const readers = (await client.query(`SELECT p.participant_id,p.team_session_id,p.user_id,p.revision
    FROM collaboration_session_participants p JOIN collaboration_sessions s USING(team_session_id)
    WHERE p.state='active' AND (p.user_id=$1 OR s.team_id=ANY($2::text[]))
    ORDER BY p.team_session_id,p.user_id FOR UPDATE OF p`, [actor,owned])).rows
  const projector = new TeamMemorySourceProjector(false)
  for (const reader of readers) await projector.revokeReaderSession(client, {
    teamSessionId:reader.team_session_id,userId:Number(reader.user_id),participantRevision:Number(reader.revision),
    reason:Number(reader.user_id) === actor ? 'team_member_removed' : 'team_dissolved',
  })
  await client.query(`UPDATE collaboration_session_participants SET state='removed',revision=revision+1,updated_at=NOW(),removed_at=NOW()
    WHERE participant_id=ANY($1::text[])`, [readers.map(r => r.participant_id)])
  await client.query(`UPDATE collaboration_team_invitations SET state='revoked',revision=revision+1,updated_at=NOW(),responded_at=NOW()
    WHERE state='pending' AND (invited_by_user_id=$1 OR team_id=ANY($2::text[]))`, [actor,owned])
  // Email-only invitations do not have the recipient FK cascade.
  await client.query(`DELETE FROM collaboration_team_invitations WHERE recipient_user_id=$1
    OR lower(recipient_email) IN (SELECT lower(email) FROM users WHERE id=$1)`, [actor])
  await client.query(`UPDATE team_agent_offers SET state='revoked',revision=revision+1,updated_at=NOW(),revoked_at=NOW()
    WHERE state='active' AND (owner_user_id=$1 OR team_id=ANY($2::text[]))`, [actor,owned])
  await client.query(`UPDATE collaboration_session_agent_bindings b SET state='unavailable',revision=b.revision+1,updated_at=NOW(),removed_at=NOW()
    FROM team_agent_offers o WHERE b.offer_id=o.offer_id AND b.state='active'
      AND (o.owner_user_id=$1 OR o.team_id=ANY($2::text[]))`, [actor,owned])
  await client.query(`DELETE FROM collaboration_team_daemon_bindings WHERE owner_user_id=$1 OR team_id=ANY($2::text[])`, [actor,owned])
  await client.query(`WITH released AS (
    UPDATE team_task_holders h SET state='released',revision=h.revision+1,updated_at=NOW(),released_at=NOW()
    FROM team_tasks t WHERE h.task_id=t.task_id AND h.state='active' AND (h.user_id=$1 OR t.team_id=ANY($2::text[])) RETURNING h.task_id)
    UPDATE team_tasks SET revision=revision+1,updated_at=NOW() WHERE task_id IN (SELECT task_id FROM released)`, [actor,owned])
  await client.query(`UPDATE collaboration_team_memberships SET state='removed',revision=revision+1,updated_at=NOW(),ended_at=NOW()
    WHERE state='active' AND (user_id=$1 OR team_id=ANY($2::text[]))`, [actor,owned])
  // Fence future dispatch. Already dispatched native work is unknown, not
  // reported as stopped; this transaction does not issue native cancellation.
  await client.query(`UPDATE collaboration_calls c SET
      state=CASE WHEN c.state='pending' THEN 'blocked' ELSE 'uncertain' END,
      outcome='account_deleted',updated_at=NOW()
    FROM team_agent_offers o WHERE c.offer_id=o.offer_id AND c.state IN ('pending','dispatched','accepted')
      AND (o.owner_user_id=$1 OR o.team_id=ANY($2::text[]))`, [actor,owned])
  await client.query(`UPDATE collaboration_runs r SET state='blocked',terminal_reason='account_deleted',
      stop_requested=false,lease_token=lease_token+1,lease_owner=NULL,lease_expires_at=NULL,revision=r.revision+1,updated_at=NOW()
    FROM collaboration_sessions s WHERE r.team_session_id=s.team_session_id
      AND r.state IN ('ready','running','waiting_input','blocked','paused')
      AND (r.initiator_user_id=$1 OR s.team_id=ANY($2::text[])
        OR EXISTS(SELECT 1 FROM team_agent_offers o WHERE o.offer_id=r.coordinator_offer_id AND o.owner_user_id=$1))`, [actor,owned])
  await client.query(`UPDATE collaboration_teams SET state='dissolved',revision=revision+1,updated_at=NOW(),dissolved_at=NOW()
    WHERE team_id=ANY($1::text[]) AND state='active'`, [owned])
  await client.query(`UPDATE collaboration_teams SET revision=revision+1,updated_at=NOW()
    WHERE team_id=ANY($1::text[]) AND NOT(team_id=ANY($2::text[]))`, [affected,owned])
  // Only unpublished preparations belong exclusively to the deleting account.
  // Published Team copies, decisions, manifests and their hashes stay intact.
  const removed = await client.query(`DELETE FROM team_task_submissions WHERE submitted_by_user_id=$1 AND state='preparing' RETURNING submission_id`, [actor])
  await client.query(`INSERT INTO team_account_deletion_audit(actor_user_id,dissolved_teams,removed_preparations)
    VALUES($1,$2,$3) ON CONFLICT(actor_user_id) DO NOTHING`, [actor,owned.length,removed.rowCount ?? 0])
}
