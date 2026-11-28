import { teamEventView } from './event-repository.js'
import { validCodeStep, requireCodeGrant, type CodeStep } from './code-step.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { boundedText, stableDigest, validateReviewPolicy, type TaskReviewPolicy } from './delivery-contract.js'
import { TeamRepositoryError } from './repository.js'
import { createInitialTaskSpec } from './delivery-service.js'
import { TeamPlanService } from './plan-service.js'
import { validateTaskPlan, type TaskPlanStep } from './plan-contract.js'
import type { TeamEvent } from './types.js'

type Client = pg.PoolClient
type DraftMode = 'original' | 'independent' | 'plan'
interface Item {
  code?: CodeStep
  item_id: string
  instruction: string
  acceptance: string
  offer_id: string
  reviewer_user_id: number
  required_checks: string[]
  depends_on: string[]
}
interface Session {
  team_id: string
  team_session_id: string
  state: string
  current_context_version: string | number
}
export interface TaskDispatch {
  sessionId: string
  actorUserId: number
  instruction: string
  acceptance: string
  targetOfferIds: string[]
  contextVersion: number
  referenceEventId?: string | null
  reviewPolicy?: TaskReviewPolicy
}
interface Hooks {
  transaction<T>(run: (client: Client) => Promise<T>): Promise<T>
  session(client: Client, id: string, actor: number, lock: boolean): Promise<Session>
  dispatch(
    client: Client,
    input: TaskDispatch,
    teamId: string,
  ): Promise<{ task_id: string; event: TeamEvent; call_ids: string[] }>
  publish(session: string, recipients: number[], events: TeamEvent[]): void
  enqueue(ids: string[]): void
  enabled(team: string): boolean
  plans: TeamPlanService
}
const fail = (message: string): never => {
  throw new TeamRepositoryError('invalid_request', message)
}
const missing = (): never => {
  throw new TeamRepositoryError('team_not_found', '委托或原帖不可见')
}
const stale = (revision: number): never => {
  throw new TeamRepositoryError('revision_conflict', '方案已更新，请重新核对。', revision)
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const itemKey = /^[a-zA-Z0-9_-]{1,80}$/

function itemList(raw: unknown, mode: DraftMode): Item[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 16 || (mode === 'original' && raw.length !== 1))
    return fail('请填写 1 至 16 项分工')
  const ids = new Set<string>()
  const items = raw.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.item_id !== 'string' ||
      !itemKey.test(item.item_id) ||
      ids.has(item.item_id)
    )
      return fail('分工标识重复或无效')
    ids.add(item.item_id)
    if (item.code != null && (mode !== 'plan' || !validCodeStep(item.code))) return fail('代码步骤配置无效')
    boundedText(item.instruction, 'instruction', 16000)
    boundedText(item.acceptance, 'acceptance', 8000)
    validateReviewPolicy({
      primary_offer_id: item.offer_id,
      reviewer_user_id: item.reviewer_user_id,
      required_checks: item.required_checks,
    })
    if (
      !Array.isArray(item.depends_on) ||
      item.depends_on.length > 16 ||
      item.depends_on.some((v: unknown) => typeof v !== 'string') ||
      (mode !== 'plan' && item.depends_on.length)
    )
      return fail('依赖项需要步骤计划')
    return {
      ...(item.code ? { code: item.code } : {}),
      item_id: item.item_id,
      offer_id: item.offer_id,
      reviewer_user_id: item.reviewer_user_id,
      required_checks: item.required_checks,
      depends_on: item.depends_on,
      instruction: item.instruction,
      acceptance: item.acceptance,
    }
  })
  return items
}
const policy = (item: Item): TaskReviewPolicy => ({
  primary_offer_id: item.offer_id,
  reviewer_user_id: item.reviewer_user_id,
  required_checks: item.required_checks,
})
const steps = (items: Item[]): TaskPlanStep[] =>
  items.map((item) => ({
    ...(item.code ? { code: item.code } : {}),
    step_id: item.item_id,
    title: item.instruction.split('\n')[0].slice(0, 120),
    instruction: item.instruction,
    acceptance: item.acceptance,
    required: true,
    depends_on: item.depends_on,
    review_policy: policy(item),
  }))

