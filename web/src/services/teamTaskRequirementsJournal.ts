import {validRequirementsOperation,type RequirementsOperation} from '../types/teamTaskRequirements'
type RecordRow={key:string;scope:string;task:string;schema:1;payload:string;hash:string}
const invalid=()=>new Error('原需求操作记录损坏或不匹配，请保留记录并核对任务版本。')
const occupied=()=>new Error('此任务已有未确认需求操作，请重新读取原请求。')
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('')
/** Durable intents are separate from evictable read caches. Never expire unknown calls. */
export class TeamTaskRequirementsJournal {
 private db?:Promise<IDBDatabase>
 private open(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('无法持久保存需求请求，请恢复浏览器存储后重试。'))
  return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{
   const r=indexedDB.open('pocketctl-team-task-requirements-v1',1)
   r.onupgradeneeded=()=>r.result.createObjectStore('intents',{keyPath:'key'})
   r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.db=undefined};resolve(r.result)}
   r.onerror=()=>{this.db=undefined;reject(r.error)}
  })
 }
 private key(scope:string,task:string){return JSON.stringify([scope,task])}
 async load(scope:string,task:string):Promise<RequirementsOperation|null>{
  const db=await this.open(),key=this.key(scope,task)
  const row=await new Promise<RecordRow|undefined>((resolve,reject)=>{const tx=db.transaction('intents','readonly'),r=tx.objectStore('intents').get(key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})
  if(!row)return null
  if(row.schema!==1||row.key!==key||row.scope!==scope||row.task!==task||typeof row.payload!=='string'||row.payload.length>512*1024||await hash(row.payload)!==row.hash)throw invalid()
  const op=JSON.parse(row.payload);if(!validRequirementsOperation(op)||op.task!==task)throw invalid();return op
 }
 async reserve(scope:string,op:RequirementsOperation){
  if(!validRequirementsOperation(op))throw invalid()
  const payload=JSON.stringify(op),digest=await hash(payload),key=this.key(scope,op.task)
  if(payload.length>512*1024)throw invalid()
  const db=await this.open()
  await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{
    const prior=get.result as RecordRow|undefined
    if(prior){if(prior.schema!==1||prior.scope!==scope||prior.task!==op.task||prior.payload!==payload||prior.hash!==digest){failure=occupied();tx.abort()};return}
    // Bound growth without ever evicting another unresolved operation.
    const all=store.getAll();all.onsuccess=()=>{const rows=all.result as RecordRow[];if(rows.length>=512||rows.reduce((n,r)=>n+(typeof r.payload==='string'?r.payload.length*2:1024*1024),0)+payload.length*2>64*1024*1024){failure=new Error('未确认需求操作记录已达存储上限，请先核对原请求。');tx.abort();return};store.add({key,scope,task:op.task,schema:1,payload,hash:digest} satisfies RecordRow)}
   }
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
 async remove(scope:string,op:RequirementsOperation){
  const payload=JSON.stringify(op),digest=await hash(payload),db=await this.open(),key=this.key(scope,op.task)
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{const row=get.result as RecordRow|undefined;if(!row)return;if(row.scope!==scope||row.task!==op.task||row.payload!==payload||row.hash!==digest){failure=occupied();tx.abort();return};store.delete(key)}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
}
export const teamTaskRequirementsJournal=new TeamTaskRequirementsJournal()
