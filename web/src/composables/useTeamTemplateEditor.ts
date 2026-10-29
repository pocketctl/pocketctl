import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from './useAuth'
import {getRelayOrigin} from './useEnv'
import {deliveryCacheScope} from '../services/teamDeliveryCache'
import {TeamApiError} from '../services/teamClient'
import {findTemplateSave,getTeamTemplate,listTeamTemplates,saveTeamTemplate} from '../services/teamTemplateClient'
import {teamTemplateSaveJournal} from '../services/teamTemplateSaveJournal'
import {validTemplateVersion,type TeamTemplate,type TemplateList} from '../types/teamTemplate'
import {blankTemplate,matchesSavedTemplate,matchesTemplateSaveReceipt,templateCanonical,validTemplateSave,type TemplateSaveOperation,type TemplateSaveResult} from '../types/teamTemplateEditing'
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v))
export function useTeamTemplateEditor(props:{teamId:string;currentUserId:number}) {
 const auth=useAuth(),page=ref<TemplateList|null>(null),definition=ref<TeamTemplate>(blankTemplate()),templateId=ref(''),revision=ref(0)
 const pending=ref<TemplateSaveOperation|null>(null),confirmation=ref<TemplateSaveOperation|null>(null),retryConfirm=ref(false),missing=ref(false)
 const loading=ref(false),busy=ref(false),ready=ref(false),revoked=ref(false),online=ref(navigator.onLine),error=ref(''),notice=ref('')
 let generation=0,disposed=false,team='',actor=0,origin='',scope=''
 const same=()=>!disposed&&team===props.teamId&&actor===props.currentUserId&&auth.user.value?.id===actor&&origin===getRelayOrigin()
 const current=(g:number)=>same()&&generation===g
 const identity=(g=generation)=>({userId:actor,origin,isCurrent:()=>current(g)&&online.value&&!revoked.value})
 const locked=computed(()=>busy.value||loading.value||!!pending.value||!ready.value||!online.value||revoked.value)
 const canEdit=computed(()=>!locked.value&&page.value?.can_manage===true&&page.value.writes_enabled)
 const candidate=(request='validation'):TemplateSaveOperation=>({team,template:templateId.value,actor,input:{request_id:request,expected_revision:revision.value,definition:{...clone(definition.value),steps:definition.value.steps.map(s=>({...clone(s),required_checks:s.required_checks.map(c=>c.trim()).filter(Boolean)}))}}})
 const canSave=computed(()=>canEdit.value&&validTemplateSave(candidate())&&(revision.value===0||page.value?.items.find(i=>i.template_id===templateId.value)?.revision===revision.value))
 function clear(){generation++;page.value=null;definition.value=blankTemplate();templateId.value='';revision.value=0;pending.value=null;confirmation.value=null;retryConfirm.value=false;missing.value=false;ready.value=false;busy.value=false;loading.value=false;notice.value=''}
 function revoke(){clear();revoked.value=true;error.value='账号或团队访问权限已变化，请重新打开。'}
 const denied=(e:unknown)=>e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')
 function fail(e:unknown){if(denied(e))revoke();else error.value=e instanceof Error?e.message:'读取失败，请重试。'}
 function restore(op:TemplateSaveOperation){pending.value=clone(op);templateId.value=op.template;revision.value=op.input.expected_revision;definition.value=clone(op.input.definition)}
 async function load(more=false){
  if(!same()||busy.value||loading.value||!online.value||revoked.value)return
  const g=generation;loading.value=true;confirmation.value=null;error.value='';ready.value=false
  try{
   const op=await teamTemplateSaveJournal.load(scope,team);if(!current(g))return
   if(op&&(op.team!==team||op.actor!==actor))throw Error('原模板保存身份不匹配，请保留记录核对。')
   const result=await listTeamTemplates(team,more?page.value?.next_cursor??undefined:undefined,identity(g));if(!current(g))return
   if(result.team_id!==team||!Array.isArray(result.items)||result.items.some(i=>!i.template_id||!Number.isSafeInteger(i.revision)||i.revision<1||i.revision>100))throw Error('模板目录身份或版本不匹配。')
   if(more&&page.value)result.items=[...page.value.items,...result.items.filter(i=>!page.value!.items.some(p=>p.template_id===i.template_id))]
   page.value=result;if(op)restore(op);else pending.value=null;ready.value=true
  }catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function create(){if(!canEdit.value)return;definition.value=blankTemplate();templateId.value=`tpl_${crypto.randomUUID()}`;revision.value=0;confirmation.value=null;notice.value='';error.value=''}
 async function edit(id:string,version:number){
  if(!canEdit.value)return;const g=generation;loading.value=true;confirmation.value=null;notice.value='';error.value=''
  try{const t=await getTeamTemplate(team,id,version,identity(g));if(!current(g))return;if(!validTemplateVersion(t)||t.team_id!==team||t.template_id!==id||t.revision!==version)throw Error('模板版本不匹配。');definition.value=clone(t.definition);templateId.value=id;revision.value=version}
  catch(e){if(current(g))fail(e)}finally{if(g===generation)loading.value=false}
 }
 function prepare(){if(canSave.value)confirmation.value=clone(candidate(crypto.randomUUID()))}
 async function finish(op:TemplateSaveOperation,result:TemplateSaveResult,g:number,recordScope:string){
  if(!result||result.team_id!==team||result.template_id!==op.template||result.revision!==op.input.expected_revision+1)throw Error('保存回执不匹配，原请求已保留。')
  const version=await getTeamTemplate(team,op.template,result.revision,identity(g));if(!current(g))return
  if(!matchesSavedTemplate(op,result,version))throw Error('保存内容与原请求不匹配，原请求已保留。')
  await teamTemplateSaveJournal.remove(recordScope,op);if(!current(g))return
  pending.value=null;missing.value=false;retryConfirm.value=false;revision.value=version.revision;definition.value=clone(version.definition)
  if(page.value)page.value.items=[{template_id:version.template_id,revision:version.revision,name:version.definition.name,content_hash:version.content_hash},...page.value.items.filter(i=>i.template_id!==version.template_id)]
  notice.value=`已保存模板 v${version.revision}。旧版本和已有任务保持不变。`;ready.value=true
 }
 async function send(op:TemplateSaveOperation,g:number,recordScope:string,first=false){
  missing.value=false;confirmation.value=null;retryConfirm.value=false
  let postSucceeded=false
  try{const result=await saveTeamTemplate(team,op.template,op.input,identity(g));postSucceeded=true;if(current(g))await finish(op,result,g,recordScope)}
  catch(e){if(!current(g))return;if(denied(e)){revoke();return}
   if(first&&!postSucceeded&&e instanceof TeamApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)&&!['idempotency_conflict','request_identity_changed'].includes(e.code)){
    await teamTemplateSaveJournal.remove(recordScope,op);if(!current(g))return;pending.value=null;ready.value=false;error.value='模板版本或权限已变化，请重新读取目录和最新版本后核对。'
   }else error.value='保存结果尚未确认，请查询原保存结果。'
  }
 }
 async function save(){
  const op=confirmation.value;if(!op||!canSave.value||templateCanonical(candidate(op.input.request_id))!==templateCanonical(op))return
  const g=generation,recordScope=scope;busy.value=true;notice.value='';error.value=''
  try{await teamTemplateSaveJournal.reserve(recordScope,op);if(!current(g))return;restore(op);await send(op,g,recordScope,true)}catch(e){if(current(g)){ready.value=false;error.value=e instanceof Error?e.message:'无法持久保存原请求。'}}finally{if(g===generation)busy.value=false}
 }
 async function resolve(){
  if(!same()||!ready.value||busy.value||loading.value||!online.value||revoked.value||!pending.value)return
  const op=clone(pending.value),g=generation,recordScope=scope;busy.value=true;missing.value=false;error.value=''
  try{const receipt=await findTemplateSave(team,op.template,op.input.request_id,identity(g));if(!current(g))return;if(!matchesTemplateSaveReceipt(op,receipt))throw Error('原保存回执不匹配。');if(receipt.found)await finish(op,receipt.response!,g,recordScope);else missing.value=true}
  catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 async function retry(){
  if(!retryConfirm.value||!missing.value||!ready.value||!same()||busy.value||loading.value||!online.value||revoked.value||!pending.value||!page.value?.can_manage)return
  const g=generation,op=clone(pending.value),recordScope=scope;busy.value=true;error.value=''
  try{await send(op,g,recordScope)}catch(e){if(current(g))fail(e)}finally{if(g===generation)busy.value=false}
 }
 function reset(){clear();revoked.value=false;error.value='';team=props.teamId;actor=props.currentUserId;origin=getRelayOrigin();scope=deliveryCacheScope(actor,origin);void load()}
 watch([()=>props.teamId,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],reset,{immediate:true,flush:'sync'})
 watch([definition,templateId,revision],()=>{confirmation.value=null},{deep:true,flush:'sync'})
 function connectivity(){online.value=navigator.onLine;confirmation.value=null;retryConfirm.value=false;if(!online.value){generation++;loading.value=false;busy.value=false;ready.value=false;page.value=null;definition.value=blankTemplate();pending.value=null}else void load()}
 function invalidated(e:Event){const d=(e as CustomEvent).detail;if(d?.filesOnly||d?.task||d?.session)return;if((!d?.scope||d.scope===scope)&&(!d?.team||d.team===team))revoke()}
 function storage(e:StorageEvent){if(e.key==='pocketctl_relay_url')reset();if(e.key==='pocketctl_user'){try{if(JSON.parse(e.newValue??'null')?.id!==actor)revoke()}catch{revoke()}}}
 onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);window.addEventListener('team-delivery-cache-revoked',invalidated);window.addEventListener('storage',storage)})
 onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);window.removeEventListener('team-delivery-cache-revoked',invalidated);window.removeEventListener('storage',storage)})
 return {page,definition,templateId,revision,pending,confirmation,retryConfirm,missing,loading,busy,ready,revoked,online,error,notice,locked,canEdit,canSave,load,create,edit,prepare,save,resolve,retry}
}
