import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useWebSocket } from './useWebSocket'
import { useAuth } from './useAuth'
import { getRelayWs } from './useEnv'

export interface ZcodeQuotaWindow { id:'five_hour'|'week'; remaining_percent:number|null; resets_at:number|null }
export interface ZcodeQuotaSnapshot { kind:'zcode_quota'; scope_id:string; observed_at:string; status:'ok'|'not_configured'|'unsupported'; level:string; windows:ZcodeQuotaWindow[] }
export function parseZcodeQuota(value:any):ZcodeQuotaSnapshot|null {
  if(value?.kind!=='zcode_quota'||typeof value.scope_id!=='string'||!Number.isFinite(Date.parse(value.observed_at))||!['ok','not_configured','unsupported'].includes(value.status)||!['','lite','pro','max'].includes(value.level)||!Array.isArray(value.windows)||value.windows.length!==2)return null
  const ids=new Set<string>()
  for(const w of value.windows){
    if(!w||!['five_hour','week'].includes(w.id)||ids.has(w.id)||(w.remaining_percent!==null&&(typeof w.remaining_percent!=='number'||!Number.isFinite(w.remaining_percent)||w.remaining_percent<0||w.remaining_percent>100))||(w.resets_at!==null&&(!Number.isSafeInteger(w.resets_at)||w.resets_at<=0||w.resets_at>253402300799)))return null
    if(value.status!=='ok'&&(w.remaining_percent!==null||w.resets_at!==null))return null
    ids.add(w.id)
  }
  return {kind:'zcode_quota',scope_id:value.scope_id,observed_at:value.observed_at,status:value.status,level:value.level,windows:value.windows.map((w:ZcodeQuotaWindow)=>({id:w.id,remaining_percent:w.remaining_percent,resets_at:w.resets_at}))}
}

export function useZcodeQuota(options:Ref<{daemonId:string;online?:boolean}>) {
  const {connected,daemons,send,onEvent}=useWebSocket(),{user}=useAuth()
  const snapshot=ref<ZcodeQuotaSnapshot|null>(null),loading=ref(false),failed=ref(false),now=ref(Date.now())
  const online=computed(()=>connected.value&&(daemons.value.get(options.value.daemonId)?.online??options.value.online??true))
  const stale=computed(()=>!!snapshot.value&&(!online.value||failed.value||now.value-Date.parse(snapshot.value.observed_at)>120000||snapshot.value.windows.some(w=>w.resets_at!==null&&w.resets_at*1000<=now.value)))
  let mounted=false,identity='',request='',lastRead=0
  let timeout:ReturnType<typeof setTimeout>|undefined,tick:ReturnType<typeof setInterval>|undefined,stop:(()=>void)|undefined
  const key=()=>`${user?.value?.id??''}|${getRelayWs()}|${options.value.daemonId}`
  function cancel(){request='';loading.value=false;clearTimeout(timeout)}
  function reset(){cancel();snapshot.value=null;failed.value=false;identity=key();lastRead=0}
  function refresh(){
    if(identity!==key())reset()
    if(!mounted||!user?.value?.id||!options.value.daemonId||!online.value||loading.value||document.visibilityState==='hidden')return
    const id=crypto.randomUUID();request=id;loading.value=true;lastRead=Date.now()
    if(!send({type:'read_zcode_quota',daemon_id:options.value.daemonId,request_id:id})){cancel();failed.value=true;return}
    timeout=setTimeout(()=>{if(request===id){cancel();failed.value=true}},22000)
  }
  function receive(msg:any){
    if(identity!==key()){reset();return}
    if(!request||msg.request_id!==request||!['invocation_result','error'].includes(msg.type))return
    if(msg.daemon_id!==options.value.daemonId&&msg.type!=='error')return
    cancel()
    const parsed=msg.error?null:parseZcodeQuota(msg.invocation)
    if(parsed){snapshot.value=parsed;failed.value=false;now.value=Date.now()}
    else {failed.value=true;if(['forbidden','quota_account_changed','quota_credentials_unavailable','quota_authentication_required'].includes(msg.error))snapshot.value=null}
  }
  watch(key,()=>{reset();refresh()})
  watch(online,value=>{if(value)refresh();else cancel()})
  function visible(){now.value=Date.now();if(document.visibilityState==='hidden')cancel();else refresh()}
  onMounted(()=>{mounted=true;identity=key();stop=onEvent(receive);document.addEventListener('visibilitychange',visible);refresh();tick=setInterval(()=>{now.value=Date.now();if(now.value-lastRead>=60000)refresh()},1000)})
  onUnmounted(()=>{mounted=false;cancel();clearInterval(tick);stop?.();document.removeEventListener('visibilitychange',visible)})
  return {snapshot,loading,failed,online,stale,refresh}
}
