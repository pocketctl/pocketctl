import { controlTaskPlan, getTaskPlanControlReceipt, saveTaskPlanDraft, getTaskPlanDraftReceipt } from '../services/teamPlanClient'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { deliveryCacheScope } from '../services/teamDeliveryCache'
import { TeamApiError } from '../services/teamClient'
import { deliveryOperationError } from '../services/teamDeliveryDiagnostics'
import { revokeDeliveryArtifact, decideTaskDelivery, reviseDeliverySpec, executeDeliveryTask, getDeliveryReceipt } from '../services/teamDeliveryClient'
import { confirmedDeliveryReceipt, type DeliveryPendingOperation } from '../services/teamDeliveryRecovery'
import { TeamDeliveryOperationJournal, validDeliveryIntent, type DeliveryIntent } from '../services/teamDeliveryOperationJournal'

export function useTeamDeliveryOperation(task:()=>string,actor:()=>number,complete:(failure?:string)=>void|Promise<void>,denied:()=>void){
 const auth=useAuth(),journal=new TeamDeliveryOperationJournal()
 const pending=ref<DeliveryIntent|null>(null),busy=ref(false),ready=ref(false),receiptMissing=ref(false),confirmRetry=ref(false),error=ref(''),storageError=ref(''),revoked=ref(false)
 let origin='',owner=0,taskId='',scope='',generation=0,read=0,disposed=false,channel:BroadcastChannel|undefined
 const same=()=>!disposed&&getRelayOrigin()===origin&&actor()===owner&&auth.user.value?.id===owner&&task()===taskId
 const current=(g:number)=>generation===g&&same()
 const blocked=computed(()=>!ready.value||busy.value||!!pending.value||revoked.value||!same())
 const denial=(e:unknown)=>e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found'||e.code==='request_identity_changed')
 function revoke(){if(revoked.value)return;generation++;read++;ready.value=false;busy.value=false;pending.value=null;revoked.value=true;receiptMissing.value=false;confirmRetry.value=false;error.value='账号或访问权限已变化，原请求已保留。';denied()}
 function notify(){const info={scope,task:taskId};window.dispatchEvent(new CustomEvent('team-delivery-operation-changed',{detail:info}));channel?.postMessage(info)}
 function fail(e:unknown){if(!same()||denial(e)){revoke();return}error.value=e instanceof Error?e.message:'原操作暂时无法确认，请重试。'}
 async function migrate(opScope:string,id:string,user:number,relay:string){
  const keys=[`team-delivery:${relay}:${user}:${id}`,`team-delivery-management:${relay}:${user}:${id}`],raw=keys.map(key=>sessionStorage.getItem(key)),intents:DeliveryIntent[]=[]
  raw.forEach((item,index)=>{if(item===null)return;let parsed;try{parsed=JSON.parse(item)}catch{throw new Error('原操作记录损坏，请保留记录并核对任务。')}const intent:DeliveryIntent={task:id,actor:user,operation:index===0?{kind:'acceptance',input:parsed}:parsed};if(!validDeliveryIntent(intent))throw new Error('原操作记录损坏，请保留记录并核对任务。');intents.push(intent)})
  await journal.importLegacy(opScope,id,intents)
  // Never erase a newer legacy record written while the IDB commit awaited.
  keys.forEach((key,index)=>{if(raw[index]!==null){if(sessionStorage.getItem(key)!==raw[index])throw new Error('旧操作记录已变化，请重新读取。');sessionStorage.removeItem(key)}})
 }
 async function refresh(){
  if(busy.value||revoked.value)return
  if(!same()){revoke();return}
  const g=generation,r=++read,opScope=scope,id=taskId,user=owner,relay=origin;ready.value=false
  try{await migrate(opScope,id,user,relay);if(!current(g)||r!==read)return;const saved=await journal.load(opScope,id);if(!current(g)||r!==read)return
   if(saved.some(v=>v.actor!==user))throw new Error('原操作的账号不匹配。')
   const next=saved[0]??null;if(JSON.stringify(next)!==JSON.stringify(pending.value)){receiptMissing.value=false;confirmRetry.value=false}
   pending.value=next;storageError.value='';ready.value=true
  }catch(e){if(current(g)&&r===read){ready.value=false;receiptMissing.value=false;confirmRetry.value=false;storageError.value=e instanceof Error?e.message:'无法读取原操作记录。'}}
 }
 async function finish(intent:DeliveryIntent,result:unknown,g:number,opScope:string){
  confirmedDeliveryReceipt({task_id:intent.task,...((intent.operation.kind==='acceptance'||intent.operation.kind==='revoke_artifact')&&intent.operation.attemptId?{attempt_id:intent.operation.attemptId}:{}),request_id:intent.operation.input.request_id,found:true,receipt:{operation:intent.operation.kind==='revoke_artifact'?`revoke:${intent.operation.submissionId}:${intent.operation.artifactId}`:intent.operation.kind,response:result}},intent.task,intent.operation)
  await journal.remove(opScope,intent);if(!current(g))return
  pending.value=null;receiptMissing.value=false;confirmRetry.value=false;busy.value=false;notify();await refresh();if(current(g))await complete()
 }
 async function send(intent:DeliveryIntent,g:number,opScope:string,first:boolean){
  error.value='';receiptMissing.value=false;confirmRetry.value=false
  const op=intent.operation,identity={userId:intent.actor,origin}
  try{
   const result=op.kind==='revoke_artifact'?await revokeDeliveryArtifact(intent.task,op.submissionId,op.artifactId,op.input,identity,op.attemptId):op.kind==='plan_draft'?await saveTaskPlanDraft(intent.task,op.input,identity):op.kind==='plan_control'?await controlTaskPlan(intent.task,op.input,identity):op.kind==='acceptance'?(op.attemptId?await decideTaskDelivery(intent.task,op.input,identity,op.attemptId):await decideTaskDelivery(intent.task,op.input,identity)):op.kind==='revise_spec'?await reviseDeliverySpec(intent.task,op.input,identity):await executeDeliveryTask(intent.task,op.session!,op.input,identity)
   if(current(g))await finish(intent,result,g,opScope)
  }catch(e){if(!current(g))return
   if(denial(e)){revoke();return}
   if(first&&e instanceof TeamApiError&&(400<=e.status&&e.status<500)&&![408,429].includes(e.status)&&e.code!=='idempotency_conflict'){
    try{await journal.remove(opScope,intent);if(!current(g))return;pending.value=null;busy.value=false;notify();await refresh();if(current(g)){error.value=deliveryOperationError(e);await complete(error.value)}}catch(storage){if(current(g)){ready.value=false;storageError.value=storage instanceof Error?storage.message:'无法更新操作记录。'}}
   }else error.value='操作结果未知，请查询原操作。'
  }
 }
 async function submit(operation:DeliveryPendingOperation){
  if(blocked.value||!navigator.onLine)return
  const intent:DeliveryIntent={task:taskId,actor:owner,operation:JSON.parse(JSON.stringify(operation))};if(!validDeliveryIntent(intent))return
  busy.value=true;const g=generation,opScope=scope
  try{await journal.reserve(opScope,intent);if(!current(g))return;pending.value=intent;notify();await send(intent,g,opScope,true)}catch(e){if(current(g)){ready.value=false;storageError.value=e instanceof Error?e.message:'无法保存原操作。'}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(!ready.value||busy.value||revoked.value||!same()||!pending.value||!navigator.onLine)return
  busy.value=true;receiptMissing.value=false;confirmRetry.value=false;error.value='';const g=generation,intent=JSON.parse(JSON.stringify(pending.value)) as DeliveryIntent,opScope=scope
  try{const identity={userId:intent.actor,origin};const result=await (intent.operation.kind==='plan_draft'?getTaskPlanDraftReceipt(intent.task,intent.operation.input.request_id,identity):intent.operation.kind==='plan_control'?getTaskPlanControlReceipt(intent.task,intent.operation.input.request_id,identity):getDeliveryReceipt(intent.task,intent.operation.input.request_id,identity,(intent.operation.kind==='acceptance'||intent.operation.kind==='revoke_artifact')?intent.operation.attemptId:undefined));if(!current(g))return
   if(confirmedDeliveryReceipt(result,intent.task,intent.operation)){await finish(intent,(result as {receipt:{response:unknown}}).receipt.response,g,opScope)}else{receiptMissing.value=true;error.value='未查到原操作回执，可确认重试相同请求和内容。'}
  }catch(e){if(current(g)){if(e instanceof TeamApiError&&e.status===404&&e.code!=='team_not_found')error.value='此 Relay 暂不支持原操作查询，已保留记录。';else fail(e)}}finally{if(g===generation)busy.value=false}
 }
 async function retry(){
  if(!confirmRetry.value||!receiptMissing.value||!ready.value||busy.value||revoked.value||!same()||!pending.value||!navigator.onLine)return
  busy.value=true;const g=generation,intent=JSON.parse(JSON.stringify(pending.value)) as DeliveryIntent,opScope=scope
  try{const saved=await journal.load(opScope,intent.task);if(!current(g))return;if(!saved.some(v=>JSON.stringify(v)===JSON.stringify(intent)))throw new Error('原操作记录已变化，请重新读取。');await send(intent,g,opScope,false)}catch(e){if(current(g)){ready.value=false;storageError.value=e instanceof Error?e.message:'无法核对原操作记录。'}}finally{if(g===generation)busy.value=false}
 }
 function reset(){generation++;read++;busy.value=false;ready.value=false;revoked.value=false;pending.value=null;receiptMissing.value=false;confirmRetry.value=false;error.value='';storageError.value='';origin=getRelayOrigin();owner=actor();taskId=task();scope=deliveryCacheScope(owner,origin);void refresh()}
 watch([task,actor,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 function changed(info:{scope?:string;task?:string}){if(info.scope===scope&&info.task===taskId)void refresh()}
 function local(e:Event){changed((e as CustomEvent).detail??{})}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')revoke();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==owner)revoke()}catch{revoke()}}}
 function connectivity(){receiptMissing.value=false;confirmRetry.value=false;if(navigator.onLine)void refresh()}
 onMounted(()=>{window.addEventListener('team-delivery-operation-changed',local);window.addEventListener('storage',storage);window.addEventListener('offline',connectivity);window.addEventListener('online',connectivity);if(typeof BroadcastChannel!=='undefined'){channel=new BroadcastChannel('pocketctl-delivery-operations');channel.onmessage=e=>changed(e.data??{})}})
 onBeforeUnmount(()=>{disposed=true;generation++;read++;channel?.close();journal.close();window.removeEventListener('team-delivery-operation-changed',local);window.removeEventListener('storage',storage);window.removeEventListener('offline',connectivity);window.removeEventListener('online',connectivity)})
 return {pending,busy,ready,blocked,receiptMissing,confirmRetry,error,storageError,revoked,refresh,submit,resolve,retry,revoke}
}
