import type pg from 'pg';

/** Apply the durable create request's project exactly once after the session row exists. */
export async function attachReservedSessionProject(pool: Pick<pg.Pool, 'query'>, input: {
  reservationId: string;
  userId: number;
  daemonId: string;
  requestId: string;
  sessionId: string;
}): Promise<void> {
  await pool.query(`WITH attached AS (
    UPDATE sessions AS s SET project_id = p.id, membership_changed_at = NOW(),
      manual_rank = CASE WHEN p.order_mode='manual' THEN
        COALESCE((SELECT MIN(other.manual_rank) FROM sessions AS other
          WHERE other.user_id=p.user_id AND other.project_id=p.id AND other.archived_at IS NULL),1024)-1024
        ELSE NULL END
    FROM quota_reservations AS r JOIN session_projects AS p ON p.id=r.project_id AND p.user_id=r.user_id
    WHERE r.id=$1 AND r.user_id=$2 AND r.daemon_id=$3 AND r.request_id=$4
      AND s.session_id=$5 AND s.user_id=$2 AND s.project_id IS NULL
    RETURNING s.project_id
  ) UPDATE session_projects SET revision=revision+1 WHERE id IN (SELECT project_id FROM attached)`,
  [input.reservationId, input.userId, input.daemonId, input.requestId, input.sessionId]);
}
