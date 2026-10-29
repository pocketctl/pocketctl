import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { listDeliveryInbox } from '../services/teamDeliveryClient'
import { TeamApiError } from '../services/teamClient'
import type { DeliveryReminder } from '../types/teamDelivery'

/** Component-scoped subscription; no cross-account or cross-Relay cache. */
export function useTeamDeliveryInbox(enabled: () => boolean = () => true) {
  const { user, accessToken } = useAuth()
  const items=ref<DeliveryReminder[]>([]),available=ref(false),error=ref('')
  let generation=0, timer:ReturnType<typeof setInterval>|undefined, disposed=false
  async function refresh(){
    const g=++generation, token=accessToken.value, owner=user.value?.id, origin=getRelayOrigin()
    if(!enabled()||!token||!owner){items.value=[];available.value=false;return}
    try{const result=await listDeliveryInbox();if(disposed||g!==generation||token!==accessToken.value||owner!==user.value?.id||origin!==getRelayOrigin())return
      items.value=result.items;available.value=true;error.value=''
    }catch(e){if(disposed||g!==generation)return
      if(e instanceof TeamApiError&&[401,403,404].includes(e.status)){items.value=[];available.value=false;error.value=''}
      else error.value='任务交付提醒暂未刷新'
    }
  }
  function revokeTeam(team:string){generation++;items.value=items.value.filter(item=>item.team_id!==team);void refresh()}
  const changed=()=>{void refresh()}
  watch(()=>[user.value?.id,accessToken.value,enabled()],()=>{generation++;items.value=[];available.value=false;void refresh()})
  onMounted(()=>{void refresh();timer=setInterval(changed,15000);window.addEventListener('team-delivery-changed',changed);window.addEventListener('focus',changed)})
  onBeforeUnmount(()=>{disposed=true;generation++;if(timer)clearInterval(timer);window.removeEventListener('team-delivery-changed',changed);window.removeEventListener('focus',changed)})
  return {items,available,error,refresh,revokeTeam}
}
