import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

import {
  appendTeamMessage,
  controlTeamRun,
  createTeamRun,
  getTeamContext,
  getTeamCapabilities,
  getTeamSession,
  getTeamTask,
  listTeamEvents,
  listTeamRuns,
  setTeamSessionAgentBinding,
  supplementTeamRun,
} from '../services/teamClient'
import type { TeamCapabilities, TeamContextSnapshot, TeamEvent, TeamMessageTargetMode, TeamRun, TeamSession, TeamTask } from '../types/team'
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
  const runContext = ref<TeamContextSnapshot | null>(null)
  const runs = ref<TeamRun[]>([])
  const task = ref<TeamTask | null>(null)
  const capabilities = ref<TeamCapabilities | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const runBusy = ref(false)
  const error = ref('')
  const runError = ref('')
  const accessRevoked = ref(false)
  const subscribed = ref(false)
  const { connect, connected, onEvent, subscribeTeamSession, unsubscribeTeamSession } = useWebSocket()
  let generation = 0
  let disposers: Array<() => void> = []
  let runPollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const callableBindings = computed(() => session.value?.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online') ?? [])
  const latestRun = computed(() => runs.value[0] ?? null)
  const autorunEnabled = computed(() => capabilities.value?.autorun === true && capabilities.value.writes_enabled === true)
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

  function clearRunPoll(): void {
    if (runPollTimer) clearTimeout(runPollTimer)
    runPollTimer = undefined
  }

  function scheduleRunPoll(): void {
    clearRunPoll()
    if (disposed) return
    const current = latestRun.value
    if (!current || (!['ready', 'running'].includes(current.state) && !current.stop_requested)) return
    runPollTimer = setTimeout(() => {
      runPollTimer = undefined
      void refreshRuns().finally(scheduleRunPoll)
    }, 1_500)
  }

  async function refreshRuns(): Promise<void> {
    const currentGeneration = generation
    const currentSessionID = sessionID.value
    try {
      const nextRuns = await listTeamRuns(currentSessionID)
      if (currentGeneration !== generation || currentSessionID !== sessionID.value) return
      runs.value = nextRuns
      const currentRun = nextRuns[0]
      if (!currentRun) {
        runContext.value = null
      } else if (context.value?.version === currentRun.context_version) {
        runContext.value = context.value
      } else if (runContext.value?.version !== currentRun.context_version) {
        const frozenContext = await getTeamContext(currentSessionID, currentRun.context_version)
        if (currentGeneration === generation && currentSessionID === sessionID.value) runContext.value = frozenContext
      }
    } catch (failure) {
      if (currentGeneration === generation) runError.value = errorMessage(failure)
    }
  }

  async function loadLinkedTask(nextSession: TeamSession, currentGeneration: number): Promise<void> {
    if (!nextSession.task_id) { if (currentGeneration === generation) task.value = null; return }
    try {
      const nextTask = await getTeamTask(nextSession.task_id)
      if (currentGeneration === generation) task.value = nextTask
    } catch (failure) {
      if (currentGeneration === generation) runError.value = errorMessage(failure)
    }
  }

  async function load(): Promise<void> {
    const currentGeneration = ++generation
    loading.value = true
    error.value = ''
    runError.value = ''
    accessRevoked.value = false
    events.value = []
    runs.value = []
    runContext.value = null
    task.value = null
    clearRunPoll()
    try {
      const [nextSession, nextContext, nextCapabilities, nextRuns] = await Promise.all([
        getTeamSession(sessionID.value),
        getTeamContext(sessionID.value),
        getTeamCapabilities(),
        listTeamRuns(sessionID.value),
      ])
      if (currentGeneration !== generation) return
      session.value = nextSession
      context.value = nextContext
      capabilities.value = nextCapabilities
      runs.value = nextRuns
      const currentRun = nextRuns[0]
      const nextRunContext = currentRun && currentRun.context_version === nextContext?.version
        ? nextContext
        : currentRun ? await getTeamContext(sessionID.value, currentRun.context_version) : null
      if (currentGeneration !== generation) return
      runContext.value = nextRunContext
      void loadLinkedTask(nextSession, currentGeneration)
      await catchUp()
      if (currentGeneration !== generation) return
      connect()
      subscribeTeamSession(sessionID.value)
      scheduleRunPoll()
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
      await refreshRuns()
      if (session.value) await loadLinkedTask(session.value, generation)
    } catch (failure) {
      error.value = errorMessage(failure)
    }
  }

  function replaceRun(nextRun: TeamRun): void {
    runs.value = [nextRun, ...runs.value.filter(run => run.id !== nextRun.id)]
    scheduleRunPoll()
  }

  async function createRun(coordinatorOfferID: string): Promise<boolean> {
    if (!context.value || !autorunEnabled.value || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      const created = await createTeamRun(sessionID.value, {
        coordinatorOfferID, contextVersion: context.value.version,
      })
      replaceRun(created)
      runContext.value = context.value
      return true
    } catch (failure) {
      runError.value = errorMessage(failure)
      await refreshRuns()
      return false
    } finally { runBusy.value = false }
  }

  async function controlRun(action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    const current = latestRun.value
    if (!current || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      replaceRun(await controlTeamRun(current, action))
      return true
    } catch (failure) {
      runError.value = errorMessage(failure)
      await refreshRuns()
      return false
    } finally { runBusy.value = false }
  }

  async function supplementRunInput(content: string): Promise<boolean> {
    const current = latestRun.value
    if (!current || current.state !== 'waiting_input' || !content.trim() || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      replaceRun(await supplementTeamRun(current, content.trim()))
      return true
    } catch (failure) {
      runError.value = errorMessage(failure)
      await refreshRuns()
      return false
    } finally { runBusy.value = false }
  }

  async function suggestRunPause(): Promise<boolean> {
    const current = latestRun.value
    if (!current || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      const result = await appendTeamMessage(sessionID.value, {
        content: `建议暂停自动协作运行 ${current.id}，请共享会话创建人确认。`,
        targetMode: 'discussion', targetOfferIDs: [], referenceEventID: null,
      })
      mergeEvents([result.event])
      return true
    } catch (failure) {
      runError.value = errorMessage(failure)
      return false
    } finally { runBusy.value = false }
  }

  async function withdrawAgent(offerID: string): Promise<boolean> {
    if (!session.value || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      session.value = await setTeamSessionAgentBinding(session.value, offerID, false)
      return true
    } catch (failure) {
      runError.value = errorMessage(failure)
      await reloadSession()
      return false
    } finally { runBusy.value = false }
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
        if (['run', 'status', 'agent_message'].includes(message.event.kind)) void refreshRuns().finally(scheduleRunPoll)
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
        void refreshRuns().finally(scheduleRunPoll)
      }),
    ]
  }

  watch(sessionID, (next, previous) => {
    if (previous) unsubscribeTeamSession(previous)
    if (next) void load()
  })

  onMounted(() => {
    disposed = false
    installSubscriptionHandlers()
    void load()
  })
  onBeforeUnmount(() => {
    disposed = true
    generation++
    clearRunPoll()
    unsubscribeTeamSession(sessionID.value)
    disposers.forEach(dispose => dispose())
  })

  return {
    session, events, context, runContext, runs, latestRun, task, capabilities, draft, loading, sending,
    runBusy, error, runError, connected, subscribed, callableBindings, autorunEnabled,
    readOnlyReason, canSend, load, reloadSession, refreshRuns, sendMessage, createRun,
    controlRun, supplementRunInput, suggestRunPause, withdrawAgent,
  }
}
