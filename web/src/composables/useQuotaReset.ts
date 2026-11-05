import {computed,onMounted,onUnmounted,ref,watch,type Ref} from 'vue'
import {useWebSocket} from './useWebSocket'
import {useAuth} from './useAuth'
import {getRelayWs} from './useEnv'
export interface QuotaResetOptions {daemonId:string;scopeId:string;provider:'codex'|'zcode';homeId?:string;enabled:boolean;online:boolean;recoverable?:boolean}
type Operation={key:string;type:string;phase:string}
export function useQuotaReset(options:Ref<QuotaResetOptions>){
 const {send,onEvent}=useWebSocket(),{user}=useAuth()
 const phase=ref('idle'),outcome=ref(''),operation=ref<Operation|null>(null)
 const identity=()=>JSON.stringify([user.value?.id??'',getRelayWs(),options.value.daemonId,options.value.scopeId])
 const storageKey=()=>`pocketctl:quota-reset:v1:${identity()}`
 let recovering=false
 let current='',request='',timer:ReturnType<typeof setTimeout>|undefined,stop:(()=>void)|undefined
 const locked=computed(()=>['submitting','unknown','checking'].includes(phase.value))
 function save(){try{localStorage.setItem(storageKey(),JSON.stringify(operation.value));return true}catch{return false}}
 function load(){try{const v=JSON.parse(localStorage.getItem(storageKey())??'null');return v&&/^[A-Za-z0-9_-]{16,64}$/.test(v.key)&&['codex','FIVE_HOUR','WEEK'].includes(v.type)&&typeof v.phase==='string'?v as Operation:null}catch{return null}}
 function reset(){clearTimeout(timer);request='';recovering=false;current=identity();operation.value=load();phase.value=operation.value?.phase??'idle';outcome.value='';if(phase.value==='submitting'||phase.value==='checking')phase.value='unknown'}
 function finish(next:string){clearTimeout(timer);request='';phase.value=next;if(operation.value){operation.value.phase=next;save()}}
 function transmit(type:string){
  if(!operation.value||!options.value.online)return
  const id=crypto.randomUUID();request=id
  const o=options.value,op=operation.value
  const command={type,daemon_id:o.daemonId,request_id:id,quota_scope_id:o.scopeId,idempotency_key:op.key,...(type==='consume_codex_reset_credit'?{codex_home_id:o.homeId??''}:{}),...(type==='consume_zcode_reset_credit'?{reset_type:op.type}:{})}
  if(!send(command)){finish(type==='read_quota_reset_result'?'unknown':'failed');return}
  timer=setTimeout(()=>{if(request===id)finish('unknown')},22000)
 }
 function submit(type:string){
  if(current!==identity())reset()
  if(!options.value.enabled||!options.value.online||locked.value||!user.value?.id||!/^[a-f0-9]{32}$/.test(options.value.scopeId))return
  if(options.value.provider==='codex'?type!=='codex':!['FIVE_HOUR','WEEK'].includes(type))return
  const existing=load();if(existing&&['submitting','unknown','checking'].includes(existing.phase)){operation.value=existing;phase.value='unknown';return}
  recovering=false;operation.value={key:crypto.randomUUID(),type,phase:'submitting'};phase.value='submitting';outcome.value=''
  if(!save()){phase.value='failed';return} // No durable recovery record means no redemption.
  transmit(options.value.provider==='codex'?'consume_codex_reset_credit':'consume_zcode_reset_credit')
 }
 function retryOriginal(){
  if(current!==identity())reset()
  if(options.value.provider!=='codex'||!operation.value||operation.value.type!=='codex'||phase.value!=='unknown'||!options.value.online||options.value.recoverable!==true||request)return
  recovering=true;phase.value='submitting';operation.value.phase='submitting';if(!save()){finish('unknown');return};transmit('consume_codex_reset_credit')
 }
 function reconcile(){if(current!==identity())reset();if(!request&&operation.value&&options.value.online&&locked.value){phase.value='checking';transmit('read_quota_reset_result')}}
 function receive(msg:any){
  if(current!==identity()){reset();return}
  if(!request||msg.request_id!==request||msg.daemon_id!==options.value.daemonId||!['invocation_result','error'].includes(msg.type))return
  if(msg.error){outcome.value=msg.error;finish(['quota_reset_unknown','quota_reset_pending'].includes(msg.error)||phase.value==='checking'||recovering?'unknown':'failed');return}
  const value=msg.invocation
  if(value?.kind!=='quota_reset'||value.scope_id!==options.value.scopeId||!['reset','alreadyRedeemed','nothingToReset','noCredit','unknown','notFound','unsupported'].includes(value.outcome))return
  outcome.value=value.outcome;finish(['reset','alreadyRedeemed'].includes(value.outcome)?'success':['unknown','notFound'].includes(value.outcome)?'unknown':value.outcome)
 }
 watch(identity,()=>{reset();if(locked.value)reconcile()})
 watch(()=>options.value.online,value=>{if(value&&locked.value)reconcile()})
 const storage=(e:StorageEvent)=>{if(e.key===storageKey()){reset();if(locked.value)reconcile()}}
 onMounted(()=>{reset();stop=onEvent(receive);window.addEventListener('storage',storage);if(locked.value)reconcile()})
 onUnmounted(()=>{clearTimeout(timer);stop?.();window.removeEventListener('storage',storage)})
 return {phase,outcome,locked,submit,reconcile,retryOriginal}
}
