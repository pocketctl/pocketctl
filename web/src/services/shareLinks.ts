import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
export interface ShareLink { id:string; session_id:string; title:string; created_at:string; expires_at:string; status:'active'|'revoked'|'expired'; server_time:string; url?:string }
export class ShareAPIError extends Error { constructor(public status:number){super(`HTTP ${status}`)} }
async function request<T>(path:string,method='GET',body?:unknown):Promise<T>{
  const {accessToken,doRefreshToken,user}=useAuth()
  const origin=getRelayOrigin(),owner=user.value?.id
  const current=()=>origin===getRelayOrigin()&&owner===user.value?.id
  const send=()=>fetch(`${origin}${path}`,{method,cache:'no-store',credentials:'include',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${accessToken.value}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})
  let response=await send()
  if(response.status===401&&await doRefreshToken()){if(!current())throw new Error("share identity changed");response=await send()}
  if(!current())throw new Error("share identity changed")
  if(!response.ok)throw new ShareAPIError(response.status)
  const result=await response.json()
  const valid=(link:ShareLink)=>link&&typeof link.id==='string'&&typeof link.session_id==='string'&&typeof link.title==='string'&&['active','expired','revoked'].includes(link.status)&&[link.created_at,link.expires_at,link.server_time].every(time=>typeof time==='string'&&Number.isFinite(Date.parse(time)))&&(!link.url||/^https?:\/\//.test(link.url))
  if(path.startsWith('/api/share-links?')||path==='/api/share-links'){
    if(!Array.isArray(result.links)||result.links.length>100||!result.links.every(valid)||!Number.isFinite(Date.parse(result.server_time)))throw new Error('invalid share list')
  }else if(!valid(result))throw new Error('invalid share record')
  return result
}
export const shareLinksAPI={
  list:(sessionId?:string)=>request<{links:ShareLink[];server_time:string}>(`/api/share-links${sessionId?`?session_id=${encodeURIComponent(sessionId)}`:''}`),
  create:(sessionId:string,requestId:string)=>request<ShareLink>(`/api/sessions/${encodeURIComponent(sessionId)}/share-link`,'POST',{request_id:requestId}),
  get:(id:string)=>request<ShareLink>(`/api/share-links/${encodeURIComponent(id)}`),
  url:(id:string)=>request<ShareLink>(`/api/share-links/${encodeURIComponent(id)}/url`),
  revoke:(id:string)=>request<ShareLink>(`/api/share-links/${encodeURIComponent(id)}`,'DELETE'),
}
