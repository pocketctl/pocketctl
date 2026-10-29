import {validTemplateTask,type TemplateTaskOperation} from '../types/teamTemplate'
import type { ReviewPolicy } from '../types/teamDelivery'
import type { TeamEvent } from '../types/team'
export type TaskAssignmentInput={request_id:string;instruction:string;acceptance:string;target_offer_ids:string[];context_version:number;review_policy?:ReviewPolicy}
export type TaskAssignment={team:string;session:string;actor:number;input:TaskAssignmentInput}
export type TaskAssignmentResult={task_id:string;event:TeamEvent;call_ids:string[]}
export type TaskAssignmentReceipt={operation:'assign_task';request_id:string;team_session_id:string;found:boolean;response:TaskAssignmentResult|null}
export function validTaskAssignment(value:unknown):value is TaskAssignment {
 const op=value as TaskAssignment,i=op?.input,p=i?.review_policy
 const text=(s:unknown,max:number)=>typeof s==='string'&&!!s.trim()&&s.length<=max
 return !!op&&typeof op==='object'&&!('kind' in op)&&text(op.team,256)&&text(op.session,256)&&Number.isSafeInteger(op.actor)&&op.actor>0&&!!i&&text(i.request_id,128)
  &&text(i.instruction,32000)&&text(i.acceptance,16000)&&Number.isSafeInteger(i.context_version)&&i.context_version>=0
  &&Array.isArray(i.target_offer_ids)&&i.target_offer_ids.length>0&&i.target_offer_ids.length<=16&&i.target_offer_ids.every(id=>text(id,128))&&new Set(i.target_offer_ids).size===i.target_offer_ids.length
  &&(p===undefined||!!p&&Number.isSafeInteger(p.reviewer_user_id)&&p.reviewer_user_id>0&&i.target_offer_ids.includes(p.primary_offer_id)&&Array.isArray(p.required_checks)&&p.required_checks.length<=32&&p.required_checks.every(c=>text(c,120))&&new Set(p.required_checks).size===p.required_checks.length)
}
export function matchingTaskAssignment(op:TaskAssignment,result:TaskAssignmentResult):boolean {
 const e=result?.event,i=op.input,ids=i.target_offer_ids
 return typeof result?.task_id==='string'&&!!result.task_id&&!!e&&typeof e.id==='string'&&!!e.id&&e.team_session_id===op.session&&e.author_user_id===op.actor
  &&e.content===i.instruction+'\n\n交付与验收：\n'+i.acceptance&&e.context_version===i.context_version&&Array.isArray(e.target_offer_ids)&&e.target_offer_ids.length===ids.length&&new Set(e.target_offer_ids).size===ids.length&&e.target_offer_ids.every(id=>ids.includes(id))
  &&Array.isArray(result.call_ids)&&result.call_ids.length===ids.length&&new Set(result.call_ids).size===ids.length&&result.call_ids.every(id=>typeof id==='string'&&!!id)
}
export type TaskCreationOperation=TaskAssignment|TemplateTaskOperation
const validCreation=(v:unknown):v is TaskCreationOperation=>validTaskAssignment(v)||validTemplateTask(v)
type RecordRow={key:string;scope:string;session:string;schema:1;payload:string;hash:string}
const invalid=()=>new Error('原分派记录损坏或不匹配，请保留记录并核对任务。')
const occupied=()=>new Error('此会话已有未确认分派，请重新读取原请求。')
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('')
/** Durable intents are separate from evictable read caches. Never expire unknown calls. */
export class TeamTaskAssignmentJournal {
 private db?:Promise<IDBDatabase>
 private open(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('无法保存原分派，请恢复浏览器存储后重试。'))
  return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{
   const r=indexedDB.open('pocketctl-team-task-assignments-v1',1)
   r.onupgradeneeded=()=>r.result.createObjectStore('intents',{keyPath:'key'})
   r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.db=undefined};resolve(r.result)}
   r.onerror=()=>{this.db=undefined;reject(r.error)}
  })
 }
 private key(scope:string,session:string){return JSON.stringify([scope,session])}
 async load(scope:string,session:string):Promise<TaskAssignment|null>{
  const op=await this.loadCreation(scope,session)
  if(op&&'kind' in op)throw new Error('此会话有未确认的模板创建，请打开“从协作模板创建草稿”查询原结果。')
  return op
 }
 async loadCreation(scope:string,session:string):Promise<TaskCreationOperation|null>{
  const db=await this.open(),key=this.key(scope,session)
  const row=await new Promise<RecordRow|undefined>((resolve,reject)=>{const tx=db.transaction('intents','readonly'),r=tx.objectStore('intents').get(key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})
  if(!row)return null
  if(row.schema!==1||row.key!==key||row.scope!==scope||row.session!==session||typeof row.payload!=='string'||row.payload.length>512*1024||await hash(row.payload)!==row.hash)throw invalid()
  const op=JSON.parse(row.payload);if(!validCreation(op)||op.session!==session)throw invalid();return op
 }
 async reserve(scope:string,op:TaskCreationOperation){
  if(!validCreation(op))throw invalid()
  const payload=JSON.stringify(op),digest=await hash(payload),key=this.key(scope,op.session)
  if(payload.length>512*1024)throw invalid()
  const db=await this.open()
  await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{
    const prior=get.result as RecordRow|undefined
    if(prior){if(prior.schema!==1||prior.scope!==scope||prior.session!==op.session||prior.payload!==payload||prior.hash!==digest){failure=occupied();tx.abort()};return}
    // Bound growth without ever evicting another unresolved operation.
    const all=store.getAll();all.onsuccess=()=>{const rows=all.result as RecordRow[];if(rows.length>=512||rows.reduce((n,r)=>n+(typeof r.payload==='string'?r.payload.length*2:1024*1024),0)+payload.length*2>64*1024*1024){failure=new Error('未确认分派记录已达存储上限，请先核对原请求。');tx.abort();return};store.add({key,scope,session:op.session,schema:1,payload,hash:digest} satisfies RecordRow)}
   }
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
 async remove(scope:string,op:TaskCreationOperation){
  const payload=JSON.stringify(op),digest=await hash(payload),db=await this.open(),key=this.key(scope,op.session)
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{const row=get.result as RecordRow|undefined;if(!row)return;if(row.scope!==scope||row.session!==op.session||row.payload!==payload||row.hash!==digest){failure=occupied();tx.abort();return};store.delete(key)}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
}
export const teamTaskAssignmentJournal=new TeamTaskAssignmentJournal()
