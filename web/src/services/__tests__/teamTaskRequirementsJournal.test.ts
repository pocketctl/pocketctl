import {IDBFactory} from 'fake-indexeddb'
import {webcrypto} from 'node:crypto'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {TeamTaskRequirementsJournal} from '../teamTaskRequirementsJournal'
import {validRequirementsOperation,type RequirementsOperation} from '../../types/teamTaskRequirements'
const op:RequirementsOperation={kind:'save',team:'team',task:'task',actor:2,requirementsRevision:0,input:{request_id:'original',expected_revision:1,requirements:{goal:'goal',scope:'',acceptance:'',repository:null}}}
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto)})
afterEach(()=>vi.unstubAllGlobals())
test('reopen preserves original request across refresh, scopes isolate account/Relay/task',async()=>{
 const a=new TeamTaskRequirementsJournal();await a.reserve('actor2-relayA',op)
 const b=new TeamTaskRequirementsJournal();expect(await b.load('actor2-relayA','task')).toEqual(op)
 for(const scope of ['actor3-relayA','actor2-relayB'])expect(await b.load(scope,'task')).toBeNull()
 expect(await b.load('actor2-relayA','another')).toBeNull()
 await expect(b.remove('actor2-relayA',{...op,input:{...op.input,request_id:'other'}})).rejects.toThrow()
 expect(await b.load('actor2-relayA','task')).toEqual(op)
 await b.remove('actor2-relayA',op);expect(await a.load('actor2-relayA','task')).toBeNull()
})
test('two tabs cannot replace an unresolved save with override',async()=>{
 const a=new TeamTaskRequirementsJournal(),b=new TeamTaskRequirementsJournal()
 const override:RequirementsOperation={kind:'override',team:'team',task:'task',actor:2,requirementsRevision:1,input:{request_id:'override',expected_revision:2,reason:'confirmed'}}
 const results=await Promise.allSettled([a.reserve('scope',op),b.reserve('scope',override)])
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
 const saved=await a.load('scope','task');expect([op,override]).toContainEqual(saved)
 await b.reserve('scope',saved!)
})
test('invalid and secret-bearing records fail closed before storage',async()=>{
 const journal=new TeamTaskRequirementsJournal()
 const invalid=[{...op,actor:0},{...op,requirementsRevision:-1},{...op,input:{...op.input,expected_revision:1.2}},
 {...op,input:{...op.input,requirements:{...op.input.requirements,repository:{kind:'git',url:'https://user:secret@example.test/repo'}}}},
 {...op,input:{...op.input,requirements:{...op.input.requirements,repository:{kind:'git',url:'https://example.test/repo?token=secret'}}}},
 {...op,input:{...op.input,requirements:{...op.input.requirements,extra:'not supported'}}},
 {...op,input:{...op.input,reason:'mixed operation'}},
 {kind:'override',team:'team',task:'task',actor:2,requirementsRevision:0,input:{request_id:'o',expected_revision:1,reason:''}}]
 for(const bad of invalid){expect(validRequirementsOperation(bad)).toBe(false);await expect(journal.reserve('scope',bad as RequirementsOperation)).rejects.toThrow()}
 expect(await journal.load('scope','task')).toBeNull()
})
test('storage unavailable never silently falls back to transient memory',async()=>{
 vi.stubGlobal('indexedDB',undefined)
 await expect(new TeamTaskRequirementsJournal().reserve('scope',op)).rejects.toThrow()
})
test('tampered durable payload is retained and cannot be loaded as a valid operation',async()=>{
 const journal=new TeamTaskRequirementsJournal();await journal.reserve('scope',op)
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('pocketctl-team-task-requirements-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('intents','readwrite'),store=tx.objectStore('intents'),get=store.get(JSON.stringify(['scope','task']));get.onsuccess=()=>store.put({...get.result,payload:JSON.stringify({...op,actor:9})});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error)})
 await expect(journal.load('scope','task')).rejects.toThrow('损坏')
 await expect(journal.reserve('scope',op)).rejects.toThrow()
 await expect(journal.remove('scope',op)).rejects.toThrow()
 db.close()
})
