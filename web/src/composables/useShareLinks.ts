import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { shareLinksAPI, ShareAPIError, type ShareLink } from '../services/shareLinks'
export function useShareLinks(sessionId:Ref<string|undefined>){
  const {user}=useAuth()
  const scope=computed(()=>`${getRelayOrigin()}:${user.value?.id}:${sessionId.value||'all'}`)
  const records=ref<ShareLink[]>([]), selectedId=ref(''), loading=ref(false), busy=ref(false), error=ref(''), message=ref(''), loaded=ref(false)
  const now=ref(Date.now()),offset=ref(0)
  const pending=ref<{kind:'create'|'revoke';id:string}|null>(null)
  const links=computed(()=>records.value.filter(x=>x.status==='active'&&Date.parse(x.expires_at)>now.value))
  const selected=computed(()=>links.value.find(x=>x.id===selectedId.value)||links.value[0])
  const groups=computed(()=>Object.values(links.value.reduce((groups,r)=>{(groups[r.session_id]??={title:r.title,rows:[]}).rows.push(r);return groups},Object.create(null) as Record<string,{title:string;rows:ShareLink[]}>)))
  const sync=(time:string)=>{offset.value=Date.parse(time)-Date.now();now.value=Date.now()+offset.value}
  const key=()=>`pocketctl:pending-share:${scope.value}`
  function savePending(value:typeof pending.value){pending.value=value;try{value?localStorage.setItem(key(),JSON.stringify(value)):localStorage.removeItem(key())}catch{/* in-memory recovery remains available */}}
  let revision=0, disposed=false
  async function load(){const rev=++revision,identity=scope.value;loading.value=true;error.value=''
    try{const result=await shareLinksAPI.list(sessionId.value);if(rev!==revision||(disposed||identity!==scope.value))return;records.value=result.links;sync(result.server_time);loaded.value=true}
    catch{if(rev===revision){error.value='load';loaded.value=false}}
    finally{if(rev===revision)loading.value=false}
  }
  async function mutate(kind:'create'|'revoke',id?:string){
    if(busy.value)return
    const operation=pending.value||{kind,id:id||crypto.randomUUID()},identity=scope.value
    if(operation.kind==='create'&&!sessionId.value)return
    savePending(operation);busy.value=true;error.value='';message.value=''
    try{
      const result=operation.kind==='create'?await shareLinksAPI.create(sessionId.value!,operation.id):await shareLinksAPI.revoke(operation.id)
      if((disposed||identity!==scope.value))return
      savePending(null);sync(result.server_time);selectedId.value=result.id;message.value=result.status==='active'?'created':'revoked';await load()
    }catch(e){if((disposed||identity!==scope.value))return
      // Definite rejection made no mutation; ambiguous/network failures keep the exact intent.
      if(e instanceof ShareAPIError&&[400,401,403,404,409,429].includes(e.status)){savePending(null);error.value=e.status===429?'limit':'rejected'}else error.value='unknown'
    }finally{if((!disposed&&identity===scope.value))busy.value=false}
  }
  async function reconcile(){if(!pending.value||busy.value)return
    if(pending.value.kind==='create'){await mutate('create');return}
    const identity=scope.value;busy.value=true
    try{const result=await shareLinksAPI.get(pending.value.id);if((disposed||identity!==scope.value))return;sync(result.server_time)
      if(result.status!=='active'){savePending(null);message.value='revoked';await load()}else{error.value='stillActive';savePending(null)}
    }catch(e){if((!disposed&&identity===scope.value)){if(e instanceof ShareAPIError&&e.status===404){savePending(null);await load()}else error.value='unknown'}}finally{if((!disposed&&identity===scope.value))busy.value=false}
  }
  async function copy(link:ShareLink){if(busy.value||loading.value||!loaded.value||pending.value)return;busy.value=true;const identity=scope.value
    try{
      const value=shareLinksAPI.url(link.id).then(fresh=>{if(disposed||identity!==scope.value||!fresh.url||fresh.status!=='active')throw new Error();sync(fresh.server_time);return fresh.url})
      // Start the clipboard operation within the user gesture (Safari), while the
      // item promise waits for the server's current authorization check.
      if(typeof ClipboardItem!=='undefined'&&navigator.clipboard.write){await navigator.clipboard.write([new ClipboardItem({'text/plain':value.then(url=>new Blob([url],{type:'text/plain'}))})])}
      else await navigator.clipboard.writeText(await value)
      if(!disposed&&identity===scope.value)message.value='copied'
    }catch{if((!disposed&&identity===scope.value)){error.value='copy';await load();error.value='copy'}}finally{if((!disposed&&identity===scope.value))busy.value=false}}
  function resume(){if(document.visibilityState==='visible')void load()}
  const timer=setInterval(()=>{now.value=Date.now()+offset.value},1000)
  document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume)
  watch(scope,()=>{revision++;records.value=[];loaded.value=false;busy.value=false;selectedId.value='';pending.value=null;message.value=''
    try{const item=JSON.parse(localStorage.getItem(key())||'null');if(item&&['create','revoke'].includes(item.kind)&&typeof item.id==='string')pending.value=item}catch{}
    void load()
  },{immediate:true})
  onBeforeUnmount(()=>{disposed=true;revision++;clearInterval(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('focus',resume)})
  return {links,selected,selectedId,groups,loading,loaded,busy,error,message,pending,now,load,mutate,reconcile,copy}
}
