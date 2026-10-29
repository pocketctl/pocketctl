import {validTemplateSave,type TemplateSaveOperation} from '../types/teamTemplateEditing'
type RecordRow={key:string;scope:string;team:string;schema:1;payload:string;hash:string}
const invalid=()=>new Error('原模板保存记录损坏或不匹配，请保留记录并核对模板版本。')
const occupied=()=>new Error('此团队已有未确认模板保存，请重新读取原请求。')
const hash=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('')
/** Durable intents are separate from evictable read caches. Never expire unknown calls. */
export class TeamTemplateSaveJournal {
 private db?:Promise<IDBDatabase>
 private open(){
  if(!globalThis.indexedDB)return Promise.reject(new Error('无法持久保存模板请求，请恢复浏览器存储后重试。'))
  return this.db??=new Promise<IDBDatabase>((resolve,reject)=>{
   const r=indexedDB.open('pocketctl-team-template-saves-v1',1)
   r.onupgradeneeded=()=>r.result.createObjectStore('intents',{keyPath:'key'})
   r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.db=undefined};resolve(r.result)}
   r.onerror=()=>{this.db=undefined;reject(r.error)}
  })
 }
 private key(scope:string,team:string){return JSON.stringify([scope,team])}
 async load(scope:string,team:string):Promise<TemplateSaveOperation|null>{
  const db=await this.open(),key=this.key(scope,team)
  const row=await new Promise<RecordRow|undefined>((resolve,reject)=>{const tx=db.transaction('intents','readonly'),r=tx.objectStore('intents').get(key);tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})
  if(!row)return null
  if(row.schema!==1||row.key!==key||row.scope!==scope||row.team!==team||typeof row.payload!=='string'||row.payload.length>512*1024||await hash(row.payload)!==row.hash)throw invalid()
  const op=JSON.parse(row.payload);if(!validTemplateSave(op)||op.team!==team)throw invalid();return op
 }
 async reserve(scope:string,op:TemplateSaveOperation){
  if(!validTemplateSave(op))throw invalid()
  const payload=JSON.stringify(op),digest=await hash(payload),key=this.key(scope,op.team)
  if(payload.length>512*1024)throw invalid()
  const db=await this.open()
  await new Promise<void>((resolve,reject)=>{
   const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{
    const prior=get.result as RecordRow|undefined
    if(prior){if(prior.schema!==1||prior.scope!==scope||prior.team!==op.team||prior.payload!==payload||prior.hash!==digest){failure=occupied();tx.abort()};return}
    // Bound growth without ever evicting another unresolved operation.
    const all=store.getAll();all.onsuccess=()=>{const rows=all.result as RecordRow[];if(rows.length>=512||rows.reduce((n,r)=>n+(typeof r.payload==='string'?r.payload.length*2:1024*1024),0)+payload.length*2>64*1024*1024){failure=new Error('未确认模板保存记录已达存储上限，请先核对原请求。');tx.abort();return};store.add({key,scope,team:op.team,schema:1,payload,hash:digest} satisfies RecordRow)}
   }
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
 async remove(scope:string,op:TemplateSaveOperation){
  const payload=JSON.stringify(op),digest=await hash(payload),db=await this.open(),key=this.key(scope,op.team)
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(key);let failure:Error|undefined
   get.onsuccess=()=>{const row=get.result as RecordRow|undefined;if(!row)return;if(row.scope!==scope||row.team!==op.team||row.payload!==payload||row.hash!==digest){failure=occupied();tx.abort();return};store.delete(key)}
   tx.oncomplete=()=>resolve();tx.onerror=()=>reject(failure??tx.error);tx.onabort=()=>reject(failure??tx.error)
  })
 }
}
export const teamTemplateSaveJournal=new TeamTemplateSaveJournal()
