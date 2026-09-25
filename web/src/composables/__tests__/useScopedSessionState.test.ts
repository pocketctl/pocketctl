import { nextTick, ref } from 'vue'
import { describe, expect, test } from 'vitest'

import {
  scopedSessionStateKey,
  getScopedReadingPosition,
  setScopedReadingPosition,
  sessionScopeKey,
  useScopedSessionDraft,
  type SessionScope,
} from '../useScopedSessionState'

describe('scoped session state', () => {
  test('uses disjoint personal and Team key spaces', () => {
    expect(sessionScopeKey({ type: 'personal' })).toBe('personal')
    expect(sessionScopeKey({ type: 'team', teamId: 'ctm_1' })).toBe('team:ctm_1')
    expect(scopedSessionStateKey({ type: 'personal' }, 'same-id', 'draft'))
      .not.toBe(scopedSessionStateKey({ type: 'team', teamId: 'ctm_1' }, 'same-id', 'draft'))
  })

  test('restores drafts per scope and session without persistence', async () => {
    const scope = ref<SessionScope>({ type: 'personal' })
    const sessionId = ref('session-1')
    const { draft, clearDraft } = useScopedSessionDraft(scope, sessionId)

    draft.value = 'personal one'
    await nextTick()
    sessionId.value = 'session-2'
    await nextTick()
    expect(draft.value).toBe('')

    draft.value = 'personal two'
    scope.value = { type: 'team', teamId: 'ctm_1' }
    await nextTick()
    expect(draft.value).toBe('')

    draft.value = 'team two'
    scope.value = { type: 'personal' }
    await nextTick()
    expect(draft.value).toBe('personal two')

    sessionId.value = 'session-1'
    await nextTick()
    expect(draft.value).toBe('personal one')
    clearDraft()
    expect(draft.value).toBe('')
  })

  test('keeps reading positions isolated between personal and team routes', () => {
    setScopedReadingPosition({ type: 'personal' }, 'same-id', 120)
    setScopedReadingPosition({ type: 'team', teamId: 'ctm_1' }, 'same-id', 480)
    expect(getScopedReadingPosition({ type: 'personal' }, 'same-id')).toBe(120)
    expect(getScopedReadingPosition({ type: 'team', teamId: 'ctm_1' }, 'same-id')).toBe(480)
    expect(getScopedReadingPosition({ type: 'team', teamId: 'ctm_2' }, 'same-id')).toBeNull()
  })
})
