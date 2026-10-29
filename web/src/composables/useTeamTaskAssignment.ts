import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from './useAuth'
import {getRelayOrigin} from './useEnv'
import {deliveryCacheScope} from '../services/teamDeliveryCache'
import {assignTeamTask,findTeamTaskAssignment,getTeamCapabilities,getTeamSession,listTeamMembers,TeamApiError} from '../services/teamClient'
import {getDeliveryCapabilities} from '../services/teamDeliveryClient'
import {matchingTaskAssignment,teamTaskAssignmentJournal,validTaskAssignment,type TaskAssignment,type TaskAssignmentResult} from '../services/teamTaskAssignmentJournal'
import type {TeamMember,TeamSession} from '../types/team'
export function useTeamTaskAssignment(props:{session:TeamSession;currentUserId?:number},complete:(result:TaskAssignmentResult)=>void){
 const auth=useAuth(),instruction=ref(''),acceptance=ref(''),targets=ref<string[]>([]),reviewRequired=ref(false),reviewer=ref(0),primary=ref(''),checks=ref('')
 const busy=ref(false),loading=ref(false),error=ref(''),journalError=ref(''),journalReady=ref(false),verified=ref(false),revoked=ref(false),online=ref(navigator.onLine)
 const session=ref<TeamSession|null>(null),members=ref<TeamMember[]>([]),deliveryEnabled=ref(false),writesEnabled=ref(false),pending=ref<TaskAssignment|null>(null),receiptMissing=ref(false),confirmRetry=ref(false)
 let generation=0,initialized=false,scope='',origin='',actor=0,sessionId='',teamId='',disposed=false
 const same=()=>!disposed&&props.currentUserId===actor&&auth.user.value?.id===actor&&getRelayOrigin()===origin&&props.session.id===sessionId&&props.session.team_id===teamId
 const current=(g:number)=>g===generation&&same()
 const checkList=computed(()=>[...new Set(checks.value.split('\n').map(s=>s.trim()).filter(Boolean))])
 const bindings=computed(()=>session.value?.agent_bindings.filter(b=>b.state==='active')||[])
 const reviewers=computed(()=>members.value.filter(m=>m.state==='active'&&m.role!=='viewer'))
 const locked=computed(()=>busy.value||!!pending.value||!verified.value||revoked.value||confirmRetry.value)
 const disabledReason=computed(()=>{
  if(!same()||revoked.value)return '账号或访问权限已变化，请重新打开会话。'
  if(busy.value)return '正在处理原请求，请稍候。'
  if(pending.value)return '请先核对原分派结果，避免重复创建任务。'
  if(!journalReady.value)return '操作记录尚未就绪，请重新读取。'
  if(loading.value||!verified.value||!online.value)return '请连接后重新读取分派设置。'
  if(!writesEnabled.value||session.value?.state!=='active'||session.value.current_user_role==='viewer')return '当前会话不可分派任务。'
  if(!instruction.value.trim()||instruction.value.length>32000||!acceptance.value.trim()||acceptance.value.length>16000)return '请填写任务说明和验收要求。'
  if(!targets.value.length||targets.value.length>16||targets.value.some(id=>!bindings.value.some(b=>b.offer_id===id&&b.availability==='online')))return '请选择 1 至 16 个在线 Agent。'
  if(reviewRequired.value&&(!deliveryEnabled.value||!reviewers.value.some(m=>m.user_id===reviewer.value)||!targets.value.includes(primary.value)||checkList.value.length>32||checkList.value.some(c=>c.length>120)))return '请检查验收能力、验收人、主交付 Agent 和必需检查项。'
  return ''
 })
 function clearDraft(){instruction.value='';acceptance.value='';targets.value=[];reviewer.value=0;primary.value='';checks.value='';reviewRequired.value=false}
 function revoke(){generation++;revoked.value=true;verified.value=false;busy.value=false;loading.value=false;session.value=null;members.value=[];pending.value=null;receiptMissing.value=false;confirmRetry.value=false;clearDraft();error.value='账号或访问权限已变化，原请求已保留，请重新打开会话。'}
 const denial=(e:unknown)=>e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')
 function fail(e:unknown){if(!same()||denial(e)){revoke();return};verified.value=false;error.value=e instanceof Error?e.message:'暂时无法核对分派，请重试。'}
 function restore(op:TaskAssignment){pending.value=op;const i=op.input;instruction.value=i.instruction;acceptance.value=i.acceptance;targets.value=[...i.target_offer_ids];reviewRequired.value=!!i.review_policy;reviewer.value=i.review_policy?.reviewer_user_id??actor;primary.value=i.review_policy?.primary_offer_id??'';checks.value=i.review_policy?.required_checks.join('\n')??'';initialized=true}
 async function load(){
  if(!same()){revoke();return};if(loading.value||busy.value||revoked.value)return
  const g=++generation;loading.value=true;verified.value=false;error.value='';confirmRetry.value=false;receiptMissing.value=false
  try{
   try{const saved=await teamTaskAssignmentJournal.load(scope,sessionId);if(!current(g))return;if(saved){if(saved.team!==teamId||saved.actor!==actor)throw new Error('原请求的账号或团队不匹配。');restore(saved)}else pending.value=null;journalReady.value=true;journalError.value=''}catch(e){if(!current(g))return;journalReady.value=false;journalError.value=e instanceof Error?e.message:'无法读取原请求'}
   const latest=await getTeamSession(sessionId);if(!current(g))return
   if(latest.id!==sessionId||latest.team_id!==teamId)throw new Error('会话身份不匹配，请重新打开。')
   const people=await listTeamMembers(teamId);if(!current(g))return
   const features=await getTeamCapabilities();if(!current(g))return
   let capability=false
   try{capability=(await getDeliveryCapabilities(teamId)).writes_enabled}catch(e){if(!(e instanceof TeamApiError&&e.status===404&&e.code!=='team_not_found'))throw e}
   if(!current(g))return
   session.value=latest;members.value=people;deliveryEnabled.value=capability;writesEnabled.value=features.writes_enabled;verified.value=true
   if(!initialized){initialized=true;reviewRequired.value=capability;reviewer.value=actor}
  }catch(e){if(g===generation)fail(e)}finally{if(g===generation)loading.value=false}
 }
 async function finish(op:TaskAssignment,result:TaskAssignmentResult,g:number,opScope:string){
  if(!matchingTaskAssignment(op,result))throw new Error('分派回执不匹配，请保留原请求并核对。')
  await teamTaskAssignmentJournal.remove(opScope,op);if(!current(g))return
  pending.value=null;receiptMissing.value=false;complete(result)
 }
 async function send(op:TaskAssignment,g:number,opScope:string,first=false){
  error.value='';receiptMissing.value=false;confirmRetry.value=false
  try{const result=await assignTeamTask(op.session,op.input,{userId:op.actor,origin});if(!current(g))return;await finish(op,result,g,opScope)}
  catch(e){
   if(!current(g))return
   if(denial(e)){revoke();return}
   if(first&&e instanceof TeamApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)&&!['idempotency_conflict','request_identity_changed'].includes(e.code)){
    try{await teamTaskAssignmentJournal.remove(opScope,op);if(!current(g))return;pending.value=null}catch(storage){if(!current(g))return;journalReady.value=false;journalError.value=storage instanceof Error?storage.message:'无法更新原请求'}
    busy.value=false;await load();if(same())error.value=e.status===409?'任务材料或设置已变化，请重新核对后分派。':e.message
   }else{verified.value=false;error.value='分派结果尚未确认，请查询原请求。'}
  }
 }
 async function submit(){
  if(disabledReason.value||!session.value)return
  const op:TaskAssignment={team:teamId,session:sessionId,actor,input:{request_id:crypto.randomUUID(),instruction:instruction.value.trim(),acceptance:acceptance.value.trim(),target_offer_ids:[...targets.value].sort(),context_version:session.value.current_context_version,...(reviewRequired.value?{review_policy:{reviewer_user_id:reviewer.value,primary_offer_id:primary.value,required_checks:[...checkList.value]}}:{})}}
  if(!validTaskAssignment(op))return
  busy.value=true;const g=generation,opScope=scope
  try{await teamTaskAssignmentJournal.reserve(opScope,op);if(!current(g))return;restore(op);await send(op,g,opScope,true)}catch(e){if(current(g)){journalReady.value=false;journalError.value=e instanceof Error?e.message:'无法保留原分派，请检查浏览器存储。'}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(busy.value||loading.value||!online.value||revoked.value||!same()||!pending.value)return
  busy.value=true;receiptMissing.value=false;confirmRetry.value=false;error.value='';const g=generation,op=JSON.parse(JSON.stringify(pending.value)) as TaskAssignment,opScope=scope
  try{const r=await findTeamTaskAssignment(op.session,op.input.request_id,{userId:op.actor,origin});if(!current(g))return
   if(r.operation!=='assign_task'||r.request_id!==op.input.request_id||r.team_session_id!==op.session||typeof r.found!=='boolean')throw new Error('原请求回执不匹配。')
   if(r.found){if(!r.response)throw new Error('缺少分派结果');await finish(op,r.response,g,opScope)}else{if(r.response!==null)throw new Error('回执不匹配');receiptMissing.value=true;error.value='未查到原请求，可使用相同内容和请求身份重试。'}
  }catch(e){if(current(g)){if(e instanceof TeamApiError&&e.status===404&&e.code!=='team_not_found')error.value='此 Relay 暂不支持查询分派回执，原请求已保留；升级后再核对。';else fail(e)}}finally{if(g===generation)busy.value=false}
 }
 async function retry(){if(!confirmRetry.value||!receiptMissing.value||busy.value||loading.value||!online.value||revoked.value||!same()||!pending.value)return;busy.value=true;const g=generation;await send(JSON.parse(JSON.stringify(pending.value)),g,scope);if(g===generation)busy.value=false}
 function reset(){generation++;busy.value=false;loading.value=false;revoked.value=false;verified.value=false;journalReady.value=false;pending.value=null;session.value=null;members.value=[];receiptMissing.value=false;confirmRetry.value=false;error.value='';journalError.value='';initialized=false;clearDraft();origin=getRelayOrigin();actor=props.currentUserId??0;teamId=props.session.team_id;sessionId=props.session.id;scope=deliveryCacheScope(actor,origin);void load()}
 // Polling replaces the session/user objects. Only identity changes reset drafts;
 // a getter returning a new array would reset on every ordinary session refresh.
 watch([()=>props.session.id,()=>props.session.team_id,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 watch(targets,ids=>{if(!pending.value&&!ids.includes(primary.value))primary.value=ids[0]||''})
 function connectivity(){online.value=navigator.onLine;confirmRetry.value=false;if(!online.value)verified.value=false;else void load()}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')reset();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==actor)revoke()}catch{revoke()}}}
 function invalidated(event:Event){const d=(event as CustomEvent).detail;if(d?.filesOnly||d?.task)return;if((!d?.scope||d.scope===scope)&&(!d?.team||d.team===teamId)&&(!d?.session||d.session===sessionId))revoke()}
 onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);window.addEventListener('storage',storage);window.addEventListener('team-delivery-cache-revoked',invalidated)})
 onBeforeUnmount(()=>{disposed=true;generation++;window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);window.removeEventListener('storage',storage);window.removeEventListener('team-delivery-cache-revoked',invalidated)})
 return {instruction,acceptance,targets,reviewRequired,reviewer,primary,checks,busy,loading,error,journalError,online,locked,revoked,pending,receiptMissing,confirmRetry,session,bindings,reviewers,deliveryEnabled,disabledReason,load,submit,resolve,retry}
}
