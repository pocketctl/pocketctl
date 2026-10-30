import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useWebSocket } from './useWebSocket'
import { useAuth } from './useAuth'
import { getRelayWs } from './useEnv'
export interface CodexQuotaWindow { remaining_percent: number; duration_minutes: number | null; resets_at: number | null }
export interface CodexQuotaBucket { id: string; name: string; exhausted: boolean; windows: CodexQuotaWindow[] }
export interface CodexQuotaSnapshot { kind: 'codex_rate_limits'; scope_id: string; observed_at: string; exhausted: boolean; buckets: CodexQuotaBucket[] }
export function parseCodexQuota(value: any): CodexQuotaSnapshot | null {
  if (value?.kind !== 'codex_rate_limits' || typeof value.scope_id !== 'string' || typeof value.exhausted !== 'boolean' || !Number.isFinite(Date.parse(value.observed_at)) || !Array.isArray(value.buckets) || value.buckets.length > 32) return null
  if (!value.buckets.every((b:any) => typeof b.id === 'string' && typeof b.name === 'string' && typeof b.exhausted === 'boolean' && Array.isArray(b.windows) && b.windows.length <= 2 && b.windows.every((w:any) => typeof w.remaining_percent === 'number' && Number.isFinite(w.remaining_percent) && w.remaining_percent >= 0 && w.remaining_percent <= 100 && (w.duration_minutes === null || (Number.isSafeInteger(w.duration_minutes) && w.duration_minutes > 0)) && (w.resets_at === null || (Number.isSafeInteger(w.resets_at) && w.resets_at > 0 && w.resets_at <= 253402300799))))) return null
  return value
}
export function useCodexQuota(options: Ref<{sessionId:string;daemonId:string;online?:boolean}>) {
  const { connected, daemons, send, onEvent } = useWebSocket()
  const { user } = useAuth()
  const snapshot = ref<CodexQuotaSnapshot | null>(null), loading = ref(false), failed = ref(false), now = ref(Date.now())
  const online = computed(() => connected.value && (daemons.value.get(options.value.daemonId)?.online ?? options.value.online ?? true))
  const stale = computed(() => !!snapshot.value && (!online.value || failed.value || now.value - Date.parse(snapshot.value.observed_at) > 120000))
  let request = '', timer: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setInterval> | undefined, delayed: ReturnType<typeof setTimeout> | undefined
  let mounted = false, dirty = false, stop: (()=>void) | undefined
  let identity = ''
  const key = () => `${user?.value?.id ?? ''}:${getRelayWs()}:${options.value.daemonId}:${options.value.sessionId}`
  function cancel(){request='';loading.value=false;clearTimeout(timer)}
  function reset(){cancel();clearTimeout(delayed);dirty=false;snapshot.value=null;failed.value=false;identity=key()}
  function refresh(){
    if (key() !== identity) reset()
    if (!mounted || !user?.value?.id || loading.value || !online.value || document.visibilityState === 'hidden') return
    const id=crypto.randomUUID();request=id;loading.value=true
    if (!send({type:'read_codex_rate_limits',session_id:options.value.sessionId,request_id:id})) {cancel();failed.value=true;return}
    timer=setTimeout(()=>{if(request===id){cancel();failed.value=true}},22000)
  }
  function schedule(){if(delayed)return;delayed=setTimeout(()=>{delayed=undefined;refresh()},1000)}
  function receive(msg:any){
    if (key()!==identity){reset();return}
    if (msg.type==='connection_restored' || msg.type==='websocket_connected') {refresh();return}
    if (msg.session_id!==options.value.sessionId) return
    if (msg.type==='session_deleted'){reset();return}
    if (msg.type==='codex_rate_limits_changed') {
      if(msg.resync){cancel();snapshot.value=null}
      if(loading.value)dirty=true;else schedule()
      return
    }
    if (!request || msg.request_id!==request || !['invocation_result','error'].includes(msg.type)) return
    cancel()
    const parsed = msg.error ? null : parseCodexQuota(msg.invocation)
    if(parsed){snapshot.value=parsed;failed.value=false;now.value=Date.now()}
    else {failed.value=true;if(msg.error==='forbidden' || msg.error==='session not found or not owned')snapshot.value=null}
    if(dirty){dirty=false;schedule()}
  }
  watch(()=>[options.value.sessionId,options.value.daemonId,user?.value?.id],()=>{reset();refresh()})
  watch(online,value=>{if(value)refresh();else cancel()})
  const visible=()=>{now.value=Date.now();if(document.visibilityState!=='hidden')refresh()}
  onMounted(()=>{mounted=true;identity=key();stop=onEvent(receive);document.addEventListener('visibilitychange',visible);refresh();tick=setInterval(()=>{now.value=Date.now();refresh()},60000)})
  onUnmounted(()=>{mounted=false;cancel();clearInterval(tick);clearTimeout(delayed);stop?.();document.removeEventListener('visibilitychange',visible)})
  return {snapshot,loading,failed,online,stale,refresh}
}
