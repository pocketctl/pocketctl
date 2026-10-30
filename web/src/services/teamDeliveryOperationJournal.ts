import { validTaskBudget, validTaskPlanDraft, validNewVersionReason } from '../types/teamPlan'
import type { DeliveryPendingOperation } from './teamDeliveryRecovery'

export type DeliveryIntent = {task:string;actor:number;operation:DeliveryPendingOperation}
const invalid=()=>new Error('原操作记录损坏或不匹配，请保留记录并核对任务。')
const occupied=()=>new Error('此任务已有未确认操作，请重新读取原请求。')
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('')
const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max
const checks=(v:unknown)=>Array.isArray(v)&&v.length<=32&&v.every(s=>text(s,120))&&new Set(v).size===v.length
export function validDeliveryIntent(value:unknown):value is DeliveryIntent {
 const v=value as DeliveryIntent,op=v?.operation,i=op?.input
 if(!v||!text(v.task,128)||!Number.isSafeInteger(v.actor)||v.actor<1||!i||!text(i.request_id,128)||!Number.isSafeInteger(i.expected_revision)||i.expected_revision<(op.kind==='plan_draft'||op.kind==='plan_control'&&op.input.action==='activate'?0:1))return false
 if(op.kind==='plan_draft')return validTaskPlanDraft(op.input)
 if(op.kind==='plan_control'){
  const c=op.input, reconcile=['reconcile','retry','new_version'].includes(c.action)
  if(reconcile?!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(c.attempt_id||'')||!text(op.expectedCallId,128)||!['active','paused','cancelled'].includes(op.expectedState||''):c.attempt_id!==undefined||op.expectedState!==undefined||op.expectedCallId!==undefined)return false
  if(['retry','new_version'].includes(c.action)?op.expectedState!=='active'||!Number.isSafeInteger(c.expected_delivery_revision)||(c.expected_delivery_revision??0)<1:c.expected_delivery_revision!==undefined)return false
  if(c.action==='activate'?c.expected_revision!==0||!Number.isSafeInteger(c.invocation_limit)||(c.invocation_limit??0)<1||(c.invocation_limit??0)>128:c.invocation_limit!==undefined)return false
  if(c.action==='new_version'?!validNewVersionReason(c.reason):c.reason!==undefined)return false
  if(c.budget!==undefined&&(c.action!=='activate'||!validTaskBudget(c.budget)))return false
  return ['activate','adopt_revision','pause','resume','cancel','reconcile','retry','new_version'].includes(c.action)&&Number.isSafeInteger(c.plan_revision)&&c.plan_revision>0&&Object.keys(c).every(k=>['request_id','expected_revision','plan_revision','action','attempt_id','expected_delivery_revision','invocation_limit','budget','reason'].includes(k))
 }
 if(op.kind==='revoke_artifact')return text(op.submissionId,128)&&text(op.artifactId,128)&&text(op.input.reason,2000)&&(op.attemptId===undefined||/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(op.attemptId))
 if(op.kind==='acceptance'){if(op.attemptId!==undefined&&!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(op.attemptId))return false;const d=op.input;return text(d.submission_id,128)&&Number.isSafeInteger(d.spec_revision)&&d.spec_revision>0&&['accepted','changes_requested'].includes(d.decision)&&typeof d.reason==='string'&&d.reason.length<=16000&&(d.decision!=='changes_requested'||!!d.reason.trim())&&checks(d.verified_checks)}
 if(op.kind==='revise_spec'){const r=op.input,p=r.policy;return text(r.goal,32000)&&text(r.acceptance,16000)&&!!p&&Number.isSafeInteger(p.reviewer_user_id)&&p.reviewer_user_id>0&&text(p.primary_offer_id,128)&&checks(p.required_checks)&&(op.specRevision===undefined||Number.isSafeInteger(op.specRevision)&&op.specRevision>0)}
 if(op.kind==='execute_task'){const e=op.input;return (e.expected_task_revision===undefined||Number.isSafeInteger(e.expected_task_revision)&&e.expected_task_revision>0)&&text(op.session,128)&&Number.isSafeInteger(e.spec_revision)&&e.spec_revision>0&&Number.isSafeInteger(e.context_version)&&e.context_version>=0&&Array.isArray(e.target_offer_ids)&&e.target_offer_ids.length>0&&e.target_offer_ids.length<=16&&e.target_offer_ids.every(id=>text(id,128))&&new Set(e.target_offer_ids).size===e.target_offer_ids.length}
 return false
}
type Row={key:string;scope:string;task:string;schema:1;payload:string;hash:string}
/** All mutation kinds share one task slot. Legacy import may retain multiple
 * already-existing intents, but no new intent can displace an unresolved one. */