export class TeamGroupAssignments {
  constructor(private readonly hooks: Hooks) {}

  private async view(client: Client, session: string, id: string) {
    if (!uuid.test(id)) return missing()
    const row = (
      await client.query('SELECT * FROM team_session_assignments WHERE team_session_id=$1 AND assignment_id=$2', [
        session,
        id,
      ])
    ).rows[0]
    if (!row) return missing()
    const items = (
      await client.query(
        `SELECT i.*,t.state AS task_state,c.state AS call_state,c.call_id,latest.state AS step_state,latest.attempt_id FROM team_session_assignment_items i
      LEFT JOIN team_tasks t ON t.task_id=i.task_id LEFT JOIN collaboration_calls c ON c.event_id=i.event_id AND c.offer_id=i.offer_id
      LEFT JOIN LATERAL (SELECT a.state,a.attempt_id FROM team_task_step_attempts a WHERE a.task_id=i.task_id AND a.step_id=i.item_id AND i.event_id IS NULL ORDER BY a.attempt_no DESC LIMIT 1) latest ON true
      WHERE i.assignment_id=$1 ORDER BY i.position`,
        [id],
      )
    ).rows
    return { ...row, context_version: Number(row.context_version), items }
  }

  async find(session: string, actor: number, key: string, value: string) {
    return this.hooks.transaction(async (client) => {
      await this.hooks.session(client, session, actor, false)
      if (key === 'id') return this.view(client, session, value)
      const row =
        key === 'source'
          ? (
              await client.query(
                `SELECT a.assignment_id FROM team_session_assignments a JOIN collaboration_events s ON s.event_id=a.source_event_id
            JOIN collaboration_events e ON e.team_session_id=a.team_session_id AND (e.event_id=s.event_id OR (e.kind='agent_message' AND s.kind='agent_message' AND e.call_id=s.call_id))
            WHERE a.team_session_id=$1 AND e.event_id=$2`,
                [session, value],
              )
            ).rows[0]
          : (
              await client.query(
                'SELECT response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3',
                [actor, 'group-assignment:' + session, value],
              )
            ).rows[0]?.response
      return row ? this.view(client, session, row.assignment_id) : null
    })
  }

