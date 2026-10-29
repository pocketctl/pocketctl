import {IDBFactory} from 'fake-indexeddb'
import {webcrypto} from 'node:crypto'
import {beforeEach,afterEach,expect,test,vi} from 'vitest'
import {TeamTaskAssignmentJournal,type TaskAssignment} from '../teamTaskAssignmentJournal'
import {validTemplate,validTemplateTask,matchingTemplateTask,validTemplateReceipt} from '../../types/teamTemplate'
import {template,operation,result} from './fixtures/teamTemplate'
beforeEach(()=>{vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('crypto',webcrypto)})
afterEach(()=>vi.unstubAllGlobals())
test('template role kinds, DAG, required steps and budget use the plan contract',()=>{
 expect(validTemplate(template.definition)).toBe(true)
 expect(validTemplate({...template.definition,goal:'literal \\u0000 documentation'})).toBe(true)
 expect(validTemplate({...template.definition,steps:[{...template.definition.steps[0],instruction:'bad\0'}]})).toBe(false)
 for(const change of [{roles:[{role_id:'worker',kind:'reviewer',label:'Wrong'}]},{steps:[{...template.definition.steps[0],depends_on:['s1']}]},{steps:[{...template.definition.steps[0],required:false}]},{budget_suggestion:{invocation_limit:0}},{credential:'secret'}])expect(validTemplate({...template.definition,...change})).toBe(false)
})
test('frozen creation validates every role, type, version, size and authority identity',()=>{
 expect(validTemplateTask(operation)).toBe(true)
 for(const change of [{role_bindings:{worker:'offer'}},{role_bindings:{worker:'offer',reviewer:'2'}},{role_bindings:{worker:'offer',reviewer:2,extra:2}},{template_revision:2},{goal:'\0'},{context_version:-1},{goal:'中'.repeat(32000)}])expect(validTemplateTask({...operation,input:{...operation.input,...change}})).toBe(false)
 expect(validTemplateTask({...operation,team:'other'})).toBe(false)
})
test('receipts bind actor request and exact snapshot and reject any execution',()=>{
 expect(matchingTemplateTask(operation,result)).toBe(true)
 for(const change of [{template_hash:'c'.repeat(64)},{template_revision:2},{team_session_id:'other'},{execution_enabled:true},{call_ids:['call']},{plan_revision:2}])expect(matchingTemplateTask(operation,{...result,...change} as any)).toBe(false)
 const receipt={team_id:'team',actor_user_id:2,request_id:'original',operation:'create_template_task' as const,found:false,response:null}
 expect(validTemplateReceipt(operation,receipt)).toBe(true)
 for(const change of [{actor_user_id:3},{request_id:'other'},{operation:'assign_task'},{found:true},{response:result}])expect(validTemplateReceipt(operation,{...receipt,...change} as any)).toBe(false)
})
test('template and ordinary assignment compete for the same atomic session reservation',async()=>{
 const regular:TaskAssignment={team:'team',session:'session',actor:2,input:{request_id:'regular',instruction:'Goal',acceptance:'Criteria',context_version:4,target_offer_ids:['offer']}}
 const a=new TeamTaskAssignmentJournal(),b=new TeamTaskAssignmentJournal()
 const results=await Promise.allSettled([a.reserve('scope',operation),b.reserve('scope',regular)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 const winner=(await a.loadCreation('scope','session'))!;expect(winner).toEqual(results[0].status==='fulfilled'?operation:regular)
 await expect(b.remove('scope',results[0].status==='fulfilled'?regular:operation)).rejects.toThrow()
 await b.remove('scope',winner);expect(await a.loadCreation('scope','session')).toBeNull()
})
test('template original survives reopening, isolates accounts/Relays and blocks ordinary assignment',async()=>{
 await new TeamTaskAssignmentJournal().reserve('actor-2-relay-a',operation)
 const j=new TeamTaskAssignmentJournal();expect(await j.loadCreation('actor-2-relay-a','session')).toEqual(operation)
 await expect(j.load('actor-2-relay-a','session')).rejects.toThrow('模板创建')
 expect(await j.loadCreation('actor-3-relay-a','session')).toBeNull();expect(await j.loadCreation('actor-2-relay-b','session')).toBeNull()
})
