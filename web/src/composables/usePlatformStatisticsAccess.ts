import {computed,ref,watch,type Ref} from 'vue'
import {useAuth} from './useAuth'
import {getRelayOrigin} from './useEnv'
import {getPlatformStatisticsAccess,PlatformStatisticsError} from '../services/platformStatistics'
export function createPlatformStatisticsAccess(identity:Ref<string>,load:(signal?:AbortSignal)=>Promise<{allowed:boolean}>){
 const status=ref<'idle'|'loading'|'allowed'|'denied'|'error'>('idle'),verified=ref('')
 let generation=0,controller:AbortController|undefined
 const allowed=computed(()=>!!identity.value&&verified.value===identity.value)
 function invalidate(){generation++;controller?.abort();verified.value='';status.value='denied'}
 watch(identity,()=>{invalidate();status.value='idle'},{flush:'sync'})
 async function refresh():Promise<boolean>{
  const key=identity.value;if(!key){invalidate();return false}
  controller?.abort();controller=new AbortController();const turn=++generation;status.value='loading'
  try{const result=await load(controller.signal);if(turn!==generation||key!==identity.value)return false
   verified.value=result.allowed?key:'';status.value=result.allowed?'allowed':'denied';return allowed.value
  }catch(error){if(turn!==generation||key!==identity.value)return false
   if(error instanceof PlatformStatisticsError&&[401,403].includes(error.status)){verified.value='';status.value='denied'}else status.value='error'
   return allowed.value
  }
 }
 return {allowed,status,refresh,invalidate}
}
let shared:ReturnType<typeof createPlatformStatisticsAccess>&{syncIdentity:()=>void}|undefined
export function usePlatformStatisticsAccess(){
 if(!shared){
  const auth=useAuth(),key=()=>auth.accessToken.value&&auth.user.value?`${auth.user.value.id}|${auth.accessToken.value}|${getRelayOrigin()}`:''
  const identity=ref(key()),controller=createPlatformStatisticsAccess(identity,getPlatformStatisticsAccess)
  const syncIdentity=()=>{identity.value=key()}
  watch([auth.accessToken,()=>auth.user.value?.id],()=>{syncIdentity();void controller.refresh()},{flush:'sync'})
  window.addEventListener('focus',()=>{syncIdentity();void controller.refresh()})
  window.addEventListener('storage',()=>{syncIdentity();void controller.refresh()})
  shared={...controller,syncIdentity}
 }
 return shared
}