  async mutate(
    sessionId: string,
    actor: number,
    action: 'open' | 'edit' | 'confirm',
    id: string,
    b: Record<string, unknown>,
  ) {
    boundedText(b.request_id, 'request_id', 128)
    const request = b.request_id,
      operation = 'group-assignment:' + sessionId,
      fingerprint = stableDigest({ action, id, body: b })
    const calls: string[] = [],
      events: TeamEvent[] = [],
      recipients: number[] = []
    const response = await this.hooks.transaction(async (client) => {
      const session = await this.hooks.session(client, sessionId, actor, true)
      const prior = (
        await client.query(
          'SELECT request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3',
          [actor, operation, request],
        )
      ).rows[0]
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new TeamRepositoryError('idempotency_conflict', '请求 ID 已用于其他内容')
        return this.view(client, sessionId, prior.response.assignment_id)
      }
      if (!this.hooks.enabled(session.team_id))
        throw new TeamRepositoryError('team_feature_disabled', '请先为 Team 启用任务交付')
      if (session.state !== 'active') throw new TeamRepositoryError('invalid_state', '当前群不可派工')
      if (action === 'open') id = await this.open(client, session, actor, b.source_event_id)
      else {
        const draft = await this.view(client, sessionId, id)
        if (b.expected_revision !== draft.revision) return stale(draft.revision)
        if (action === 'edit') {
          if (draft.confirmed_by) throw new TeamRepositoryError('invalid_state', '已确认的方案已冻结')
          await this.edit(client, session, draft, b)
        } else if (!draft.confirmed_by) {
          if (!draft.items.length) return fail('请先保存并核对分工')
          if (Number(session.current_context_version) !== draft.context_version)
            throw new TeamRepositoryError('context_revision_conflict', '共享材料已更新，请重新保存并核对')
          for (const item of draft.items) {
            const target = await this.target(client, session, item)
            if (
              target.binding_id !== item.binding_id ||
              target.revision !== item.binding_revision ||
              target.offer_revision !== item.offer_revision ||
              target.owner_user_id !== item.owner_user_id
            )
              return stale(draft.revision)
          }
          calls.push(...(await this.confirm(client, session, actor, draft, events)))
          const members = await client.query(
            `SELECT p.user_id FROM collaboration_session_participants p JOIN collaboration_team_memberships m ON m.user_id=p.user_id AND m.team_id=$2 AND m.state='active' WHERE p.team_session_id=$1 AND p.state='active'`,
            [sessionId, session.team_id],
          )
          recipients.push(...members.rows.map((m) => Number(m.user_id)))
        }
      }
      await client.query(
        'INSERT INTO collaboration_team_idempotency(user_id,operation,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',
        [actor, operation, request, fingerprint, JSON.stringify({ assignment_id: id })],
      )
      return this.view(client, sessionId, id)
    })
    if (events.length) this.hooks.publish(sessionId, recipients, events)
    if (calls.length) this.hooks.enqueue(calls)
    return response
  }

  private async open(client: Client, session: Session, actor: number, source: unknown): Promise<string> {
    boundedText(source, 'source_event_id', 128)
    const event = (
      await client.query(
        `SELECT e.*,c.binding_id,c.binding_revision,c.offer_revision,c.offer_id,c.event_id AS trigger_id,c.state AS call_state,c.execution_mode
      FROM collaboration_events e LEFT JOIN collaboration_calls c ON c.call_id=e.call_id AND c.team_session_id=e.team_session_id AND c.offer_id=e.author_offer_id
      WHERE e.team_session_id=$1 AND e.event_id=$2 AND e.kind IN ('member_message','agent_message')`,
        [session.team_session_id, source],
      )
    ).rows[0]
    if (!event) return missing()
    let sourceId = event.event_id,
      text = event.content
    if (event.kind === 'agent_message') {
      if (event.call_state !== 'completed') throw new TeamRepositoryError('invalid_state', '请等待 Agent 完成这次回复')
      const chunks = (
        await client.query(
          `SELECT event_id,content FROM collaboration_events WHERE team_session_id=$1 AND call_id=$2 AND kind='agent_message' AND author_offer_id=$3 ORDER BY event_seq`,
          [session.team_session_id, event.call_id, event.offer_id],
        )
      ).rows
      sourceId = chunks[0].event_id
      text = chunks.map((row) => row.content).join('')
    }
    const anchor = event.trigger_id ?? event.reference_event_id ?? sourceId
    const thread = (
      await client.query(
        `WITH RECURSIVE ancestors AS (
      SELECT event_id,reference_event_id,event_seq FROM collaboration_events WHERE team_session_id=$1 AND event_id=$2
      UNION ALL SELECT e.event_id,e.reference_event_id,e.event_seq FROM collaboration_events e JOIN ancestors a ON e.event_id=a.reference_event_id
        WHERE e.team_session_id=$1 AND e.event_seq<a.event_seq
    ) SELECT event_id FROM ancestors ORDER BY event_seq LIMIT 1`,
        [session.team_session_id, anchor],
      )
    ).rows[0]
    if (!thread) return missing()
    boundedText(text, '方案原文', 32000)
    const original = event.execution_mode === 'discussion' && event.kind === 'agent_message'
    const result = await client.query(
      `INSERT INTO team_session_assignments(assignment_id,team_session_id,thread_event_id,source_event_id,source_text,source_offer_id,source_binding_id,
      proposal,context_version,context_hash,creator_user_id,mode,source_binding_revision,source_offer_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$5,$8,(SELECT content_hash FROM collaboration_context_versions WHERE team_session_id=$2 AND version=$8),$9,$10,$11,$12)
      ON CONFLICT(team_session_id,source_event_id) DO NOTHING RETURNING assignment_id`,
      [
        randomUUID(),
        session.team_session_id,
        thread.event_id,
        sourceId,
        text,
        event.offer_id ?? null,
        original ? event.binding_id : null,
        Number(session.current_context_version),
        actor,
        original ? 'original' : 'independent',
        original ? event.binding_revision : null,
        original ? event.offer_revision : null,
      ],
    )
    return (
      result.rows[0]?.assignment_id ??
      (
        await client.query(
          'SELECT assignment_id FROM team_session_assignments WHERE team_session_id=$1 AND source_event_id=$2',
          [session.team_session_id, sourceId],
        )
      ).rows[0].assignment_id
    )
  }

  private async target(client: Client, session: Session, item: Item) {
    const binding = (
      await client.query(
        `SELECT b.binding_id,b.revision,d.agents,o.provider,o.revision AS offer_revision,o.owner_user_id FROM collaboration_session_agent_bindings b
      JOIN team_agent_offers o ON o.offer_id=b.offer_id AND o.team_id=$3 AND o.state='active'
      JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id AND d.status='online'
      JOIN users u ON u.id=o.owner_user_id AND u.team_enabled
      JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=u.id AND m.state='active'
      WHERE b.team_session_id=$1 AND b.offer_id=$2 AND b.state='active'
      AND d.collaboration_capabilities @> '["team_task_delivery_v1","team_collaboration_dispatch_v1","team_collaboration_context_v1"]'::jsonb FOR SHARE OF b,o,d,u,m`,
        [session.team_session_id, item.offer_id, session.team_id],
      )
    ).rows[0]
    if (!binding) throw new TeamRepositoryError('agent_unavailable', '所选 Agent 已离线、撤回或缺少交付能力')
    if (item.code) requireCodeGrant(item.code, binding.agents, binding.provider, session.team_id, item.offer_id)
    const reviewer = await client.query(
      `SELECT 1 FROM collaboration_session_participants p JOIN users u ON u.id=p.user_id AND u.team_enabled
      JOIN collaboration_team_memberships m ON m.team_id=$3 AND m.user_id=p.user_id AND m.state='active' AND m.role<>'viewer'
      WHERE p.team_session_id=$1 AND p.user_id=$2 AND p.state='active' FOR SHARE OF p,m,u`,
      [session.team_session_id, item.reviewer_user_id, session.team_id],
    )
    if (!reviewer.rowCount) throw new TeamRepositoryError('reviewer_required', '请选择当前群内可验收的成员')
    return binding
  }

  private async edit(client: Client, session: Session, draft: any, b: Record<string, unknown>) {
    const mode = b.mode
    if (mode !== 'independent' && mode !== 'original' && mode !== 'plan') return fail('未知的委托类型')
    boundedText(b.proposal, 'proposal', 16000)
    if (b.context_version !== Number(session.current_context_version))
      throw new TeamRepositoryError('context_revision_conflict', '共享材料已更新')
    const items = itemList(b.items, mode)
    if (mode === 'plan')
      validateTaskPlan({
        request_id: 'draft',
        expected_revision: 0,
        spec_revision: 1,
        context_version: b.context_version,
        team_session_id: session.team_session_id,
        steps: steps(items),
      })
    const ids = b.reference_event_ids ?? []
    if (
      !Array.isArray(ids) ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || id.length > 128)
    )
      return fail('引用无效')
    const refs = (
      await client.query(
        `SELECT event_id,author_user_id,author_offer_id,content FROM collaboration_events WHERE team_session_id=$1 AND event_id=ANY($2::text[]) AND kind IN ('member_message','agent_message') ORDER BY event_seq`,
        [session.team_session_id, ids],
      )
    ).rows
    if (refs.length !== ids.length) return missing()
    if (Buffer.byteLength(JSON.stringify(refs)) + Buffer.byteLength(b.proposal) > 24000)
      return fail('必需方案与引用超过上下文预算，请缩小选取范围')
    await client.query('DELETE FROM team_session_assignment_items WHERE assignment_id=$1', [draft.assignment_id])
    for (const [position, item] of items.entries()) {
      const target = await this.target(client, session, item)
      if (
        mode === 'original' &&
        (target.binding_id !== draft.source_binding_id ||
          Number(target.revision) !== Number(draft.source_binding_revision) ||
          Number(target.offer_revision) !== Number(draft.source_offer_revision) ||
          item.offer_id !== draft.source_offer_id)
      )
        return fail('按这版实施须交回原讨论 Agent')
      await client.query(
        `INSERT INTO team_session_assignment_items(assignment_id,item_id,position,offer_id,binding_id,binding_revision,offer_revision,owner_user_id,instruction,acceptance,reviewer_user_id,required_checks,depends_on,code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)`,
        [
          draft.assignment_id,
          item.item_id,
          position,
          item.offer_id,
          target.binding_id,
          target.revision,
          target.offer_revision,
          target.owner_user_id,
          item.instruction,
          item.acceptance,
          item.reviewer_user_id,
          JSON.stringify(item.required_checks),
          JSON.stringify(item.depends_on),
          item.code ? JSON.stringify(item.code) : null,
        ],
      )
    }
    await client.query(
      `UPDATE team_session_assignments SET mode=$2,proposal=$3,references_snapshot=$4::jsonb,revision=revision+1,context_version=$5,
      context_hash=(SELECT content_hash FROM collaboration_context_versions WHERE team_session_id=$6 AND version=$5) WHERE assignment_id=$1`,
      [draft.assignment_id, mode, b.proposal, JSON.stringify(refs), b.context_version, session.team_session_id],
    )
  }

  private async confirm(
    client: Client,
    session: Session,
    actor: number,
    draft: any,
    events: TeamEvent[],
  ): Promise<string[]> {
    const items: Item[] = draft.items,
      calls: string[] = []
    const material = [
      draft.proposal,
      ...draft.references_snapshot.map(
        (r: any) => `引用 ${r.event_id} · ${r.author_offer_id ?? r.author_user_id}\n${r.content}`,
      ),
    ].join('\n\n')
    if (draft.mode === 'plan') {
      const task = 'ctk_' + randomUUID(),
        acceptance = items.map((i) => i.acceptance).join('\n')
      await client.query(
        'INSERT INTO team_tasks(task_id,team_id,creator_user_id,title,background) VALUES($1,$2,$3,$4,$5)',
        [task, session.team_id, actor, draft.proposal.split('\n')[0].slice(0, 240), material],
      )
      await client.query('INSERT INTO team_task_holders(task_id,user_id) VALUES($1,$2)', [task, actor])
      await createInitialTaskSpec(client, task, actor, material, acceptance, policy(items[items.length - 1]))
      await client.query('UPDATE team_session_assignment_items SET task_id=$2 WHERE assignment_id=$1', [
        draft.assignment_id,
        task,
      ])
      await this.hooks.plans.saveDraftInTransaction(client, task, actor, {
        request_id: randomUUID(),
        expected_revision: 0,
        spec_revision: 1,
        context_version: draft.context_version,
        team_session_id: session.team_session_id,
        steps: steps(items),
      })
    } else {
      for (const item of items) {
        const result = await this.hooks.dispatch(
          client,
          {
            sessionId: session.team_session_id,
            actorUserId: actor,
            instruction: item.instruction,
            acceptance: item.acceptance,
            targetOfferIds: [item.offer_id],
            contextVersion: draft.context_version,
            referenceEventId: draft.source_event_id,
            reviewPolicy: policy(item),
          },
          session.team_id,
        )
        await client.query(
          'UPDATE team_session_assignment_items SET task_id=$3,event_id=$4 WHERE assignment_id=$1 AND item_id=$2',
          [draft.assignment_id, item.item_id, result.task_id, result.event.id],
        )
        events.push(result.event)
        calls.push(...result.call_ids)
      }
    }
    const posted = await client.query(
      `WITH seq AS (UPDATE collaboration_sessions SET latest_event_seq=latest_event_seq+1,updated_at=NOW() WHERE team_session_id=$1 RETURNING latest_event_seq)
      INSERT INTO collaboration_events(event_id,team_session_id,event_seq,kind,author_user_id,reference_event_id,reference_event_seq,context_version,content)
      SELECT $2,$1,seq.latest_event_seq,'system',$3,e.event_id,e.event_seq,$4,$5 FROM seq,collaboration_events e WHERE e.event_id=$6 RETURNING *`,
      [
        session.team_session_id,
        'cev_' + randomUUID(),
        actor,
        draft.context_version,
        `已确认方案 v${draft.revision}，共 ${items.length} 项分工。${draft.mode === 'plan' ? '步骤计划等待激活。' : ''}`,
        draft.thread_event_id,
      ],
    )
    events.push(teamEventView(posted.rows[0]))
    await client.query(
      'UPDATE team_session_assignments SET confirmed_by=$2,confirmed_at=NOW() WHERE assignment_id=$1',
      [draft.assignment_id, actor],
    )
    return calls
  }
}
