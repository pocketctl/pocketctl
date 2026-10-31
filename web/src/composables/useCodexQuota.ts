import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useWebSocket } from './useWebSocket'
import { useAuth } from './useAuth'
import { getRelayWs } from './useEnv'
export interface CodexQuotaWindow { remaining_percent: number; duration_minutes: number | null; resets_at: number | null }
export interface CodexQuotaBucket { id:string; name:string; plan_type?:string; exhausted:boolean; windows:CodexQuotaWindow[] }
export interface CodexResetCredits { available_count:number; credits:{expires_at:number|null}[]|null }
export interface CodexQuotaSnapshot { kind:'codex_rate_limits'; scope_id:string; observed_at:string; status?:'ok'|'unauthenticated'|'unsupported'; plan_type?:string; exhausted:boolean; buckets:CodexQuotaBucket[]; reset_credits?:CodexResetCredits|null }
const stamp=(n:any)=>n===null||(Number.isSafeInteger(n)&&n>0&&n<=253402300799)
export function parseCodexQuota(value:any):CodexQuotaSnapshot|null {
 if(value?.kind!=='codex_rate_limits'||typeof value.scope_id!=='string'||typeof value.exhausted!=='boolean'||!Number.isFinite(Date.parse(value.observed_at))||!Array.isArray(value.buckets)||value.buckets.length>32)return null
 if(value.status!==undefined&&!['ok','unauthenticated','unsupported'].includes(value.status))return null
 if(value.plan_type!==undefined&&(typeof value.plan_type!=='string'||value.plan_type.length>80))return null
 if(!value.buckets.every((b:any)=>b&&typeof b.id==='string'&&b.id.length<=128&&typeof b.name==='string'&&b.name.length<=256&&typeof b.exhausted==='boolean'&&Array.isArray(b.windows)&&b.windows.length<=2&&b.windows.every((w:any)=>w&&typeof w.remaining_percent==='number'&&Number.isFinite(w.remaining_percent)&&w.remaining_percent>=0&&w.remaining_percent<=100&&(w.duration_minutes===null||(Number.isSafeInteger(w.duration_minutes)&&w.duration_minutes>0))&&stamp(w.resets_at))))return null
 const r=value.reset_credits
 if(r!=null&&(!Number.isSafeInteger(r.available_count)||r.available_count<0||r.available_count>1000000||(r.credits!==null&&(!Array.isArray(r.credits)||r.credits.length>64||r.credits.length>r.available_count||!r.credits.every((c:any)=>c&&stamp(c.expires_at))))))return null
 return {kind:value.kind,scope_id:value.scope_id,observed_at:value.observed_at,status:value.status??'ok',plan_type:value.plan_type??'unknown',exhausted:value.exhausted,buckets:value.buckets.map((b:any)=>({id:b.id,name:b.name,exhausted:b.exhausted,windows:b.windows.map((w:any)=>({remaining_percent:w.remaining_percent,duration_minutes:w.duration_minutes,resets_at:w.resets_at}))})),reset_credits:r==null?null:{available_count:r.available_count,credits:r.credits===null?null:r.credits.map((c:any)=>({expires_at:c.expires_at}))}}
}
export function useCodexQuota(options: Ref<{sessionId?:string;daemonId:string;homeId?:string;online?:boolean}>) {
  const { connected, daemons, send, onEvent } = useWebSocket()
  const { user } = useAuth()
  const snapshot = ref<CodexQuotaSnapshot | null>(null), loading = ref(false), failed = ref(false), now = ref(Date.now())
  const online = computed(() => connected.value && (daemons.value.get(options.value.daemonId)?.online ?? options.value.online ?? true))
  const stale = computed(() => !!snapshot.value && (!online.value || failed.value || now.value - Date.parse(snapshot.value.observed_at) > 120000 || snapshot.value.buckets.some(b=>b.windows.some(w=>w.resets_at!==null&&w.resets_at*1000<=now.value)) || snapshot.value.reset_credits?.credits?.some(c=>c.expires_at!==null&&c.expires_at*1000<=now.value)))
  let request = '', timer: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setInterval> | undefined, delayed: ReturnType<typeof setTimeout> | undefined
  let lastRead=0
  let mounted = false, dirty = false, stop: (()=>void) | undefined
  let identity = ''
  const key = () => `${user?.value?.id ?? ''}:${getRelayWs()}:${options.value.daemonId}:${options.value.sessionId??''}:${options.value.homeId??''}`
  function cancel(){request='';loading.value=false;clearTimeout(timer)}
  function reset(){cancel();clearTimeout(delayed);dirty=false;snapshot.value=null;failed.value=false;identity=key();lastRead=0}
  function refresh(){
    if (key() !== identity) reset()
    if (!mounted || !user?.value?.id || loading.value || !online.value || document.visibilityState === 'hidden') return
    const id=crypto.randomUUID();request=id;loading.value=true;lastRead=Date.now()
    if (!send(options.value.sessionId?{type:'read_codex_rate_limits',session_id:options.value.sessionId,request_id:id}:{type:'read_codex_host_rate_limits',daemon_id:options.value.daemonId,codex_home_id:options.value.homeId??'',request_id:id})) {cancel();failed.value=true;return}
    timer=setTimeout(()=>{if(request===id){cancel();failed.value=true}},22000)
  }
  function schedule(){if(delayed)return;delayed=setTimeout(()=>{delayed=undefined;refresh()},1000)}
  function receive(msg:any){
    if (key()!==identity){reset();return}
    if (msg.type==='connection_restored' || msg.type==='websocket_connected') {refresh();return}
    if(msg.type!=='error'&&(options.value.sessionId ? msg.session_id!==options.value.sessionId : msg.daemon_id!==options.value.daemonId)) return
    if(!options.value.sessionId&&msg.type==='codex_rate_limits_changed'&&options.value.homeId&&msg.codex_home_id&&msg.codex_home_id!==options.value.homeId)return
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
    else {failed.value=true;if(msg.error==='forbidden' || ['session not found or not owned','quota_account_changed','quota_credentials_unavailable','quota_authentication_required'].includes(msg.error))snapshot.value=null}
    if(dirty){dirty=false;schedule()}
  }
  watch(key,()=>{reset();refresh()})
  watch(online,value=>{if(value)refresh();else cancel()})
  const visible=()=>{now.value=Date.now();if(document.visibilityState!=='hidden')refresh();else cancel()}
  onMounted(()=>{mounted=true;identity=key();stop=onEvent(receive);document.addEventListener('visibilitychange',visible);refresh();tick=setInterval(()=>{now.value=Date.now();if(now.value-lastRead>=60000)refresh()},1000)})
  onUnmounted(()=>{mounted=false;cancel();clearInterval(tick);clearTimeout(delayed);stop?.();document.removeEventListener('visibilitychange',visible)})
  return {snapshot,loading,failed,online,stale,refresh}
}
