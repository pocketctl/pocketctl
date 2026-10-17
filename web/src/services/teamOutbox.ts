import type {TeamMessageTargetMode} from '../types/team'
export type TeamSendState='queued'|'sending'|'failed'|'unknown'
export interface TeamOutboxMessage {
 key:string;scope:string;request_id:string;session_id:string;author_user_id:number;content:string
 target_mode:TeamMessageTargetMode;target_offer_ids:string[];reference_event_id:string|null;created_at:string;state:TeamSendState;error?:string
}
export interface TeamOutboxStorage {
 list(scope:string):Promise<TeamOutboxMessage[]>
 put(message:TeamOutboxMessage):Promise<void>
 remove(key:string):Promise<void>
 blockScope(scope:string):Promise<void>
}
export class IndexedDBTeamOutbox implements TeamOutboxStorage {
 private database?:Promise<IDBDatabase>
 private open(){
  return this.database??=new Promise<IDBDatabase>((resolve,reject)=>{
   if(!globalThis.indexedDB){reject(new Error('持久待发存储不可用，请检查浏览器存储权限'));return}
   const request=indexedDB.open('pocketctl-team-outbox-v2',1)
   request.onupgradeneeded=()=>{const store=request.result.createObjectStore('messages',{keyPath:'key'});store.createIndex('scope','scope')}
   request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)
  })
 }
 async list(scope:string){
  const db=await this.open()
  return new Promise<TeamOutboxMessage[]>((resolve,reject)=>{
   const tx=db.transaction('messages','readonly'),request=tx.objectStore('messages').index('scope').getAll(scope)
   tx.oncomplete=()=>resolve((request.result as TeamOutboxMessage[]).sort((a,b)=>a.created_at.localeCompare(b.created_at)))
   tx.onerror=()=>reject(tx.error)
  })
 }
 async put(message:TeamOutboxMessage){await this.mutate(store=>store.put(JSON.parse(JSON.stringify(message))))}
 async remove(key:string){await this.mutate(store=>store.delete(key))}
 async blockScope(scope:string){await this.mutate(store=>{const request=store.index('scope').openCursor(IDBKeyRange.only(scope));request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const row=cursor.value as TeamOutboxMessage;if(row.state==='queued')cursor.update({...row,state:'failed',error:'会话权限已变更，请重新确认后重试'});cursor.continue()}})}
 private async mutate(run:(store:IDBObjectStore)=>void){
  const db=await this.open()
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('messages','readwrite');run(tx.objectStore('messages'));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})
 }
}
export const teamOutbox:TeamOutboxStorage=new IndexedDBTeamOutbox()
// Continuous position advances only through witnessed events or an explicitly
// completed server interval; receiving 12 before 11 never acknowledges the gap.
export class TeamContinuousCursor {
 value=0
 private seen=new Set<number>()
 reset(floor=0){this.value=floor;this.seen.clear()}
 receive(seq:number){if(seq>this.value)this.seen.add(seq);while(this.seen.delete(this.value+1))this.value++;return this.value}
 completed(through:number){this.value=Math.max(this.value,through);for(const seq of this.seen)if(seq<=this.value)this.seen.delete(seq);while(this.seen.delete(this.value+1))this.value++;return this.value}
}
