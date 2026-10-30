import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from './useAuth'
import {useLocale} from './useLocale'
import {getRelayOrigin} from './useEnv'
import {deliveryCacheScope} from '../services/teamDeliveryCache'
import {TeamApiError,getTeamTask,mutateTeamTaskSelfHolder,findTeamTaskSelfHolder} from '../services/teamClient'
import {teamTaskHolderJournal as journal} from '../services/teamTaskHolderJournal'
import {validHolderOperation,matchesHolderResult,matchesHolderReceipt,type HolderOperation} from '../types/teamTaskHolder'
import type {TeamTask} from '../types/team'
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
export function useTeamTaskHolder(props:{taskId:string;teamId:string;currentUserId:number;writesEnabled:boolean},changed:()=>void,denied:()=>void,refreshed:(task:TeamTask)=>void=()=>{}){
 const auth=useAuth(),{t}=useLocale(),task=ref<TeamTask|null>(null)
 const pending=ref<HolderOperation|null>(null),confirmation=ref<HolderOperation|null>(null),retryConfirm=ref(false),missing=ref(false)
 const busy=ref(false),loading=ref(false),ready=ref(false),online=ref(navigator.onLine),revoked=ref(false),error=ref(''),notice=ref('')
 let generation=0,disposed=false,team='',id='',actor=0,origin='',scope=''
 const same=()=>!disposed&&props.teamId===team&&props.taskId===id&&props.currentUserId===actor&&auth.user.value?.id===actor&&getRelayOrigin()===origin
 const current=(g:number)=>same()&&generation===g
 const identity=(g:number)=>({userId:actor,origin,isCurrent:()=>current(g)&&online.value&&!revoked.value})
 const canChange=computed(()=>same()&&ready.value&&!busy.value&&!loading.value&&online.value&&!revoked.value&&!pending.value&&props.writesEnabled&&!!task.value&&!['archived','deleted'].includes(task.value.state))
 const held=computed(()=>task.value?.holder_user_ids.includes(actor)===true)
 const isDenied=(e:unknown)=>e instanceof TeamApiError&&[401,403,404].includes(e.status)
 function clear(){generation++;task.value=null;pending.value=null;confirmation.value=null;retryConfirm.value=false;missing.value=false;ready.value=false;busy.value=false;loading.value=false;notice.value=''}
 function fail(e:unknown){if(isDenied(e)){clear();revoked.value=true;denied()}error.value=e instanceof Error?e.message:t('common.error')}
 async function load(){
  if(!same()||busy.value||loading.value||!online.value||revoked.value)return
  const g=generation;loading.value=true;ready.value=false;confirmation.value=null;retryConfirm.value=false;missing.value=false;error.value=''
  try{
   const op=await journal.load(scope,id);if(!current(g))return
   if(op&&(op.actor!==actor||op.team!==team))throw Error(t('team.holder.mismatch'))
   const value=await getTeamTask(id,identity(g));if(!current(g))return
   if(value.id!==id||value.team_id!==team||!Number.isSafeInteger(value.revision)||value.revision<1)throw Error(t('team.holder.mismatch'))
   task.value=value;pending.value=op;ready.value=true;notice.value='';refreshed(value)
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function prepare(){
  if(!canChange.value)return
  const op:HolderOperation={team,task:id,actor,active:!held.value,input:{request_id:crypto.randomUUID(),expected_revision:task.value!.revision}}
  if(validHolderOperation(op))confirmation.value=op
 }
 async function finish(op:HolderOperation,value:TeamTask,g:number,recordScope:string){
  if(!matchesHolderResult(op,value))throw Error(t('team.holder.mismatch'))
  await journal.remove(recordScope,op);if(!current(g))return
  pending.value=null;missing.value=false;retryConfirm.value=false;ready.value=false;notice.value=t('team.holder.saved');changed()
 }
 async function send(op:HolderOperation,g:number,recordScope:string,first=false){
  missing.value=false;retryConfirm.value=false;let received=false
  try{const value=await mutateTeamTaskSelfHolder(op.task,op.active,op.input,identity(g));received=true;if(current(g))await finish(op,value,g,recordScope)}
  catch(e){
   if(!current(g))return;if(isDenied(e)){fail(e);return}
   if(first&&!received&&e instanceof TeamApiError&&[400,409,422].includes(e.status)&&!['idempotency_conflict','request_identity_changed'].includes(e.code)){
    await journal.remove(recordScope,op);if(!current(g))return;pending.value=null;ready.value=false;error.value=t('team.holder.stale')
   }else error.value=t('team.holder.unknown')
  }
 }
 async function confirm(){
  const op=confirmation.value
  if(!op||!canChange.value||op.active===held.value||op.input.expected_revision!==task.value?.revision)return
  const g=generation,recordScope=scope;busy.value=true;confirmation.value=null;error.value='';notice.value=''
  try{await journal.reserve(recordScope,op);if(!current(g))return;pending.value=clone(op);if(props.writesEnabled)await send(op,g,recordScope,true)}
  catch(e){if(current(g)){ready.value=false;fail(e)}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(!same()||!pending.value||busy.value||loading.value||!online.value||revoked.value)return
  const op=clone(pending.value),g=generation,recordScope=scope;busy.value=true;missing.value=false;error.value=''
  try{const r=await findTeamTaskSelfHolder(op.task,op.input.request_id,identity(g));if(!current(g))return
   if(!matchesHolderReceipt(op,r))throw Error(t('team.holder.mismatch'))
   if(r.found)await finish(op,r.response!,g,recordScope);else missing.value=true
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 async function retry(){
  if(!retryConfirm.value||!missing.value||!pending.value||!same()||!ready.value||busy.value||loading.value||!online.value||revoked.value||!props.writesEnabled)return
  const op=clone(pending.value),g=generation,recordScope=scope;busy.value=true;error.value=''
  try{await send(op,g,recordScope)}catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 function reset(){clear();revoked.value=false;error.value='';team=props.teamId;id=props.taskId;actor=props.currentUserId;origin=getRelayOrigin();scope=deliveryCacheScope(actor,origin);void load()}
 watch([()=>props.teamId,()=>props.taskId,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 watch(()=>props.writesEnabled,()=>{confirmation.value=null;retryConfirm.value=false})
 function connectivity(){online.value=navigator.onLine;confirmation.value=null;retryConfirm.value=false;missing.value=false;if(!online.value){generation++;busy.value=false;loading.value=false;ready.value=false}else void load()}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')reset();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==actor){clear();revoked.value=true}}catch{clear();revoked.value=true}}}
 onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);window.addEventListener('storage',storage)})
 onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);window.removeEventListener('storage',storage)})
 return {task,pending,confirmation,retryConfirm,missing,busy,loading,ready,online,revoked,error,notice,canChange,held,load,prepare,confirm,resolve,retry}
}
