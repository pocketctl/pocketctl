import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

import {
  appendTeamMessage,
  getTeamContext,
  getTeamSession,
  listTeamEvents,
} from '../services/teamClient'
import type { TeamContextSnapshot, TeamEvent, TeamMessageTargetMode, TeamSession } from '../types/team'
import { useScopedSessionDraft } from './useScopedSessionState'
import { useWebSocket } from './useWebSocket'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '共享会话请求失败'
}

export function useTeamSession(teamID: Readonly<Ref<string>>, sessionID: Readonly<Ref<string>>) {
  const scope = computed(() => ({ type: 'team' as const, teamId: teamID.value }))
  const { draft, clearDraft } = useScopedSessionDraft(scope, sessionID)
  const session = ref<TeamSession | null>(null)
  const events = ref<TeamEvent[]>([])
  const context = ref<TeamContextSnapshot | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const error = ref('')
  const accessRevoked = ref(false)
  const subscribed = ref(false)
  const { connect, connected, onEvent, subscribeTeamSession, unsubscribeTeamSession } = useWebSocket()
  let generation = 0
  let disposers: Array<() => void> = []

  const callableBindings = computed(() => session.value?.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online') ?? [])
  const readOnlyReason = computed(() => {
    if (accessRevoked.value) return '你已无权访问此共享会话'
    if (!session.value) return '共享会话尚未加载'
    if (session.value.state === 'paused') return '共享会话已暂停'
    if (session.value.state !== 'active') return '共享会话为只读状态'
    if (!connected.value) return '实时连接已断开，恢复后可发送'
    if (callableBindings.value.length === 0) return '当前没有可调用的 Agent'
    return ''
  })
  const canSend = computed(() => !loading.value && !sending.value && !readOnlyReason.value)

  function mergeEvents(nextEvents: TeamEvent[]): void {
    const byID = new Map(events.value.map(event => [event.id, event]))
    for (const event of nextEvents) byID.set(event.id, event)
    events.value = [...byID.values()].sort((left, right) => left.event_seq - right.event_seq)
  }

  async function catchUp(afterSequence = 0): Promise<void> {
    let cursor: number | null = afterSequence
    do {
      const page = await listTeamEvents(sessionID.value, cursor, 100)
      mergeEvents(page.events)
      cursor = page.next_cursor
    } while (cursor !== null)
  }

  async function load(): Promise<void> {
    const currentGeneration = ++generation
    loading.value = true
    error.value = ''
    accessRevoked.value = false
    events.value = []
    try {
      const [nextSession, nextContext] = await Promise.all([
        getTeamSession(sessionID.value),
        getTeamContext(sessionID.value),
      ])
      if (currentGeneration !== generation) return
      session.value = nextSession
      context.value = nextContext
      await catchUp()
      if (currentGeneration !== generation) return
      connect()
      subscribeTeamSession(sessionID.value)
    } catch (failure) {
      if (currentGeneration === generation) error.value = errorMessage(failure)
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  async function reloadSession(): Promise<void> {
    try {
      session.value = await getTeamSession(sessionID.value)
      context.value = await getTeamContext(sessionID.value)
    } catch (failure) {
      error.value = errorMessage(failure)
    }
  }

  async function sendMessage(input: { targetMode: TeamMessageTargetMode; targetOfferIDs?: string[]; referenceEventID?: string | null }): Promise<boolean> {
    const content = draft.value.trim()
    if (!content || !canSend.value) return false
    sending.value = true
    error.value = ''
    try {
      const result = await appendTeamMessage(sessionID.value, { content, ...input })
      mergeEvents([result.event])
      clearDraft()
      return true
    } catch (failure) {
      error.value = errorMessage(failure)
      await reloadSession()
      return false
    } finally {
      sending.value = false
    }
  }

  function installSubscriptionHandlers(): void {
    disposers = [
      onEvent('team_collaboration_event', message => {
        if (message.team_session_id !== sessionID.value || !message.event) return
        mergeEvents([message.event])
      }),
      onEvent('team_collaboration_subscription', message => {
        if (message.team_session_id === sessionID.value) subscribed.value = message.subscribed === true
      }),
      onEvent('team_collaboration_subscription_error', message => {
        if (message.team_session_id === sessionID.value) error.value = '无法订阅此共享会话'
      }),
      onEvent('team_collaboration_access_revoked', message => {
        if (message.team_session_id !== sessionID.value) return
        accessRevoked.value = true
        subscribed.value = false
      }),
      onEvent('connection_restored', () => {
        subscribeTeamSession(sessionID.value)
        const latestSequence = events.value.at(-1)?.event_seq ?? 0
        void catchUp(latestSequence).catch(failure => { error.value = errorMessage(failure) })
      }),
    ]
  }

  watch(sessionID, (next, previous) => {
    if (previous) unsubscribeTeamSession(previous)
    if (next) void load()
  })

  onMounted(() => {
    installSubscriptionHandlers()
    void load()
  })
  onBeforeUnmount(() => {
    generation++
    unsubscribeTeamSession(sessionID.value)
    disposers.forEach(dispose => dispose())
  })

  return {
    session, events, context, draft, loading, sending, error, connected, subscribed,
    callableBindings, readOnlyReason, canSend, load, reloadSession, sendMessage,
  }
}
