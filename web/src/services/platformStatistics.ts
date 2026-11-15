import {useAuth} from '../composables/useAuth'
import {getRelayOrigin} from '../composables/useEnv'
import type {PlatformStatistics,StatisticsRange} from '../types/platformStatistics'
export class PlatformStatisticsError extends Error {
 constructor(readonly status:number,readonly code:string){super(code);this.name='PlatformStatisticsError'}
}
async function request<T>(path:string,signal?:AbortSignal,csv=false):Promise<T>{
 const auth=useAuth(),origin=getRelayOrigin(),id=auth.user.value?.id,initialToken=auth.accessToken.value
 let token=initialToken
 const guard=()=>{signal?.throwIfAborted();if(auth.user.value?.id!==id||getRelayOrigin()!==origin||auth.accessToken.value!==token)throw new PlatformStatisticsError(0,'identity_changed')}
 const send=()=>{guard();return fetch(`${origin}/api/admin/statistics${path}`,{method:'GET',credentials:'include',redirect:'error',cache:'no-store',signal,headers:{Accept:csv?'text/csv':'application/json',Authorization:`Bearer ${token}`}})}
 let response=await send();guard()
 if(response.status===401){
  const refreshed=await auth.doRefreshToken().catch(()=>false);signal?.throwIfAborted()
  if(auth.user.value?.id!==id||getRelayOrigin()!==origin)throw new PlatformStatisticsError(0,'identity_changed')
  token=auth.accessToken.value
  if(refreshed)response=await send()
 }
 guard()
 if(!response.ok){const body=await response.json().catch(()=>({}));guard();throw new PlatformStatisticsError(response.status,body.code||'request_failed')}
 const body=csv?await response.blob():await response.json();guard();return body as T
}
const query=(range?:StatisticsRange)=>range?`?${new URLSearchParams({from:range.from,to:range.to})}`:''
export const getPlatformStatisticsAccess=(signal?:AbortSignal)=>request<{allowed:boolean}>('/access',signal)
export const getPlatformStatistics=(range?:StatisticsRange,signal?:AbortSignal)=>request<PlatformStatistics>(query(range),signal)
export const exportPlatformStatistics=(range:StatisticsRange,signal?:AbortSignal)=>request<Blob>(`/export.csv${query(range)}`,signal,true)
