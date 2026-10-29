import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { TeamDeliveryCache, deliveryCacheScope } from '../teamDeliveryCache'
let cache:TeamDeliveryCache
const a=deliveryCacheScope(1,'https://one.test'),b=deliveryCacheScope(2,'https://one.test'),otherRelay=deliveryCacheScope(1,'https://two.test')
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());cache=new TeamDeliveryCache()})
afterEach(()=>vi.unstubAllGlobals())
const put=(scope:string,id:string,kind:'detail'|'file'|'cards'='detail',tasks=[id],data:unknown={text:'private'})=>cache.write(scope,kind,id,'team',tasks,data,cache.ticket())
test('a fresh instance reads persisted data but another account or Relay cannot',async()=>{
 await put(a,'task');expect((await new TeamDeliveryCache().read(a,'detail','task'))?.data).toEqual({text:'private'});expect(await cache.read(b,'detail','task')).toBeNull();expect(await cache.read(otherRelay,'detail','task')).toBeNull()
})
test('task revocation removes detail, files, history and every session page referencing the task',async()=>{
 await put(a,'task');await put(a,'bytes','file',['task'],new Uint8Array([1,2]).buffer);await put(a,'session','cards',['task']);await put(a,'other');await put(b,'task')
 const before=cache.ticket();await cache.purge(a,{task:'task'});await cache.write(a,'detail','task','team',['task'],{text:'late response'},before)
 expect(await cache.read(a,'detail','task')).toBeNull();expect(await cache.read(a,'file','bytes')).toBeNull();expect(await cache.read(a,'cards','session')).toBeNull();expect(await cache.read(a,'detail','other')).not.toBeNull();expect(await cache.read(b,'detail','task')).not.toBeNull()
})
test('session revocation deletes its cached task files even when history is not mounted',async()=>{
 await put(a,'session','cards',['task']);await put(a,'task');await put(a,'bytes','file',['task'],new Uint8Array([1]).buffer);await cache.purge(a,{session:'session'});expect(await cache.read(a,'file','bytes')).toBeNull();expect(await cache.read(a,'detail','task')).toBeNull()
})
test('file invalidation preserves review metadata and another task',async()=>{
 await put(a,'task');await put(a,'bytes','file',['task'],new Uint8Array([1]).buffer);await cache.purge(a,{task:'task',filesOnly:true});expect(await cache.read(a,'file','bytes')).toBeNull();expect(await cache.read(a,'detail','task')).not.toBeNull()
})
test('logout races cannot resurrect content from an in-flight write',async()=>{
 const ticket=cache.ticket(),write=cache.write(a,'detail','task','team',['task'],{text:'pending'},ticket);await cache.purge();await write;expect(await new TeamDeliveryCache().read(a,'detail','task')).toBeNull()
})
test('expired snapshots are not returned and oldest rows are evicted at the bound',async()=>{
 const now=vi.spyOn(Date,'now');now.mockReturnValue(100);await put(a,'expired');now.mockReturnValue(8*86400000);expect(await cache.read(a,'detail','expired')).toBeNull()
 for(let i=0;i<513;i++){now.mockReturnValue(8*86400000+i);await put(a,'task'+i)}
 expect(await cache.read(a,'detail','task0')).toBeNull();expect(await cache.read(a,'detail','task512')).not.toBeNull();now.mockRestore()
})
test('64 MiB total file budget evicts oldest entries; oversized entries are not persisted',async()=>{
 await put(a,'one','file',['task'],new ArrayBuffer(32*1024*1024));await put(a,'two','file',['task'],new ArrayBuffer(32*1024*1024));await put(a,'three','file',['task'],new ArrayBuffer(1));await put(a,'oversized','file',['task'],new ArrayBuffer(32*1024*1024+1));expect(await cache.read(a,'file','one')).toBeNull();expect(await cache.read(a,'file','two')).not.toBeNull();expect(await cache.read(a,'file','three')).not.toBeNull();expect(await cache.read(a,'file','oversized')).toBeNull()
})

test('failed revocation cleanup leaves a persistent read barrier until cleanup succeeds',async()=>{
 await put(a,'task');const db=globalThis.indexedDB;vi.stubGlobal('indexedDB',undefined);await expect(new TeamDeliveryCache().purge(a,{task:'task'})).rejects.toThrow();vi.stubGlobal('indexedDB',db)
 expect(await new TeamDeliveryCache().read(a,'detail','task')).toBeNull();await cache.purge(a,{task:'task'});expect(await cache.read(a,'detail','task')).toBeNull()
})
