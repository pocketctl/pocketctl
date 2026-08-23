import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { projectTurns } from '../turnProjection'

describe('projectTurns', () => {
  test('keeps legacy rows in place while grouping same-turn main and auxiliary messages', () => {
    const legacy = { id: 'legacy', type: 'agent_text' }
    const main = { id: 'main', type: 'agent_text', turnId: 'turn-1', flowScope: 'main', contentClass: 'dialogue' }
    const auxiliary = { id: 'aux', type: 'tool_call', turnId: 'turn-1', flowScope: 'auxiliary', contentClass: 'execution' }
    const rows = projectTurns([main, legacy, auxiliary])

    expect(rows.map(row => row.kind)).toEqual(['turn', 'legacy', 'turn'])
    expect(rows[0]).toMatchObject({
      kind: 'turn', turnId: 'turn-1', main: [main], auxiliary: [],
    })
    expect(rows[1]).toMatchObject({ kind: 'legacy', message: legacy })
    expect(rows[2]).toMatchObject({ kind: 'turn', turnId: 'turn-1', main: [], auxiliary: [auxiliary] })
  })

  test('does not classify unknown events away and leaves its input unchanged', () => {
    const unknown = { id: 'unknown', type: 'new_event', turn_id: 'turn-1', flow_scope: 'unclassified', content_class: 'unknown' }
    const messages = [unknown]
    const rows = projectTurns(messages)

    expect(rows[0]).toMatchObject({ kind: 'turn', main: [unknown], auxiliary: [] })
    expect(messages).toEqual([unknown])
  })

  test('separates interrupted turns from after-interrupt continuations', () => {
    const rows = projectTurns([
      { id: 'old-status', type: 'turn_status', turn_id: 'old', turn_status: 'interrupted' },
      { id: 'new-user', type: 'user_text', turn_id: 'new', previous_turn_id: 'old', continuation_reason: 'after_interrupt' },
    ])

    expect(rows[0]).toMatchObject({ kind: 'turn', turnId: 'old', status: 'interrupted', interrupted: true, auxiliary: [] })
    expect(rows[1]).toMatchObject({ kind: 'turn', turnId: 'new', previousTurnId: 'old', continuedAfterInterrupt: true })
  })

  test('preserves encounter order across replay pages, revisions, and duplicate terminal events', () => {
    const text = { id: 'text', type: 'agent_text', turn_id: 'turn-1', partId: 'p', revision: 2 }
    const terminal = { id: 'terminal', type: 'turn_status', turn_id: 'turn-1', turn_status: 'completed' }
    const duplicateTerminal = { id: 'terminal-duplicate', type: 'turn_status', turn_id: 'turn-1', turn_status: 'completed' }
    const rows = projectTurns([text, terminal, duplicateTerminal])

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).messages).toEqual([text, terminal, duplicateTerminal])
    expect(rows[0]).toMatchObject({ status: 'completed' })
  })

  test('forces pending interaction content into the visible main section', () => {
    const approval = { id: 'approval', type: 'approval_request', turn_id: 'turn-1', flow_scope: 'auxiliary', content_class: 'interaction', status: 'pending' }
    const question = { id: 'question', type: 'question_request', turn_id: 'turn-1', flow_scope: 'auxiliary', content_class: 'interaction', status: 'pending' }
    const rows = projectTurns([approval, question])

    expect(rows[0]).toMatchObject({ main: [approval, question], auxiliary: [] })
  })

  test('forces pending request types visible even when an older event lacks content_class', () => {
    const approval = { id: 'approval-no-class', type: 'approval_request', turn_id: 'turn-1', flow_scope: 'auxiliary', status: 'pending' }
    const question = { id: 'question-no-class', type: 'question_request', turn_id: 'turn-1', status: 'pending' }

    expect(projectTurns([approval, question])[0]).toMatchObject({ main: [approval, question], auxiliary: [] })
  })

  test('keeps an addendum and a later replay page in their original turn encounter order', () => {
    const prompt = { id: 'prompt', type: 'user_text', turn_id: 'turn-1', flow_scope: 'main' }
    const addendum = { id: 'addendum', type: 'user_text', turn_id: 'turn-1', flow_scope: 'main' }
    const reply = { id: 'reply', type: 'agent_text', turn_id: 'turn-1', flow_scope: 'main' }

    expect((projectTurns([prompt, addendum, reply])[0] as any).messages).toEqual([prompt, addendum, reply])
  })

  test('does not mix independently routed root and subagent buckets', () => {
    const root = { id: 'root', type: 'agent_text', turn_id: 'shared-turn', actor_scope: 'root', flow_scope: 'main' }
    const child = { id: 'child', type: 'agent_text', turn_id: 'shared-turn', actor_scope: 'subagent', flow_scope: 'main' }

    expect((projectTurns([root])[0] as any).messages).toEqual([root])
    expect((projectTurns([child])[0] as any).messages).toEqual([child])
  })

  test('consumes the shared cross-client golden fixture', () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../testdata/turn_projection_golden.json'), 'utf8')) as any
    const normalize = (bucket: string) => projectTurns(fixture.messages.filter((message: any) => message.bucket === bucket)).map(row => {
      if (row.kind === 'legacy') return { kind: 'legacy', message_ids: [row.message.id] }
      return {
        kind: 'turn', turn_id: row.turnId, message_ids: row.messages.map(message => message.id),
        main_ids: row.main.map(message => message.id), auxiliary_ids: row.auxiliary.map(message => message.id),
        status: row.status, interrupted: row.interrupted,
        continued_after_interrupt: row.continuedAfterInterrupt,
        previous_turn_id: row.previousTurnId,
      }
    })

    expect(normalize('root')).toEqual(fixture.expected.root)
    expect(normalize('child')).toEqual(fixture.expected.child)
  })

  test('keeps missing and unrecognized flow values in the always-visible main lane', () => {
    const missing = { id: 'missing', type: 'future_missing', turn_id: 'missing-flow' }
    const unknown = { id: 'unknown', type: 'future_unknown', turn_id: 'unknown-flow', flow_scope: 'future' }

    expect(projectTurns([missing])[0]).toMatchObject({ main: [missing], auxiliary: [] })
    expect(projectTurns([unknown])[0]).toMatchObject({ main: [unknown], auxiliary: [] })
  })
})
