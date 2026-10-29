import { expect, test, vi } from 'vitest'
const request=vi.hoisted(()=>vi.fn().mockResolvedValue({}))
vi.mock('../teamClient',()=>({teamRequest:request}))
import { getTaskContext, getTaskPlan, getTaskPlanExecution, saveTaskPlanDraft, getTaskPlanDraftReceipt, getTaskPlanEditingOptions } from '../teamPlanClient'
test('plan and exact-attempt reads encode their identity and never request mutation',async()=>{
 await getTaskPlan('a/b',2);await getTaskPlanExecution('a/b');await getTaskContext('a/b','x&y')
 expect(request.mock.calls).toEqual([['/api/team/tasks/a%2Fb/plan?revision=2'],['/api/team/tasks/a%2Fb/plan/execution'],['/api/team/tasks/a%2Fb/context?attempt_id=x%26y']])
})

test('draft save and receipt use dedicated routes and bound actor identity',async()=>{
 request.mockClear();const identity={userId:1,origin:'local'}
 await saveTaskPlanDraft('a/b',{request_id:'key',expected_revision:0,team_session_id:'session',context_version:0,spec_revision:1,steps:[]},identity)
 expect(request.mock.calls[0][0]).toBe('/api/team/tasks/a%2Fb/plan');expect(request.mock.calls[0][1]).toMatchObject({method:'POST',identity})
 request.mockResolvedValueOnce({actor_user_id:2,found:false,response:null});await expect(getTaskPlanDraftReceipt('a/b','key',identity)).rejects.toThrow()
})

test('editing choices use the exact task identity and read-only options route',async()=>{
 request.mockClear();await getTaskPlanEditingOptions('a/b')
 expect(request.mock.calls).toEqual([['/api/team/tasks/a%2Fb/plan/options']])
})
