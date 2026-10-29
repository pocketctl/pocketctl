import {expect,test,vi} from 'vitest'
const request=vi.hoisted(()=>vi.fn())
vi.mock('../teamClient',()=>({teamRequest:request}))
import {listTeamTemplates,getTeamTemplate,createTemplateTask,findTemplateTask,getTaskTemplateSource,saveTeamTemplate,findTemplateSave} from '../teamTemplateClient'
import {operation} from './fixtures/teamTemplate'
test('template requests encode exact IDs, freeze version and carry original actor/Relay',async()=>{
 const identity={userId:2,origin:'local'}
 await listTeamTemplates('a/b','x&y',identity);await getTeamTemplate('a/b','t/x',2,identity);await createTemplateTask('a/b',operation.input,identity);await findTemplateTask('a/b','r/x',identity);await getTaskTemplateSource('a/b','task/x',identity)
 expect(request.mock.calls.map(c=>c[0])).toEqual(['/api/teams/a%2Fb/templates?after=x%26y','/api/teams/a%2Fb/templates/t%2Fx?revision=2','/api/teams/a%2Fb/template-tasks','/api/teams/a%2Fb/template-tasks/receipt-lookup/r%2Fx','/api/teams/a%2Fb/tasks/task%2Fx/template-source'])
 expect(request.mock.calls[2][1]).toEqual({method:'POST',body:operation.input,identity,timeoutMs:30000})
 expect(request.mock.calls.every(c=>c[1].identity===identity)).toBe(true)
 expect(request.mock.calls.filter(c=>c[1].method==='POST')).toHaveLength(1)
})

test('template save and exact original receipt encode team template request IDs',async()=>{request.mockClear();const identity={userId:2,origin:'local'},input={request_id:'key / one',expected_revision:1,definition:operation.template.definition};await saveTeamTemplate('team / one','template / one',input,identity);await findTemplateSave('team / one','template / one','key / one',identity);expect(request.mock.calls[0]).toEqual(['/api/teams/team%20%2F%20one/templates/template%20%2F%20one',{method:'POST',body:input,identity,timeoutMs:30000}]);expect(request.mock.calls[1]).toEqual(['/api/teams/team%20%2F%20one/templates/template%20%2F%20one/receipt-lookup/key%20%2F%20one',{identity,timeoutMs:15000}])})
