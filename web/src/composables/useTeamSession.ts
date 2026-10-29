import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

import {
  appendTeamMessage,
  findTeamMessage,
  markTeamRead,
  TeamApiError,
  controlTeamRun,
  createTeamRun,
  getTeamContext,
  getTeamCapabilities,
  getTeamSession,
  getTeamTask,
  listTeamEvents,
  listTeamCalls,
  listTeamRuns,
  setTeamSessionAgentBinding,
  supplementTeamRun,
} from '../services/teamClient'
import type { TeamCallSummary, TeamCapabilities, TeamContextSnapshot, TeamEvent, TeamMessageTargetMode, TeamRun, TeamSession, TeamTask } from '../types/team'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { teamOutbox,TeamContinuousCursor,type TeamOutboxMessage } from '../services/teamOutbox'
import { useScopedSessionDraft } from './useScopedSessionState'
import { useWebSocket } from './useWebSocket'
import { useLocale } from './useLocale'
import { teamDeliveryCache, deliveryCacheScope } from '../services/teamDeliveryCache'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '共享会话请求失败'
}

export function useTeamSession(teamID: Readonly<Ref<string>>, sessionID: Readonly<Ref<string>>) {
  const { t } = useLocale()
  const {user}=useAuth()
  const accountScope=computed(()=>JSON.stringify([getRelayOrigin(),user.value?.id??null,teamID.value,sessionID.value]))
  const pendingMessages=ref<TeamOutboxMessage[]>([])
  const continuous=new TeamContinuousCursor()
  const contiguousEventSeq=ref(0)
  let syncPromise:Promise<void>|undefined
  let flushing=false
  const scope = computed(() => ({ type: 'team' as const, teamId: teamID.value }))
  const { draft, clearDraft } = useScopedSessionDraft(scope, sessionID)
  const session = ref<TeamSession | null>(null)
  const events = ref<TeamEvent[]>([])
  const calls = ref<TeamCallSummary[]>([])
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
  let callRequest = 0
  let disposers: Array<() => void> = []
  let runPollTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let sessionPollTimer: ReturnType<typeof setTimeout> | undefined
  let callPollTimer: ReturnType<typeof setTimeout> | undefined

  const callableBindings = computed(() => session.value?.agent_bindings.filter(binding => binding.state === 'active' && binding.availability === 'online') ?? [])
  const latestRun = computed(() => runs.value[0] ?? null)
  const autorunEnabled = computed(() => session.value?.current_user_role !== 'viewer' && capabilities.value?.autorun === true && capabilities.value.writes_enabled === true)
  const readOnlyReason = computed(() => {
    if (session.value?.current_user_role === 'viewer') return t('team.viewer_read_only')
    if (accessRevoked.value) return '你已无权访问此共享会话'
    if (!session.value) return '共享会话尚未加载'
    if (session.value.state === 'paused') return '共享会话已暂停'
    if (session.value.state !== 'active') return '共享会话为只读状态'
    if (capabilities.value?.writes_enabled !== true) return '团队写入暂不可用'
    return ''
  })
  const canSend = computed(() => !loading.value && !sending.value && !readOnlyReason.value)

  function mergeEvents(nextEvents: TeamEvent[]): void {
    const byID = new Map(events.value.map(event => [event.id, event]))
    for (const event of nextEvents) {
      byID.set(event.id,event)
      contiguousEventSeq.value=continuous.receive(event.event_seq)
      if(event.request_id && event.author_user_id===user.value?.id){
        const pending=pendingMessages.value.find(p=>p.request_id===event.request_id)
        if(pending){pendingMessages.value=pendingMessages.value.filter(p=>p.key!==pending.key);void teamOutbox.remove(pending.key).catch(()=>{})}
      }
    }
    events.value = [...byID.values()].sort((left, right) => left.event_seq - right.event_seq)
  }

  async function catchUp(afterSequence = contiguousEventSeq.value):Promise<void>{
    if(syncPromise)return syncPromise
    const currentGeneration=generation,currentSessionID=sessionID.value
    const run=async()=>{
      let cursor:number|null=afterSequence
      do{
        const before=cursor
        const page=await listTeamEvents(currentSessionID,cursor,100)
        if(currentGeneration!==generation||accessRevoked.value)return
        if(page.reset_required){events.value=[];continuous.reset(page.retained_after_seq??0);contiguousEventSeq.value=continuous.value}
        mergeEvents(page.events)
        if(page.completed_through!==undefined)contiguousEventSeq.value=continuous.completed(page.completed_through)
        cursor=page.next_cursor
        if(cursor!==null&&cursor<=before)throw new Error('消息历史未推进，请重试同步')
      }while(cursor!==null)
    }
    const work=run();syncPromise=work
    let success=false
    try{await work;success=true}finally{if(syncPromise===work)syncPromise=undefined;if(success&&currentGeneration===generation&&events.value.some(e=>e.event_seq>contiguousEventSeq.value))queueMicrotask(()=>void catchUp().catch(f=>{error.value=errorMessage(f)}))}
  }
  function revokeAccess(){void teamDeliveryCache.purge(deliveryCacheScope(user.value?.id||0,getRelayOrigin()),{session:sessionID.value}).catch(()=>{});void teamOutbox.blockScope(accountScope.value).catch(()=>{});generation++;pendingMessages.value=[];clearCallPoll();clearSessionPoll();clearRunPoll();calls.value=[];events.value=[];session.value=null;context.value=null;runs.value=[];task.value=null;draft.value='';accessRevoked.value=true;subscribed.value=false;unsubscribeTeamSession(sessionID.value)}
  function authorityFailure(failure:unknown){if(failure instanceof TeamApiError && [401,403,404].includes(failure.status)){revokeAccess();return true}return false}
  async function restoreOutbox(){
    const scope=accountScope.value,g=generation
    if(!user.value)return
    const rows=await teamOutbox.list(scope)
    if(scope!==accountScope.value||g!==generation)return
    pendingMessages.value=rows.map(p=>p.state==='sending'?{...p,state:'unknown'}:p)
    for(const row of pendingMessages.value)if(row.state==='unknown')await reconcileMessage(row.request_id)
  }
  async function reconcileMessage(request:string):Promise<boolean>{
    const row=pendingMessages.value.find(p=>p.request_id===request)
    if(!row||row.scope!==accountScope.value||accessRevoked.value)return false
    const g=generation
    let authorized=false
    try{
      await getTeamSession(row.session_id);authorized=true
      const result=await findTeamMessage(row.session_id,row.request_id)
      if(g!==generation||row.scope!==accountScope.value)return false
      mergeEvents([result.event]);pendingMessages.value=pendingMessages.value.filter(p=>p.key!==row.key);await teamOutbox.remove(row.key);return true
    }catch(failure){
      if(g===generation){
        error.value=errorMessage(failure)
        if(!authorized)authorityFailure(failure);
        if(authorized && failure instanceof TeamApiError && failure.status===404){row.state='failed';row.error='未找到原消息，可使用原请求重试';await teamOutbox.put({...row})}
      }
      return false
    }
  }
  async function flushOutbox(){
    if(flushing||capabilities.value?.writes_enabled!==true||!connected.value||navigator.onLine===false||!user.value||accessRevoked.value||!session.value)return
    flushing=true
    let madeProgress=false
    const g=generation,scope=accountScope.value
    try{
      // Reauthorize after reconnect before even the first persisted send.
      await getTeamSession(sessionID.value)
      for(const row of [...pendingMessages.value]){
        if(g!==generation||scope!==accountScope.value||accessRevoked.value||!connected.value)break
        if(row.state!=='queued')break
        row.state='sending';await teamOutbox.put({...row})
        try{
          const result=await appendTeamMessage(row.session_id,{requestID:row.request_id,content:row.content,targetMode:row.target_mode,targetOfferIDs:row.target_offer_ids,referenceEventID:row.reference_event_id})
          if(g!==generation||scope!==accountScope.value)break
          mergeEvents([result.event]);pendingMessages.value=pendingMessages.value.filter(p=>p.key!==row.key);await teamOutbox.remove(row.key);madeProgress=true;void refreshCalls()
        }catch(failure){
          if(!pendingMessages.value.some(p=>p.key===row.key))continue
          row.state=failure instanceof TeamApiError && failure.status>=400 && failure.status<500 ? 'failed':'unknown'
          row.error=errorMessage(failure);await teamOutbox.put({...row})
          if(g===generation)error.value=row.error
          break // preserve queue order until the preceding result is resolved
        }
      }
    }catch(failure){if(g===generation){authorityFailure(failure);error.value=errorMessage(failure)}}finally{flushing=false;if(madeProgress&&pendingMessages.value[0]?.state==='queued'&&connected.value&&!accessRevoked.value)queueMicrotask(()=>void flushOutbox())}
  }
  async function retryMessage(request:string){
    const row=pendingMessages.value.find(p=>p.request_id===request)
    if(!row||row.scope!==accountScope.value||accessRevoked.value)return
    if(row.state==='unknown'){if(await reconcileMessage(request))return;if(row.state==='unknown')return}
    if(!pendingMessages.value.includes(row))return
    await getTeamSession(row.session_id)
    row.state='queued';await teamOutbox.put({...row});await flushOutbox()
  }
  async function markRead(){
    if(capabilities.value?.reads_enabled!==undefined && !accessRevoked.value && document.visibilityState==='visible' && contiguousEventSeq.value>0)await markTeamRead(sessionID.value,contiguousEventSeq.value)
  }

  function clearSessionPoll(): void {
    if (sessionPollTimer) clearTimeout(sessionPollTimer)
    sessionPollTimer = undefined
  }

  function scheduleSessionPoll(): void {
    clearSessionPoll()
    if (disposed || accessRevoked.value) return
    const currentGeneration = generation
    const currentSessionID = sessionID.value
    sessionPollTimer = setTimeout(async () => {
      sessionPollTimer = undefined
      try {
        const nextSession = await getTeamSession(currentSessionID)
        if (disposed || accessRevoked.value || currentGeneration !== generation) return
        // A sidebar mutation or another participant can change metadata without
        // appending a discussion event. Do not overwrite a newer local mutation.
        if (!session.value || nextSession.revision >= session.value.revision) session.value = nextSession
        if(nextSession.latest_event_seq>contiguousEventSeq.value)await catchUp()
        if (context.value?.version !== session.value.current_context_version) {
          const nextContext = await getTeamContext(currentSessionID)
          if (!disposed && !accessRevoked.value && currentGeneration === generation
            && nextContext?.version === session.value?.current_context_version) context.value = nextContext
        }
        if(!subscribed.value)await catchUp()
      } catch (failure) {
        if (!disposed && !accessRevoked.value && currentGeneration === generation) {authorityFailure(failure);error.value = errorMessage(failure)}
      } finally {
        if (currentGeneration === generation) scheduleSessionPoll()
      }
    }, 5_000)
  }

  function clearCallPoll(): void {
    if (callPollTimer) clearTimeout(callPollTimer)
    callPollTimer = undefined
  }

  async function refreshCalls(): Promise<void> {
    clearCallPoll()
    const request = ++callRequest
    const currentGeneration = generation
    const currentSessionID = sessionID.value
    if (disposed || accessRevoked.value) return
    try {
      const nextCalls = await listTeamCalls(currentSessionID)
      if (request === callRequest && currentGeneration === generation && !accessRevoked.value) {
        const previousStates = new Map(calls.value.map(call => [call.id, call.state]))
        calls.value = nextCalls
        // A first call creates the native binding asynchronously; make the
        // owner's confirmation link available without requiring a page reload.
        // Foreign native IDs remain null by design; only a changed call needs
        // to refresh bindings, rather than refetching them on every poll.
        if (nextCalls.some(call => call.state !== 'pending' && previousStates.get(call.id) !== call.state && session.value?.agent_bindings.some(binding => binding.offer_id === call.offer_id && !binding.native_session_id))) {
          const nextSession = await getTeamSession(currentSessionID)
          if (request === callRequest && currentGeneration === generation && !accessRevoked.value) session.value = nextSession
        }
      }
    } catch (failure) {
      if (currentGeneration === generation) {authorityFailure(failure);error.value = errorMessage(failure)}
    } finally {
      if (request === callRequest && currentGeneration === generation && !disposed && !accessRevoked.value) {
        callPollTimer = setTimeout(() => { void refreshCalls() }, 1_500)
      }
    }
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
    continuous.reset();contiguousEventSeq.value=0;syncPromise=undefined;pendingMessages.value=[]
    connect()
    calls.value = []
    clearCallPoll()
    clearSessionPoll()
    runs.value = []
    runContext.value = null
    task.value = null
    clearRunPoll()
    try {
      await restoreOutbox().catch(failure => { if (currentGeneration === generation) error.value = errorMessage(failure) })
      if (currentGeneration !== generation) return
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
      await catchUp(0)
      await restoreOutbox().catch(failure => { if (currentGeneration === generation) error.value = errorMessage(failure) })
      void flushOutbox()
      if (currentGeneration !== generation) return
      connect()
      if(nextCapabilities.collaboration)subscribeTeamSession(sessionID.value)
      scheduleRunPoll()
      scheduleSessionPoll()
      void refreshCalls()
    } catch (failure) {
      if (currentGeneration === generation) {authorityFailure(failure);error.value = errorMessage(failure)}
    } finally {
      if (currentGeneration === generation) loading.value = false
    }
  }

  function recoverOnline(): void {
    if (accessRevoked.value || loading.value || disposed) return
    if (!session.value || !capabilities.value) { void load(); return }
    void restoreOutbox().then(flushOutbox).catch(failure => { error.value = errorMessage(failure) })
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

  async function createRun(coordinatorOfferID: string,options?:{mode:import('../types/team').TeamRunMode;participantOfferIDs:string[];maxRounds:number;budget:TeamRun['budget'];requestID:string}): Promise<boolean> {
    if (!context.value || !autorunEnabled.value || runBusy.value) return false
    runBusy.value = true
    runError.value = ''
    try {
      const created = await createTeamRun(sessionID.value, {
        coordinatorOfferID, contextVersion: context.value.version,...options,
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

  async function sendMessage(input:{targetMode:TeamMessageTargetMode;targetOfferIDs?:string[];referenceEventID?:string|null}):Promise<boolean>{
    const content=draft.value.trim()
    if(!content||!canSend.value||!user.value||(input.targetMode!=='discussion'&&!callableBindings.value.length))return false
    sending.value=true;error.value=''
    try{
      const request=crypto.randomUUID(),scope=accountScope.value
      const row:TeamOutboxMessage={key:scope+':'+request,scope,session_id:sessionID.value,author_user_id:user.value.id,request_id:request,content,
        target_mode:input.targetMode,target_offer_ids:input.targetOfferIDs??[],reference_event_id:input.referenceEventID??null,created_at:new Date().toISOString(),state:'queued'}
      await teamOutbox.put(row)
      if(scope!==accountScope.value)return false
      pendingMessages.value.push(row);clearDraft();void flushOutbox();return true
    }catch(failure){error.value=errorMessage(failure);return false}finally{sending.value=false}
  }

  function installSubscriptionHandlers(): void {
    disposers = [
      onEvent('team_collaboration_event', message => {
        if (accessRevoked.value || message.team_session_id !== sessionID.value || !message.event) return
        mergeEvents([message.event])
        if(message.event.event_seq>contiguousEventSeq.value)void catchUp().catch(f=>{error.value=errorMessage(f)})
        if (['run', 'status', 'agent_message'].includes(message.event.kind)) void refreshRuns().finally(scheduleRunPoll)
      }),
      onEvent('team_collaboration_subscription', message => {
        if(message.team_session_id===sessionID.value){subscribed.value=message.subscribed===true;if(subscribed.value)void catchUp().catch(f=>{error.value=errorMessage(f)})}
      }),
      onEvent('team_collaboration_subscription_error', message => {
        if (message.team_session_id !== sessionID.value) return
        const g=generation
        // Older Relays disable subscriptions together with writes. Confirm
        // HTTP read authority before treating their refusal as revocation.
        void Promise.all([getTeamSession(sessionID.value),getTeamCapabilities()]).then(([,caps])=>{
          if(g!==generation)return
          if(!caps.collaboration){capabilities.value=caps;subscribed.value=false;scheduleSessionPoll()}
          else {revokeAccess();error.value='无法订阅此共享会话'}
        }).catch(failure=>{if(g===generation){authorityFailure(failure);error.value=errorMessage(failure)}})
      }),
      onEvent('team_collaboration_access_revoked', message => {
        if (message.team_session_id !== sessionID.value) return
        revokeAccess()
      }),
      onEvent('connection_restored', () => {
        if (!session.value || !capabilities.value) { recoverOnline(); return }
        if(capabilities.value?.collaboration)subscribeTeamSession(sessionID.value)
        const latestSequence = contiguousEventSeq.value
        void catchUp(latestSequence).catch(failure => { error.value = errorMessage(failure) })
        void restoreOutbox().then(flushOutbox).catch(f=>{error.value=errorMessage(f)})
        void refreshRuns().finally(scheduleRunPoll)
      }),
    ]
  }

  watch(sessionID, (next, previous) => {
    if (previous) unsubscribeTeamSession(previous)
    if (next) void load()
  })

  watch(() => connected.value, online => { if (online) recoverOnline() })

  watch(()=>user.value?.id,()=>{generation++;pendingMessages.value=[];events.value=[];session.value=null;accessRevoked.value=true;unsubscribeTeamSession(sessionID.value)})
  onMounted(() => {
    disposed = false
    installSubscriptionHandlers()
    window.addEventListener('online', recoverOnline)
    void load()
  })
  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener('online', recoverOnline)
    generation++
    clearCallPoll()
    clearSessionPoll()
    clearRunPoll()
    unsubscribeTeamSession(sessionID.value)
    disposers.forEach(dispose => dispose())
  })

  return {
    pendingMessages,contiguousEventSeq,retryMessage,reconcileMessage,markRead,
    session, events, calls, context, runContext, runs, latestRun, task, capabilities, draft, loading, sending,
    runBusy, error, runError, connected, subscribed, callableBindings, autorunEnabled,
    readOnlyReason, canSend, load, reloadSession, refreshRuns, sendMessage, createRun,
    controlRun, supplementRunInput, suggestRunPause, withdrawAgent,
  }
}
