import { ref, watch, type Ref } from 'vue'

export type SessionScope =
  | { type: 'personal' }
  | { type: 'team'; teamId: string }

export function sessionScopeKey(scope: SessionScope): string {
  return scope.type === 'personal' ? 'personal' : `team:${scope.teamId}`
}

export function scopedSessionStateKey(
  scope: SessionScope,
  sessionId: string,
  state: 'draft' | 'filters' | 'reading-position' | 'open-session',
): string {
  return `${sessionScopeKey(scope)}:${sessionId}:${state}`
}

const draftStore = new Map<string, string>()
const readingPositionStore = new Map<string, number>()

export function useScopedSessionDraft(
  scope: Readonly<Ref<SessionScope>>,
  sessionId: Readonly<Ref<string>>,
): { draft: Ref<string>; clearDraft(): void } {
  const draft = ref('')
  let activeKey = ''

  watch([scope, sessionId], ([nextScope, nextSessionId]) => {
    if (activeKey) {
      if (draft.value) draftStore.set(activeKey, draft.value)
      else draftStore.delete(activeKey)
    }
    activeKey = scopedSessionStateKey(nextScope, nextSessionId, 'draft')
    draft.value = draftStore.get(activeKey) ?? ''
  }, { immediate: true })

  watch(draft, value => {
    if (!activeKey) return
    if (value) draftStore.set(activeKey, value)
    else draftStore.delete(activeKey)
  })

  return {
    draft,
    clearDraft(): void {
      draft.value = ''
      if (activeKey) draftStore.delete(activeKey)
    },
  }
}

export function getScopedReadingPosition(scope: SessionScope, sessionId: string): number | null {
  return readingPositionStore.get(scopedSessionStateKey(scope, sessionId, 'reading-position')) ?? null
}

export function setScopedReadingPosition(scope: SessionScope, sessionId: string, position: number): void {
  readingPositionStore.set(scopedSessionStateKey(scope, sessionId, 'reading-position'), Math.max(0, position))
}
