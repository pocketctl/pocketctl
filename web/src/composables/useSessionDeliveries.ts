import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { TeamApiError } from '../services/teamClient'
import { getSessionDeliveryCards } from '../services/teamDeliveryClient'
import { deliveryCacheScope, teamDeliveryCache } from '../services/teamDeliveryCache'
import type { SessionDeliveryCards, SessionDeliveryCard } from '../types/teamDelivery'

export function useSessionDeliveries(sessionID:Readonly<Ref<string>>,teamID:Readonly<Ref<string>>){
 const {user}=useAuth(),items=ref<SessionDeliveryCard[]>([]),cached=ref(false),error=ref(''),loading=ref(false),more=ref(false),available=ref(false)
 let epoch=0,pages=1,timer:ReturnType<typeof setTimeout>|undefined,disposed=false,inFlight=false
 const scope=()=>deliveryCacheScope(user.value?.id||0,getRelayOrigin())
 async function refresh(expand=false){
  if(inFlight||disposed||!sessionID.value||!user.value?.id)return
  const e=epoch,s=sessionID.value,owner=scope(),team=teamID.value,ticket=teamDeliveryCache.ticket();inFlight=true;loading.value=true
  const limit=pages+(expand?1:0)
  try{
   const next:SessionDeliveryCard[]=[],seen=new Set<string>();let cursor='',page:SessionDeliveryCards
   for(let i=0;i<limit;i++){
    page=await getSessionDeliveryCards(s,cursor)
    if(e!==epoch||owner!==scope()||disposed)return
    if(page.team_id!==team||page.team_session_id!==s)throw new Error('会话交付范围不匹配')
    for(const item of page.items)if(!seen.has(item.task_id)){next.push(item);seen.add(item.task_id)}
    if(!page.next_cursor)break
    if(page.next_cursor<=cursor)throw new Error('会话交付分页未推进')
    cursor=page.next_cursor
   }
   items.value=next;more.value=!!page!.next_cursor;cached.value=false;available.value=true;error.value='';pages=limit
   void teamDeliveryCache.write(owner,'cards',s,team,next.map(i=>i.task_id),{team_id:team,team_session_id:s,items:next,next_cursor:page!.next_cursor},ticket).catch(()=>{})
  }catch(err){if(e!==epoch||owner!==scope()||disposed)return
   if(err instanceof TeamApiError&&[401,403,404].includes(err.status)){
    items.value=[];cached.value=false;available.value=false;more.value=false
    // An absent endpoint on an older Relay is not proof of member revocation.
    if(err.status!==404||err.code==='team_not_found')void teamDeliveryCache.purge(owner,{session:s}).catch(()=>{})
    error.value=err.status===404&&err.code!=='team_not_found'?'':'无法读取此会话的交付记录'
   }else {cached.value=items.value.length>0;error.value='交付记录暂未刷新，显示上次同步内容';more.value=false}
  }finally{if(e===epoch){inFlight=false;loading.value=false;if(!disposed){clearTimeout(timer);timer=setTimeout(()=>void refresh(),5000)}}}
 }
 async function reset(){const e=++epoch;clearTimeout(timer);inFlight=false;pages=1;items.value=[];cached.value=false;available.value=false;more.value=false;error.value='';const owner=scope(),s=sessionID.value
  try{const saved=await teamDeliveryCache.read<SessionDeliveryCards>(owner,'cards',s);if(e!==epoch||disposed)return;if(saved&&saved.data.team_id===teamID.value){items.value=saved.data.items;cached.value=true;available.value=true}}catch{}
  if(e===epoch&&!disposed)void refresh()
 }
 function revoked(event:Event){const d=(event as CustomEvent).detail;if(d?.filesOnly)return;if(d?.scope&&d.scope!==scope())return;if(d?.team&&d.team!==teamID.value)return;if(d?.session&&d.session!==sessionID.value)return
  epoch++;clearTimeout(timer);inFlight=false;loading.value=false
  if(d?.task)items.value=items.value.filter(i=>i.task_id!==d.task);else items.value=[]
  cached.value=false;more.value=false;available.value=false
 }
 const changed=()=>void refresh(),offline=()=>{cached.value=items.value.length>0}
 watch(()=>[sessionID.value,teamID.value,user.value?.id,getRelayOrigin()],()=>void reset())
 onMounted(()=>{void reset();window.addEventListener('team-delivery-changed',changed);window.addEventListener('online',changed);window.addEventListener('offline',offline);window.addEventListener('focus',changed);window.addEventListener('team-delivery-cache-revoked',revoked)})
 onBeforeUnmount(()=>{disposed=true;epoch++;clearTimeout(timer);window.removeEventListener('team-delivery-changed',changed);window.removeEventListener('online',changed);window.removeEventListener('offline',offline);window.removeEventListener('focus',changed);window.removeEventListener('team-delivery-cache-revoked',revoked)})
 return {items,cached,error,loading,more,available,refresh,loadMore:()=>refresh(true)}
}