export class TeamDeliveryOperationJournal {
 private db?:Promise<IDBDatabase>
 private closed=false
 constructor(private name='pocketctl-team-delivery-operations-v1'){}
 close(){this.closed=true;void this.db?.then(db=>db.close(),()=>{});this.db=undefined}
 private open(){
  if(this.closed)return Promise.reject(new Error('操作记录已关闭，请重新打开任务。'))
  if(!globalThis.indexedDB)return Promise.reject(new Error('无法读取操作记录，请恢复浏览器存储后重试。'))
  return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(this.name,1);r.onupgradeneeded=()=>r.result.createObjectStore('intents',{keyPath:'key'});r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.db=undefined};resolve(r.result)};r.onerror=()=>{this.db=undefined;reject(r.error)}})
 }
 private key(scope:string,task:string){return JSON.stringify([scope,task])}
 private async row(scope:string,task:string){const db=await this.open();return new Promise<Row|undefined>((resolve,reject)=>{const tx=db.transaction('intents','readonly'),r=tx.objectStore('intents').get(this.key(scope,task));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}
 private async decode(row:Row|undefined,scope:string,task:string):Promise<DeliveryIntent[]>{
  if(!row)return []
  if(row.schema!==1||row.key!==this.key(scope,task)||row.scope!==scope||row.task!==task||typeof row.payload!=='string'||row.payload.length>512*1024||await hash(row.payload)!==row.hash)throw invalid()
  const entries=JSON.parse(row.payload)
  if(!Array.isArray(entries)||!entries.length||entries.length>2||entries.some(v=>!validDeliveryIntent(v)||v.task!==task)||new Set(entries.map(v=>v.operation.input.request_id)).size!==entries.length)throw invalid()
  return entries
 }
 async load(scope:string,task:string){return this.decode(await this.row(scope,task),scope,task)}
 private async update(scope:string,task:string,change:(entries:DeliveryIntent[])=>DeliveryIntent[]){
  // Hashing happens outside IDB transactions; compare the entire previous
  // envelope inside the transaction to fence concurrent tabs before commit.
  for(let attempt=0;attempt<8;attempt++){
   const prior=await this.row(scope,task),entries=await this.decode(prior,scope,task),next=change(entries),payload=JSON.stringify(next)
   if(payload.length>512*1024)throw invalid()
   const digest=await hash(payload),db=await this.open(),key=this.key(scope,task)
   const changed=await new Promise<boolean>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),read=store.get(key);let race=false,failure:Error|undefined
    read.onsuccess=()=>{if(JSON.stringify(read.result)!==JSON.stringify(prior)){race=true;tx.abort();return}
     if(!next.length){store.delete(key);return}
     const all=store.getAll();all.onsuccess=()=>{const rows=(all.result as Row[]).filter(r=>r.key!==key);if((!prior||payload.length>prior.payload.length)&&(rows.length>=512||rows.reduce((n,r)=>n+(typeof r.payload==='string'?r.payload.length*2:1024*1024),0)+payload.length*2>64*1024*1024)){failure=new Error('未确认操作记录已达存储上限，请先核对原请求。');tx.abort();return};store.put({key,scope,task,schema:1,payload,hash:digest} satisfies Row)}
    };tx.oncomplete=()=>resolve(true);tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>race?resolve(false):reject(failure??tx.error)
   });if(changed)return
  }throw occupied()
 }
 async reserve(scope:string,intent:DeliveryIntent){if(!validDeliveryIntent(intent))throw invalid();await this.update(scope,intent.task,entries=>{if(entries.length)throw occupied();return [intent]})}
 async importLegacy(scope:string,task:string,intents:DeliveryIntent[]){
  if(!intents.length)return
  if(intents.length>2||intents.some(v=>!validDeliveryIntent(v)||v.task!==task))throw invalid()
  await this.update(scope,task,entries=>{const next=[...entries];for(const intent of intents){const prior=next.find(v=>v.operation.input.request_id===intent.operation.input.request_id);if(prior){if(JSON.stringify(prior)!==JSON.stringify(intent))throw occupied()}else next.push(intent)}if(next.length>2)throw occupied();return next})
 }
 async remove(scope:string,intent:DeliveryIntent){await this.update(scope,intent.task,entries=>{const prior=entries.find(v=>v.operation.input.request_id===intent.operation.input.request_id);if(!prior)throw occupied();if(JSON.stringify(prior)!==JSON.stringify(intent))throw occupied();return entries.filter(v=>v!==prior)})}
}
