import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { directLaunchFixture, type DirectLaunchFixture } from './direct-launch-fixture.js'
import { createSharedSourceScheduler } from '../../sources/shared-scheduler.js'
import {
  guardRetainedEvidence,
  assertRetainedSourceGuards,
  detachRetainedSourceGuards,
} from '../../sources/retained-authority.js'
import { createJobWorker } from '../../jobs/worker.js'
import { createJobRepository } from '../../jobs/repository.js'
import { createEpisodeRepository } from '../../episodes/repository.js'
import { createCurationExecutor } from '../../curation/executor.js'
import { createCurationWorker, curationTransaction } from '../../curation/worker.js'
import { loadCurrentLifecycleSources } from '../../curation/task-repository.js'
import { compileDialogue } from '../../episodes/compile-dialogue.js'
import { checkDialogueRef } from '../../episodes/turn-dialogue.js'

const url = process.env.TURN_DIALOGUE_TEST_DATABASE_URL
;(url ? describe : describe.skip)('terminal dialogue with real Relay and Memory roles', () => {
  let f: DirectLaunchFixture
  beforeAll(async () => {
    f = await directLaunchFixture(url!)
  }, 120_000)
  afterAll(async () => {
    await f?.close()
  })
  test('coalesces the closed turn, reads only selected text and rechecks raw evidence', async () => {
    const s = await f.source(),
      { inst } = await f.install(s, 'retained_history'),
      install = inst.installation_id
    let turn = 'turn-' + randomUUID()
    await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')", [install])
    await f.pool.query('INSERT INTO shared.memory_dialogue_installations(installation_id) VALUES($1)', [
      install,
    ])
    const journal = (
      await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)
    ).createPostgresExtensionJournalSink({ sharedHeaders: true })
    let seq = 0
    const emit = async (kind: string, fields: Record<string, unknown>, skillState = 'non_skill') => {
      const id = randomUUID(),
        payload = {
          type: kind,
          event_id: id,
          part_id: id,
          turn_id: turn,
          actor_scope: 'root',
          ...fields,
          memory_source: {
            version: 1,
            producer: 'codex',
            session_id: s.session,
            turn_id: turn,
            event_id: id,
            sequence: String(++seq),
            invocation_id: id,
            source_role: kind === 'user_text' ? 'user' : 'assistant',
            skill_state: skillState,
            lineage_complete: true,
            derived_from_event_ids: [],
          },
        }
      const row = (
        await f.publisher.query(
          `INSERT INTO public.events(session_id,user_id,event_type,payload,event_hash,effect_status)
    VALUES($1,$2,$3,$4,$5,'completed') RETURNING id::text`,
          [s.session, s.owner, kind, payload, id.replaceAll('-', '')],
        )
      ).rows[0]
      await journal.appendCanonicalEvent(f.publisher, {
        sourceEventId: row.id,
        ownerUserId: s.owner,
        sessionId: s.session,
        eventType: kind,
        occurredAt: null,
        payload,
      })
      return row.id
    }
    const prompt = await emit('user_text', { text: 'I prefer rail for personal travel.' })
    await emit('tool_result', { text: 'tool output' })
    await emit('agent_text', { message_phase: 'commentary', text: '正在检查' })
    await emit('tool_call', { actor_scope: 'subagent', tool: 'mcp__test__lookup' })
    const longAnswer = '说明。'.repeat(2200) + '已选择五分钟。'
    const answer = await emit('agent_text', { message_phase: 'final_answer', text: longAnswer })
    const jobs = () =>
      f.runtime.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND payload->>'turn'=$2", [
        install,
        turn,
      ])
    expect((await jobs()).rows).toHaveLength(0)
    await emit('turn_status', { turn_status: 'completed' })
    await f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    expect((await jobs()).rows).toHaveLength(1)
    const errors: unknown[] = []
    const queue = createJobWorker({
      pool: f.runtime,
      jobs: createJobRepository(f.runtime),
      workerId: 'turn-dialogue-test',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    queue.register('compile_episode', createEpisodeRepository(f.runtime).handleCompileEpisode)
    queue.start()
    try {
      await expect
        .poll(async () => ({ state: (await jobs()).rows[0]?.state, errors }), { timeout: 10000 })
        .toEqual({ state: 'completed', errors: [] })
    } finally {
      await queue.stop()
    }
    const scheduler = createSharedSourceScheduler({
      pool: f.runtime,
      workerId: 'dialogue-cutover-test',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    scheduler.start()
    try {
      await expect
        .poll(
          async () =>
            (
              await f.pool.query(
                'SELECT processed_revision>=revision AS caught_up FROM shared.memory_source_work WHERE root_key=$1',
                [f.root(s)],
              )
            ).rows[0]?.caught_up,
          { timeout: 10000 },
        )
        .toBe(true)
      expect(
        (
          await f.runtime.query(
            "SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source'",
            [install],
          )
        ).rowCount,
      ).toBe(0)
    } finally {
      await scheduler.stop()
    }
    await compileDialogue(f.runtime, install, s.session, turn, 'off')
    const rows = (
      await f.runtime.query(
        'SELECT summary,document,evidence_manifest FROM work_episodes WHERE installation_id=$1',
        [install],
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].summary.messages.map((m: any) => [m.text, m.reference.event])).toEqual([
      ['I prefer rail for personal travel.', prompt],
      [longAnswer.slice(0, 4000), answer],
    ])
    expect(rows[0].document.messages[1].text).toBe(longAnswer)
    expect(
      (await f.runtime.query('SELECT 1 FROM source_events WHERE installation_id=$1', [install])).rowCount,
    ).toBe(0)
    await checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false)
    await f.runtime.query(
      "INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled') ON CONFLICT(installation_id) DO UPDATE SET mode='enabled'",
      [install],
    )
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    const bundle = (
      await f.runtime.query('SELECT * FROM memory_task_bundles WHERE installation_id=$1', [install])
    ).rows[0]
    expect(bundle.dialogue_members).toHaveLength(2)
    const admitted = await curationTransaction(f.runtime, install, bundle.bundle_id, async (c, b) => {
      const source = await loadCurrentLifecycleSources(c, install, b)
      return source.admitted.map((e) => e.payload.text)
    })
    expect(admitted).toEqual(['I prefer rail for personal travel.', longAnswer])
    expect(
      (
        await f.runtime.query(
          "SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",
          [install],
        )
      ).rowCount,
    ).toBe(1)
    const scene = randomUUID()
    await f.runtime.query(
      "INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$2) ON CONFLICT DO NOTHING",
      [
        install,
        (
          await f.pool.query(
            'SELECT owner_scope_id FROM public.extension_installations WHERE installation_id=$1',
            [install],
          )
        ).rows[0].owner_scope_id,
      ],
    )
    await f.runtime.query(
      "INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Personal travel',ARRAY['personal'])",
      [install, scene],
    )
    const id = bundle.dialogue_members[0].id
    const agent = bundle.dialogue_members[1].id
    const curator = createCurationWorker({
      pool: f.runtime,
      mode: 'enabled',
      modelFingerprint: 'turn-dialogue-test',
      textGenerator: {
        async generateJson<T>() {
          return {
            ok: true,
            value: {
              tasks: [
                {
                  space_id: scene,
                  task_id: null,
                  spans: [
                    { event_id: id, quote: 'I prefer rail for personal travel.' },
                    { event_id: agent, quote: '已选择五分钟。' },
                  ],
                  conclusions: [
                    {
                      kind: 'preference',
                      assertion_mode: 'user_asserted',
                      subject: 'self',
                      predicate: 'travel.transport',
                      value: 'rail',
                      conditions: {},
                      fact_at: null,
                      valid_until: null,
                      statement: 'I prefer rail for personal travel.',
                      confirmed: true,
                      evidence: { subject: [id], predicate: [id], value: [id] },
                    },
                  ],
                },
              ],
            } as T,
            usage: { inputTokens: 1, outputTokens: 1, model: 'local-fixture' },
          }
        },
      },
    })
    const executor = createCurationExecutor({ pool: f.runtime, mode: 'enabled', tombstoneKeys: [] })
    const pipeline = createJobWorker({
      pool: f.runtime,
      jobs: createJobRepository(f.runtime),
      workerId: 'dialogue-curation',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    pipeline.register('consolidate_task', (j, s, c) => curator.consolidate(j, s, c?.fence))
    pipeline.register('curate_conclusions', async (j, s, c) => {
      await executor.curate(j, s, c?.fence)
    })
    pipeline.start()
    try {
      await expect
        .poll(
          async () =>
            (
              await f.runtime.query('SELECT locator FROM knowledge_evidence WHERE installation_id=$1', [
                install,
              ])
            ).rows.map((r) => r.locator.dialogue?.event),
          { timeout: 12000 },
        )
        .toContain(prompt)
    } finally {
      await pipeline.stop()
    }
    const proof = (
      await f.runtime.query('SELECT locator FROM knowledge_evidence WHERE installation_id=$1', [install])
    ).rows[0].locator.dialogue
    await f.publisher.query("UPDATE public.sessions SET status='exited' WHERE session_id=$1", [s.session])
    expect((await f.runtime.query('SELECT shared.reclaim_turn_dialogues() AS n')).rows[0].n).toBe(1)
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1', [install]))
        .rowCount,
    ).toBe(0)
    await checkDialogueRef(f.runtime, install, proof, false)
    const client = await f.runtime.connect()
    try {
      await client.query('BEGIN')
      const ev = (
        await client.query(
          'SELECT evidence_id,version_id,evidence_kind,source_event_id,artifact_id FROM knowledge_evidence WHERE installation_id=$1',
          [install],
        )
      ).rows
      await guardRetainedEvidence(client, install, ev)
      await assertRetainedSourceGuards(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      detachRetainedSourceGuards(client)
      client.release()
    }
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1', [install]))
        .rowCount,
    ).toBe(0)
    await checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false)
    const priorTurn = turn
    turn = 'late-' + randomUUID()
    await emit('user_text', { text: '另一个问题' })
    await emit('turn_status', { turn_status: 'completed' })
    await compileDialogue(f.runtime, install, s.session, turn, 'off')
    expect(
      (
        await f.runtime.query(
          'SELECT reason FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2',
          [install, turn],
        )
      ).rows,
    ).toEqual([{ reason: 'final_message_unconfirmed' }])
    await emit('agent_text', { part_id: 'answer', message_phase: 'final_answer', text: '迟到的结论' })
    await compileDialogue(f.runtime, install, s.session, turn, 'off')
    expect(
      (
        await f.runtime.query('SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2', [
          install,
          turn,
        ])
      ).rowCount,
    ).toBe(0)
    // A late native call withdraws an already compiled turn even when the
    // prompt never mentioned MCP. Its leased/queued curation job becomes a no-op.
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    const lateBundle = (
      await f.runtime.query(
        'SELECT bundle_id FROM memory_task_bundles WHERE installation_id=$1 AND task_key=$2',
        [install, 'dialogue:' + turn],
      )
    ).rows[0]
    expect(lateBundle).toBeDefined()
    await f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    const call = await emit('tool_call', {
      tool: 'lookup',
      call_meta: { tool_kind: 'mcp' },
      input: { secret: 'synthetic argument' },
    })
    const header = (await f.publisher.query('SELECT body_header FROM public.events WHERE id=$1', [call]))
      .rows[0].body_header
    expect(header.dialogue_operation).toBe('mcp')
    expect(header).not.toHaveProperty('input')
    expect((await f.runtime.query('SELECT shared.dispatch_turn_dialogues() AS n')).rows[0].n).toBe(1)
    expect(
      await curationTransaction(f.runtime, install, lateBundle.bundle_id, async () => {
        throw Error('excluded content reached curation')
      }),
    ).toBeNull()
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (
        await f.runtime.query(
          'SELECT state,document FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',
          [install, turn],
        )
      ).rows,
    ).toEqual([{ state: 'invalidated', document: {} }])
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE bundle_id=$1', [lateBundle.bundle_id]))
        .rowCount,
    ).toBe(0)

    for (const [promptText, tool] of [
      ['查询进度', null],
      ['请合并代码', null],
      ['继续', { tool: 'Skill', input: { skill: 'synthetic' } }],
      ['继续', { tool: 'commandExecution', input: { command: 'git add -A && git commit -m test' } }],
      ['继续', { tool: 'Bash', input: { command: 'git merge feature/turn' } }],
    ] as const) {
      turn = randomUUID()
      await emit('user_text', { text: promptText })
      if (tool) await emit('tool_call', tool)
      await emit('turn_status', { turn_status: 'completed' })
      // Missing final reply must not turn a policy skip into a gap.
      await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
      expect(
        (
          await f.runtime.query(
            `SELECT 1 FROM work_episodes WHERE installation_id=$1 AND turn_id=$2
        UNION ALL SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2
        UNION ALL SELECT 1 FROM memory_task_bundles WHERE installation_id=$1 AND task_key='dialogue:'||$2`,
            [install, turn],
          )
        ).rows,
      ).toEqual([])
    }
    turn = randomUUID()
    await emit('user_text', { text: '继续' })
    await emit('agent_text', { text: '技能返回' }, 'skill')
    await emit('turn_status', { turn_status: 'completed' })
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (
        await f.runtime.query('SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2', [
          install,
          turn,
        ])
      ).rows,
    ).toEqual([])
    turn = priorTurn
    await f.pool.query("UPDATE public.extension_installations SET status='paused' WHERE installation_id=$1", [
      install,
    ])
    await expect(
      checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false),
    ).rejects.toThrow()
  }, 60000)
})
