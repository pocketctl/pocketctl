import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from './useAuth'
import {useLocale} from './useLocale'
import {getRelayOrigin} from './useEnv'
import {deliveryCacheScope} from '../services/teamDeliveryCache'
import {TeamApiError,getTeamTask,getTeamTaskRequirementHistory,findTeamTaskRequirements,saveTeamTaskRequirements,overrideTeamTaskRequirements} from '../services/teamClient'
import {teamTaskRequirementsJournal as journal} from '../services/teamTaskRequirementsJournal'
import {normalizeRequirements,validRequirementsOperation,matchesRequirementsReceipt,matchesRequirementsResult,type RequirementsOperation} from '../types/teamTaskRequirements'
import type {TeamTask,TeamTaskRequirements,TeamTaskRequirementHistory} from '../types/team'
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
const blank=():TeamTaskRequirements=>({goal:'',scope:'',acceptance:'',repository:null})
export function useTeamTaskRequirements(props:{taskId:string;teamId:string;currentUserId:number;teamCreatorId:number;writesEnabled:boolean},changed:(task:TeamTask)=>void,denied:()=>void){
 const auth=useAuth(),{t}=useLocale(),task=ref<TeamTask|null>(null),draft=ref(blank()),reason=ref('')
 const history=ref<TeamTaskRequirementHistory>({events:[],next_before_revision:null})
 const pending=ref<RequirementsOperation|null>(null),confirmation=ref<RequirementsOperation|null>(null),retryConfirm=ref(false),missing=ref(false)
 const busy=ref(false),loading=ref(false),ready=ref(false),online=ref(navigator.onLine),error=ref(''),notice=ref(''),revoked=ref(false)
 let generation=0,disposed=false,team='',id='',actor=0,origin='',scope=''
 const same=()=>!disposed&&props.teamId===team&&props.taskId===id&&props.currentUserId===actor&&auth.user.value?.id===actor&&getRelayOrigin()===origin
 const current=(g:number)=>same()&&generation===g
 const identity=(g:number)=>({userId:actor,origin,isCurrent:()=>current(g)&&online.value&&!revoked.value})
 const locked=computed(()=>busy.value||loading.value||!ready.value||!online.value||revoked.value||!!pending.value)
 const canEdit=computed(()=>!locked.value&&props.writesEnabled&&!!task.value&&['open','in_progress'].includes(task.value.state))
 const canOverride=computed(()=>canEdit.value&&!!task.value?.requirements&&task.value.requirements.readiness.missing.length>0&&(actor===props.teamCreatorId||actor===task.value.creator_user_id))
 const isDenied=(e:unknown)=>e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404)
 function clear(){generation++;task.value=null;draft.value=blank();reason.value='';history.value={events:[],next_before_revision:null};pending.value=null;confirmation.value=null;retryConfirm.value=false;missing.value=false;ready.value=false;busy.value=false;loading.value=false;notice.value=''}
 function fail(e:unknown){if(isDenied(e)){clear();revoked.value=true;denied()}error.value=e instanceof Error?e.message:t('common.error')}
 function restore(op:RequirementsOperation){pending.value=clone(op);if(op.kind==='save')draft.value=clone(op.input.requirements);else reason.value=op.input.reason}
 async function load(){
  if(!same()||busy.value||loading.value||!online.value||revoked.value)return
  const retained=task.value&&JSON.stringify(draft.value)!==JSON.stringify(task.value.requirements?.document??{...blank(),goal:task.value.title})?clone(draft.value):null
  const g=generation;loading.value=true;ready.value=false;confirmation.value=null;error.value=''
  try{
   const saved=await journal.load(scope,id);if(!current(g))return
   if(saved&&(saved.team!==team||saved.actor!==actor))throw Error(t('team.requirements.mismatch'))
   const result=await getTeamTask(id,identity(g));if(!current(g))return
   if(result.id!==id||result.team_id!==team)throw Error(t('team.requirements.mismatch'))
   const events=await getTeamTaskRequirementHistory(id,identity(g));if(!current(g))return
   task.value=result;history.value=events;draft.value=retained??clone(result.requirements?.document??{...blank(),goal:result.title});reason.value='';pending.value=null
   if(saved)restore(saved);ready.value=true;notice.value=''
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function prepare(kind:'save'|'override'){
  if(!canEdit.value||kind==='override'&&!canOverride.value)return
  error.value='';notice.value=''
  try{
   const base={team,task:id,actor,requirementsRevision:task.value!.requirements?.revision??0},request_id=crypto.randomUUID(),expected_revision=task.value!.revision
   const op:RequirementsOperation=kind==='save'?{...base,kind,input:{request_id,expected_revision,requirements:normalizeRequirements(draft.value)}}:{...base,kind,input:{request_id,expected_revision,reason:reason.value.trim()}}
   if(!validRequirementsOperation(op))throw Error(t('team.requirements.invalid'))
   confirmation.value=op
  }catch(e){fail(e)}
 }
 async function finish(op:RequirementsOperation,result:TeamTask,g:number,recordScope:string){
  if(!matchesRequirementsResult(op,result))throw Error(t('team.requirements.mismatch'))
  await journal.remove(recordScope,op);if(!current(g))return
  pending.value=null;missing.value=false;retryConfirm.value=false;notice.value=t('team.requirements.saved');ready.value=false
  // Receipt is an immutable old result. Parent reloads instead of replacing a
  // newer task with this result; this page also reloads before further writes.
  changed(result)
 }
 async function send(op:RequirementsOperation,g:number,recordScope:string,first=false){
  let succeeded=false;missing.value=false;retryConfirm.value=false
  try{const result=op.kind==='save'?await saveTeamTaskRequirements(id,op.input,identity(g)):await overrideTeamTaskRequirements(id,op.input,identity(g));succeeded=true;if(current(g))await finish(op,result,g,recordScope)}
  catch(e){if(!current(g))return;if(isDenied(e)){fail(e);return}
   if(first&&!succeeded&&e instanceof TeamApiError&&[400,409,422].includes(e.status)&&!['idempotency_conflict','request_identity_changed'].includes(e.code)){
    await journal.remove(recordScope,op);if(!current(g))return;pending.value=null;ready.value=false;error.value=t('team.requirements.stale')
   }else error.value=t('team.requirements.unknown')
  }
 }
 async function save(){
  const op=confirmation.value;if(!op||!canEdit.value||op.kind==='override'&&!canOverride.value)return
  const g=generation,recordScope=scope;busy.value=true;confirmation.value=null;error.value=''
  try{await journal.reserve(recordScope,op);if(!current(g))return;restore(op);if(props.writesEnabled)await send(op,g,recordScope,true)}catch(e){if(current(g)){ready.value=false;fail(e)}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(!same()||!pending.value||busy.value||loading.value||!online.value||revoked.value)return
  const g=generation,op=clone(pending.value),recordScope=scope;busy.value=true;missing.value=false;error.value=''
  try{const receipt=await findTeamTaskRequirements(id,op.kind,op.input.request_id,identity(g));if(!current(g))return
   if(!matchesRequirementsReceipt(op,receipt))throw Error(t('team.requirements.mismatch'))
   if(receipt.found)await finish(op,receipt.response!,g,recordScope);else missing.value=true
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 async function retry(){
  if(!retryConfirm.value||!missing.value||!pending.value||!same()||busy.value||loading.value||!online.value||revoked.value||!props.writesEnabled)return
  const op=clone(pending.value),g=generation,recordScope=scope;busy.value=true;error.value=''
  try{await send(op,g,recordScope)}catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 async function more(){
  const cursor=history.value.next_before_revision;if(!cursor||locked.value)return
  const g=generation;loading.value=true
  try{const page=await getTeamTaskRequirementHistory(id,identity(g),cursor);if(current(g))history.value={events:[...history.value.events,...page.events.filter(e=>!history.value.events.some(old=>old.event_id===e.event_id))],next_before_revision:page.next_before_revision}}catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function discard(){if(locked.value)return;draft.value=clone(task.value?.requirements?.document??{...blank(),goal:task.value?.title??''});reason.value='';confirmation.value=null}
 function reset(){clear();revoked.value=false;error.value='';team=props.teamId;id=props.taskId;actor=props.currentUserId;origin=getRelayOrigin();scope=deliveryCacheScope(actor,origin);void load()}
 watch([()=>props.teamId,()=>props.taskId,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 watch([draft,reason],()=>{confirmation.value=null},{deep:true,flush:'sync'})
 watch(()=>props.writesEnabled,()=>{confirmation.value=null;retryConfirm.value=false})
 function connectivity(){online.value=navigator.onLine;confirmation.value=null;retryConfirm.value=false;if(!online.value){generation++;busy.value=false;loading.value=false;ready.value=false}else void load()}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')reset();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==actor){clear();revoked.value=true}}catch{clear();revoked.value=true}}}
 onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);window.addEventListener('storage',storage)})
 onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);window.removeEventListener('storage',storage)})
 return {task,draft,reason,history,pending,confirmation,retryConfirm,missing,busy,loading,ready,online,error,notice,revoked,locked,canEdit,canOverride,load,prepare,save,resolve,retry,more,discard}
}
