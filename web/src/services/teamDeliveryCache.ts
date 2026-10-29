/** Bounded, read-only snapshots. Authorization always comes from live APIs. */
export type DeliveryCacheKind='detail'|'history'|'cards'|'file'|'directory'|'tasks'
type Entry={key:string;scope:string;kind:DeliveryCacheKind;id:string;team:string;tasks:string[];at:number;size:number;data:unknown}
const INVALIDATING='pocketctl-team-delivery-cache-invalidating', INVALIDATED='pocketctl-team-delivery-cache-invalidated'
const MAX_BYTES=64*1024*1024, MAX_ROWS=512, MAX_AGE=7*24*60*60*1000
export function deliveryCacheScope(user:number,origin:string){return JSON.stringify([origin||location.origin,user])}
export class TeamDeliveryCache {
 private database?:Promise<IDBDatabase>
 private generation=0
 private unsafe=false
 invalidateRemote(detail:unknown){this.generation++;window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail}))}
 ticket(){return this.generation}
 private key(scope:string,kind:DeliveryCacheKind,id:string){return JSON.stringify([scope,kind,id])}
 private open():Promise<IDBDatabase>{
  if(!globalThis.indexedDB)return Promise.reject(new Error('离线缓存不可用'))
  return this.database??=new Promise<IDBDatabase>((resolve,reject)=>{
   const r=indexedDB.open('pocketctl-team-delivery-cache-v1',1)
   r.onupgradeneeded=()=>r.result.createObjectStore('entries',{keyPath:'key'})
   r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.database=undefined};resolve(r.result)}
   r.onerror=()=>{this.database=undefined;reject(r.error)}
  })
 }
 async read<T>(scope:string,kind:DeliveryCacheKind,id:string):Promise<{data:T;at:number}|null>{
  try{if(this.unsafe||localStorage.getItem(INVALIDATING))return null}catch{return null}
  const ticket=this.generation,db=await this.open()
  return new Promise((resolve,reject)=>{const tx=db.transaction('entries','readonly'),r=tx.objectStore('entries').get(this.key(scope,kind,id));tx.oncomplete=()=>{const row=r.result as Entry|undefined;resolve(ticket===this.generation&&row&&Date.now()-row.at<MAX_AGE?{data:row.data as T,at:row.at}:null)};tx.onerror=()=>reject(tx.error)})
 }
 async write(scope:string,kind:DeliveryCacheKind,id:string,team:string,tasks:string[],data:unknown,ticket:number){
  // Vue proxies are copied before reaching IndexedDB. Binary file data uses ArrayBuffer.
  const copy=kind==='file'?data:JSON.parse(JSON.stringify(data))
  const size=kind==='file'?(copy as ArrayBuffer).byteLength:new TextEncoder().encode(JSON.stringify(copy)).byteLength
  if(!Number.isFinite(size)||size>MAX_BYTES/2||ticket!==this.generation)return
  const db=await this.open();if(ticket!==this.generation)return
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite'),store=tx.objectStore('entries'),r=store.getAll()
   r.onsuccess=()=>{if(ticket!==this.generation)return;const key=this.key(scope,kind,id),now=Date.now();let rows=(r.result as Entry[]).filter(e=>{if(e.key===key||now-e.at>=MAX_AGE){store.delete(e.key);return false}return true}).sort((a,b)=>a.at-b.at)
    let total=rows.reduce((n,e)=>n+e.size,0)+size
    while(rows.length&&(total>MAX_BYTES||rows.length>=MAX_ROWS)){const row=rows.shift()!;total-=row.size;store.delete(row.key)}
    store.put({key,scope,kind,id,team,tasks:[...tasks],at:now,size,data:copy} satisfies Entry)
   };tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
  })
 }
 async purge(scope?:string,filter?:{task?:string;team?:string;session?:string;filesOnly?:boolean}){
  const stamp=crypto.randomUUID();this.unsafe=true
  try{localStorage.setItem(INVALIDATING,stamp);localStorage.setItem(INVALIDATED,JSON.stringify({stamp,detail:{scope,...filter}}))}catch{}
  this.generation++ // In-flight reads/writes cannot resurrect a revoked snapshot.
  if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{scope,...filter}}))
  const db=await this.open()
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('entries','readwrite'),store=tx.objectStore('entries'),r=store.getAll()
   r.onsuccess=()=>{const rows=r.result as Entry[],sessionTasks=filter?.session?new Set(rows.filter(e=>e.scope===scope&&e.kind==='cards'&&e.id===filter.session).flatMap(e=>e.tasks)):null
    for(const row of rows)if((!filter?.filesOnly||row.kind==='file')&&(!scope||row.scope===scope)&&(!filter||filter.task&&row.tasks.includes(filter.task)||filter.team&&(row.team===filter.team||row.kind==='directory')||filter.session&&(row.kind==='cards'&&row.id===filter.session||row.tasks.some(t=>sessionTasks!.has(t)))))store.delete(row.key)
   };tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)
  })
  this.unsafe=false
  try{if(localStorage.getItem(INVALIDATING)===stamp)localStorage.removeItem(INVALIDATING)}catch{}
 }
}
export const teamDeliveryCache=new TeamDeliveryCache()

if(typeof window!=='undefined')window.addEventListener('storage',event=>{if(event.key!==INVALIDATED||!event.newValue)return;try{teamDeliveryCache.invalidateRemote(JSON.parse(event.newValue).detail)}catch{}})
