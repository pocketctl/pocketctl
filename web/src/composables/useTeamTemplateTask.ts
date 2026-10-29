import {computed,onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue'
import {useAuth} from './useAuth'
import {getRelayOrigin} from './useEnv'
import {deliveryCacheScope} from '../services/teamDeliveryCache'
import {teamTaskAssignmentJournal} from '../services/teamTaskAssignmentJournal'
import {getTeamSession,listTeamMembers,TeamApiError} from '../services/teamClient'
import {createTemplateTask,findTemplateTask,getTeamTemplate,listTeamTemplates} from '../services/teamTemplateClient'
import {validTemplateVersion,validTemplateTask,matchingTemplateTask,validTemplateReceipt,type TemplateTaskOperation,type TemplateTaskResult,type TemplateVersion,type TemplateList} from '../types/teamTemplate'
import type {TeamSession,TeamMember} from '../types/team'
export function useTeamTemplateTask(props:{session:TeamSession;currentUserId?:number},complete:(task:string)=>void){
 const roleMap=()=>Object.create(null) as Record<string,string|number>
 const auth=useAuth(),list=ref<TemplateList|null>(null),selected=ref<TemplateVersion|null>(null),templateId=ref(''),revision=ref(1),goal=ref(''),acceptance=ref(''),roles=shallowRef<Record<string,string|number>>(roleMap())
 const session=ref<TeamSession|null>(null),members=ref<TeamMember[]>([]),pending=ref<TemplateTaskOperation|null>(null),otherPending=ref(false)
 const busy=ref(false),loading=ref(false),verified=ref(false),journalReady=ref(false),online=ref(navigator.onLine),revoked=ref(false),error=ref(''),missing=ref(false),confirm=ref(false),confirmRetry=ref(false)
 let actor=0,origin='',scope='',team='',sessionId='',generation=0,disposed=false
 const same=()=>!disposed&&props.currentUserId===actor&&auth.user.value?.id===actor&&getRelayOrigin()===origin&&props.session.team_id===team&&props.session.id===sessionId
 const current=(g:number)=>same()&&g===generation
 const identity=(g=generation)=>({userId:actor,origin,isCurrent:()=>current(g)})
 const bindings=computed(()=>session.value?.agent_bindings.filter(b=>b.state==='active')??[])
 const reviewers=computed(()=>members.value.filter(m=>m.state==='active'&&m.role!=='viewer'))
 const locked=computed(()=>busy.value||loading.value||!!pending.value||otherPending.value||!verified.value||!journalReady.value||revoked.value||!online.value)
 const disabledReason=computed(()=>{
  if(!same()||revoked.value)return '账号或访问权限已变化，请重新打开会话。'
  if(otherPending.value)return '此会话有未确认分派，请返回分派页面查询原结果。'
  if(pending.value)return '请先查询原创建结果，避免重复创建任务。'
  if(locked.value)return '请联网重新读取模板与会话设置。'
  if(!list.value?.can_create||!list.value.writes_enabled||session.value?.state!=='active'||session.value.current_user_role==='viewer')return '当前会话未开放从模板创建草稿。'
  const t=selected.value
  if(!t||t.template_id!==templateId.value||t.revision!==revision.value)return '请选择模板并读取明确版本。'
  if(!goal.value.trim()||goal.value.length>32000||!acceptance.value.trim()||acceptance.value.length>16000)return '请填写任务说明与验收要求。'
  for(const r of t.definition.roles){const v=roles.value[r.role_id];if(r.kind==='agent'?!bindings.value.some(b=>b.offer_id===v&&b.availability==='online'):!reviewers.value.some(m=>m.user_id===v))return '请为全部角色明确选择当前在线 Agent 或有权限的验收人。'}
  return ''
 })
 function revoke(){generation++;revoked.value=true;verified.value=false;loading.value=false;busy.value=false;list.value=null;selected.value=null;session.value=null;members.value=[];pending.value=null;roles.value=roleMap();goal.value='';acceptance.value='';templateId.value='';missing.value=false;confirm.value=false;confirmRetry.value=false;error.value='访问身份已变化，原请求已保留，请重新打开会话。'}
 const denied=(e:unknown)=>e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')
 function fail(e:unknown){if(!same()||denied(e)){revoke();return}verified.value=false;error.value=e instanceof Error?e.message:'无法核对模板，请重新读取。'}
 function restore(op:TemplateTaskOperation){pending.value=op;selected.value=op.template;templateId.value=op.input.template_id;revision.value=op.input.template_revision;goal.value=op.input.goal;acceptance.value=op.input.acceptance;roles.value=Object.assign(roleMap(),op.input.role_bindings)}
 async function load(more=false){
  if(!same()){revoke();return}if(busy.value||loading.value||revoked.value||!online.value)return
  const cursor=more?list.value?.next_cursor:undefined;if(more&&!cursor)return
  const g=++generation;loading.value=true;verified.value=false;error.value='';missing.value=false;confirm.value=false;confirmRetry.value=false
  try{
   journalReady.value=false
   const saved=await teamTaskAssignmentJournal.loadCreation(scope,sessionId);if(!current(g))return
   if(saved&&(saved.team!==team||saved.actor!==actor))throw Error('原创建记录身份不匹配。')
   otherPending.value=!!saved&&!('kind' in saved);if(saved&&'kind' in saved)restore(saved);else pending.value=null
   journalReady.value=true
   const latest=await getTeamSession(sessionId);if(!current(g))return
   if(latest.id!==sessionId||latest.team_id!==team)throw Error('会话身份不匹配。')
   const people=await listTeamMembers(team);if(!current(g))return
   const page=await listTeamTemplates(team,cursor??undefined,identity());if(!current(g))return
   if(page.team_id!==team||!Array.isArray(page.items)||page.items.length>50||typeof page.can_create!=='boolean'||typeof page.writes_enabled!=='boolean'||(page.next_cursor!==null&&(typeof page.next_cursor!=='string'||!page.next_cursor||page.next_cursor===cursor))||page.items.some(t=>typeof t.template_id!=='string'||!t.template_id||!Number.isSafeInteger(t.revision)||t.revision<1||t.revision>100||typeof t.name!=='string'))throw Error('模板列表格式不匹配。')
   if(more&&list.value)page.items=[...list.value.items,...page.items.filter(t=>!list.value!.items.some(p=>p.template_id===t.template_id))]
   list.value=page;session.value=latest;members.value=people;verified.value=true
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function setRole(id:string,value:string|number){if(locked.value||confirm.value)return;const next=Object.assign(roleMap(),roles.value);if(value==='')delete next[id];else next[id]=value;roles.value=next}
 async function select(){
  if(locked.value||!templateId.value)return
  const id=templateId.value,rev=revision.value,g=generation;loading.value=true;confirm.value=false;error.value=''
  try{const t=await getTeamTemplate(team,id,rev,identity());if(!current(g))return;if(!validTemplateVersion(t)||t.team_id!==team||t.template_id!==id||t.revision!==rev)throw Error('模板版本不匹配。');selected.value=t;roles.value=roleMap();goal.value=t.definition.goal;acceptance.value=t.definition.acceptance}
  catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 async function finish(op:TemplateTaskOperation,result:TemplateTaskResult,g:number,opScope:string){
  if(!matchingTemplateTask(op,result))throw Error('草稿回执不匹配，原请求已保留。')
  await teamTaskAssignmentJournal.remove(opScope,op);if(!current(g))return
  pending.value=null;missing.value=false;complete(result.task_id)
 }
 async function send(op:TemplateTaskOperation,g:number,opScope:string,first=false){
  missing.value=false;confirm.value=false;confirmRetry.value=false
  try{const result=await createTemplateTask(op.team,op.input,identity());if(!current(g))return;await finish(op,result,g,opScope)}
  catch(e){if(!current(g))return;if(denied(e)){revoke();return}
   // Only a first request's authoritative non-retryable rejection can release its reservation.
   if(first&&e instanceof TeamApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)&&!['idempotency_conflict','request_identity_changed'].includes(e.code)){
    await teamTaskAssignmentJournal.remove(opScope,op);if(!current(g))return;pending.value=null;verified.value=false;error.value='模板、角色或共享材料已变化，请重新读取并核对。'
   }else{verified.value=false;error.value='创建结果尚未确认，请查询原创建结果。'}
  }
 }
 async function submit(){
  if(!confirm.value||disabledReason.value||!selected.value||!session.value)return
  const op:TemplateTaskOperation=JSON.parse(JSON.stringify({kind:'template_task',team,session:sessionId,actor,template:selected.value,input:{request_id:crypto.randomUUID(),template_id:selected.value.template_id,template_revision:selected.value.revision,team_session_id:sessionId,context_version:session.value.current_context_version,role_bindings:{...roles.value},goal:goal.value.trim(),acceptance:acceptance.value.trim()}}))
  if(!validTemplateTask(op)){error.value='模板内容、角色或请求大小不符合要求。';confirm.value=false;return}
  busy.value=true;const g=generation,opScope=scope
  try{await teamTaskAssignmentJournal.reserve(opScope,op);if(!current(g))return;restore(op);await send(op,g,opScope,true)}catch(e){if(current(g)){journalReady.value=false;error.value=e instanceof Error?e.message:'无法保存原请求。'}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(!same()||busy.value||loading.value||!online.value||revoked.value||!pending.value)return
  busy.value=true;missing.value=false;confirmRetry.value=false;error.value='';const g=generation,opScope=scope,op=JSON.parse(JSON.stringify(pending.value)) as TemplateTaskOperation
  try{const r=await findTemplateTask(team,op.input.request_id,identity());if(!current(g))return;if(!validTemplateReceipt(op,r))throw Error('原创建回执不匹配。');if(r.found)await finish(op,r.response!,g,opScope);else missing.value=true}
  catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 async function retry(){
  if(!confirmRetry.value||!missing.value||!same()||busy.value||loading.value||!online.value||revoked.value||!pending.value)return
  busy.value=true;const g=generation,opScope=scope,op=JSON.parse(JSON.stringify(pending.value)) as TemplateTaskOperation
  try{await send(op,g,opScope)}catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 function reset(){generation++;busy.value=false;loading.value=false;revoked.value=false;verified.value=false;journalReady.value=false;list.value=null;selected.value=null;session.value=null;members.value=[];pending.value=null;otherPending.value=false;goal.value='';acceptance.value='';roles.value=roleMap();templateId.value='';revision.value=1;missing.value=false;confirm.value=false;confirmRetry.value=false;actor=props.currentUserId??0;origin=getRelayOrigin();scope=deliveryCacheScope(actor,origin);team=props.session.team_id;sessionId=props.session.id;void load()}
 watch([()=>props.session.id,()=>props.session.team_id,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 watch([templateId,revision,goal,acceptance,roles],()=>{confirm.value=false},{deep:true,flush:'sync'})
 function connectivity(){online.value=navigator.onLine;confirm.value=false;confirmRetry.value=false;if(!online.value)verified.value=false;else void load()}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')reset();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==actor)revoke()}catch{revoke()}}}
 function invalidated(e:Event){const v=(e as CustomEvent).detail;if(v?.filesOnly||v?.task)return;if((!v?.scope||v.scope===scope)&&(!v?.team||v.team===team)&&(!v?.session||v.session===sessionId))revoke()}
 onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);window.addEventListener('storage',storage);window.addEventListener('team-delivery-cache-revoked',invalidated)})
 onBeforeUnmount(()=>{disposed=true;generation++;window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);window.removeEventListener('storage',storage);window.removeEventListener('team-delivery-cache-revoked',invalidated)})
 return {list,selected,templateId,revision,goal,acceptance,roles,session,pending,otherPending,busy,loading,online,revoked,error,missing,confirm,confirmRetry,bindings,reviewers,locked,disabledReason,load,select,setRole,submit,resolve,retry}
}
