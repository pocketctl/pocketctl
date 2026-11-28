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
  state: 'draft' | 'recipients' | 'filters' | 'reading-position' | 'open-session',
): string {
  return `${sessionScopeKey(scope)}:${sessionId}:${state}`
}

const draftStore = new Map<string, string>()
const readingPositionStore = new Map<string, number>()

export function useScopedSessionDraft(
  scope: Readonly<Ref<SessionScope>>,
  sessionId: Readonly<Ref<string>>,
  owner: Readonly<Ref<string>> = ref(''),
  field: 'draft' | 'recipients' = 'draft',
): { draft: Ref<string>; clearDraft(session?: string): void } {
  const draft = ref('')
  let activeKey = ''

  const key = (id: string) => JSON.stringify([owner.value, scopedSessionStateKey(scope.value, id, field)])
  watch([scope, sessionId, owner], ([, nextSessionId]) => {
    if (activeKey) {
      if (draft.value) draftStore.set(activeKey, draft.value)
      else draftStore.delete(activeKey)
    }
    activeKey = key(nextSessionId)
    draft.value = draftStore.get(activeKey) ?? ''
  }, { immediate: true })

  watch(draft, value => {
    if (!activeKey) return
    if (value) draftStore.set(activeKey, value)
    else draftStore.delete(activeKey)
  })

  return {
    draft,
    clearDraft(id = sessionId.value): void {
      if (key(id) === activeKey) draft.value = ''
      draftStore.delete(key(id))
    },
  }
}

export function getScopedReadingPosition(scope: SessionScope, sessionId: string): number | null {
  return readingPositionStore.get(scopedSessionStateKey(scope, sessionId, 'reading-position')) ?? null
}

export function setScopedReadingPosition(scope: SessionScope, sessionId: string, position: number): void {
  readingPositionStore.set(scopedSessionStateKey(scope, sessionId, 'reading-position'), Math.max(0, position))
}
