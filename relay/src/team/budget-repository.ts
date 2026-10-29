import type pg from 'pg'
import type { TaskBudgetPolicy } from './budget-service.js'
import { TeamRepositoryError } from './repository.js'

/** Caller must authorize the Task and hold its SHARE/UPDATE lock. Usage is
 * observed from existing immutable facts, never private session totals. No
 * time-window guesses, synthetic usage receipts or second billing ledger. */
export class TeamTaskBudgetRepository {
  /** Recheck after reservation writes/lock waits. Throwing rolls back the whole
   * reservation, including its message, Call, attempt and queue signal. */
  async requireDurationCapacity(client: Pick<pg.PoolClient, 'query'>, taskId: string): Promise<void> {
    const row = (await client.query(`SELECT COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-started_at)
      >=(budget_policy->>'max_duration_seconds')::int,false) exhausted
      FROM team_task_plan_runtime WHERE task_id=$1`, [taskId])).rows[0]
    if (!row) throw new TeamRepositoryError('invalid_state', 'plan budget unavailable')
    if (row.exhausted) throw new TeamRepositoryError('budget_exhausted', 'plan duration limit reached; issued Calls are not stopped')
  }

  async snapshot(client: Pick<pg.PoolClient, 'query'>, taskId: string) {
    const runtime = (await client.query(`SELECT invocation_limit,budget_policy,started_at,
      COALESCE(EXTRACT(EPOCH FROM clock_timestamp()-started_at)>=(budget_policy->>'max_duration_seconds')::int,false) duration_exhausted
      FROM team_task_plan_runtime WHERE task_id=$1`, [taskId])).rows[0]
    if (!runtime) return null
    const counts = (await client.query(`SELECT count(*)::int invocation_count,
      count(*) FILTER(WHERE c.state IN ('pending','dispatched','accepted','uncertain') OR (c.state IS NULL AND a.state IN ('reserved','dispatched','running','unknown')))::int in_flight
      FROM team_task_step_attempts a LEFT JOIN collaboration_calls c ON c.call_id=a.call_id WHERE a.task_id=$1`, [taskId])).rows[0]
    // Only generation-qualified Team root-message projections can identify a
    // native fact. Subagent detail and session lifetime aggregates are not
    // added: their overlap/attribution is not proven by this contract.
    // Accounting defaults missing components to zero. Require an original
    // measured component before treating a fact as observed usage; usage:{}
    // and total-only reports cannot establish the component total we expose.
    const usage = (await client.query(`WITH links AS (
      SELECT f.fact_key,MIN(c.call_id) call_id,MAX(f.input::numeric+f.output+f.cache_read+f.cache_create) tokens
      FROM team_task_step_attempts a JOIN collaboration_calls c ON c.call_id=a.call_id
      JOIN team_agent_offers o ON o.offer_id=c.offer_id
      JOIN collaboration_events e ON e.call_id=c.call_id AND e.kind='agent_message'
      LEFT JOIN event_inbox i ON e.native_source_event_id IS NULL AND i.daemon_id=o.daemon_id AND i.user_id=o.owner_user_id AND i.session_id=c.native_session_id
        AND e.request_id='transport:'||i.daemon_id||':'||i.daemon_generation||':'||i.seq AND i.event_type='agent_text'
      JOIN token_usage_facts f ON f.source_event_id=COALESCE(e.native_source_event_id,i.materialized_event_id) AND f.user_id=o.owner_user_id
        AND f.daemon_id=o.daemon_id AND f.session_id=c.native_session_id AND NOT f.session_attribution_revoked
      JOIN events source ON source.id=f.source_event_id AND source.session_id=c.native_session_id
      WHERE a.task_id=$1 AND EXISTS (
        SELECT 1 FROM (VALUES ('input_tokens'),('output_tokens'),('cache_read_tokens'),('cache_create_tokens')) component(name)
        WHERE jsonb_typeof(COALESCE(source.payload,source.body_header)->'usage'->component.name)='number'
          AND (COALESCE(source.payload,source.body_header)->'usage'->>component.name) ~ '^[0-9]+$'
      ) GROUP BY f.fact_key HAVING count(DISTINCT c.call_id)=1
    ), external_links AS (
      SELECT f.fact_key,c.call_id,(f.input::numeric+f.output+f.cache_read+f.cache_create) tokens
      FROM team_task_step_attempts a JOIN collaboration_calls c ON c.call_id=a.call_id
      JOIN team_agent_offers o ON o.offer_id=c.offer_id AND o.provider='agentteams'
      JOIN team_external_usage_facts x ON x.call_id=c.call_id AND x.request_id=c.provider_request_id
      JOIN token_usage_facts f ON f.fact_key=x.fact_key AND f.user_id=o.owner_user_id AND f.daemon_id=o.daemon_id
        AND f.session_id=c.native_session_id AND NOT f.session_attribution_revoked
      WHERE a.task_id=$1
    ), all_links AS (SELECT * FROM links UNION SELECT * FROM external_links)
    SELECT count(*)::int fact_count,count(DISTINCT call_id)::int attributed_calls,SUM(tokens)::text observed_tokens FROM all_links`, [taskId])).rows[0]
    const policy = runtime.budget_policy as TaskBudgetPolicy
    return { scope: 'plan_attempts', policy, invocation_limit: Number(runtime.invocation_limit), invocation_count: counts.invocation_count,
      in_flight: counts.in_flight, started_at: Object.keys(policy).length ? runtime.started_at : null, duration_exhausted: runtime.duration_exhausted,
      issued_calls_stopped: false,
      capabilities: { invocations: 'reservation_limit', concurrency: 'reservation_limit', duration: 'stop_future_dispatch',
        tokens: 'observe_only', token_hard_limit: false, native_round_limit: false, estimated_cost: false },
      usage: { observed_tokens: usage.observed_tokens as string | null, fact_count: usage.fact_count, attributed_calls: usage.attributed_calls,
        coverage: usage.fact_count ? 'partial' : 'unavailable', includes_subagents: 'unknown', estimated_cost: null,
        token_warning_exceeded: policy.token_warning_limit && usage.observed_tokens !== null ? BigInt(usage.observed_tokens) >= BigInt(policy.token_warning_limit) : false,
        limitations: ['root_facts_only','shared_session_attribution','late_usage','retained_source_links'] } }
  }
}
