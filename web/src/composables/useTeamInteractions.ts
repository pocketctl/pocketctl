import {computed,onBeforeUnmount,onMounted,ref,watch,type Ref} from 'vue'
import {listTeamInteractions,actTeamInteraction} from '../services/teamClient'
import type {AttentionInboxItem} from '../types/attentionInbox'
import {useAuth} from './useAuth'
import {useWebSocket} from './useWebSocket'
export function useTeamInteractions(session:Readonly<Ref<string>>,enabled:Readonly<Ref<boolean>>=ref(true)){
 const privateItems=ref<AttentionInboxItem[]>([]),items=computed(()=>enabled.value?privateItems.value:[]),error=ref(''),busy=ref(''),{user}=useAuth(),{connected,onEvent}=useWebSocket()
 let timer:ReturnType<typeof setTimeout>|undefined,generation=0,disposed=false
 const keys=new Map<string,string>()
 async function refresh(){if(!enabled.value){privateItems.value=[];return}const g=generation,id=session.value;try{const result=await listTeamInteractions(id);if(g===generation&&!disposed)privateItems.value=result.items}catch(e){if(g===generation)privateItems.value=[]}finally{if(!disposed&&g===generation)timer=setTimeout(refresh,2000)}}
 function reset(){generation++;if(timer)clearTimeout(timer);privateItems.value=[];error.value='';keys.clear();if(!disposed)void refresh()}
 let detach:(()=>void)|undefined
 onMounted(()=>{detach=onEvent('connection_restored',reset);void refresh()});watch(session,reset);watch(enabled,reset,{flush:"sync"});watch(()=>user.value?.id,reset)
 onBeforeUnmount(()=>{disposed=true;generation++;if(timer)clearTimeout(timer);privateItems.value=[];detach?.()})
 async function act(item:AttentionInboxItem,action:'once'|'reject'){
  if(!enabled.value||!connected.value||busy.value||!['open','snoozed'].includes(item.state))return
  const k=`${item.item_id}:${item.revision}:${action}`,key=keys.get(k)??crypto.randomUUID();keys.set(k,key);busy.value=item.item_id;error.value=''
  try{await actTeamInteraction(session.value,item.item_id,key,item.revision,action)}catch(e){error.value=e instanceof Error?e.message:'结果待核对'}finally{busy.value='';if(timer)clearTimeout(timer);await refresh()}
 }
 return {items,error,busy,connected,act,refresh}
}
