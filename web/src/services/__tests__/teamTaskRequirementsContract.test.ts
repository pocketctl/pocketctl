import {expect,test} from 'vitest'
import {matchesRequirementsReceipt,normalizeRequirements,matchesRequirementsResult,type RequirementsOperation} from '../../types/teamTaskRequirements'
import type {TeamTask} from '../../types/team'
const op:RequirementsOperation={kind:'save',team:'team',task:'task',actor:2,requirementsRevision:3,input:{request_id:'id',expected_revision:8,requirements:{goal:'Goal',scope:'',repository:null,acceptance:''}}}
const task={id:'task',team_id:'team',revision:9,requirements:{document:op.input.requirements,revision:4,readiness:{status:'needs_information',missing:['scope','repository','acceptance']},override:null}} as TeamTask
test('acknowledgement binds task/team/task revision/requirements revision and saved content',()=>{
 expect(matchesRequirementsResult(op,task)).toBe(true)
 for(const changed of [{...task,id:'other'},{...task,team_id:'other'},{...task,revision:10},{...task,requirements:{...task.requirements!,revision:5}},{...task,requirements:{...task.requirements!,document:{...op.input.requirements,scope:'different'}}}])expect(matchesRequirementsResult(op,changed)).toBe(false)
})
test('override acknowledgement binds actor, reason and requirements version',()=>{
 const override:RequirementsOperation={...op,kind:'override',input:{request_id:'override',expected_revision:8,reason:'Reason'}}
 const result={...task,requirements:{...task.requirements!,revision:3,override:{actor_user_id:2,reason:'Reason',requirements_revision:3}}}
 expect(matchesRequirementsResult(override,result)).toBe(true)
 for(const patch of [{actor_user_id:3},{reason:'Different'},{requirements_revision:4}])expect(matchesRequirementsResult(override,{...result,requirements:{...result.requirements,override:{...result.requirements.override,...patch}}})).toBe(false)
})
test('normalize descriptive repository without credential/query/traversal or implicit missing reason',()=>{
 expect(normalizeRequirements({goal:' Goal ',scope:' ',acceptance:'',repository:{kind:'git',url:'https://EXAMPLE.test/org/repo'}})).toEqual({goal:'Goal',scope:'',acceptance:'',repository:{kind:'git',url:'https://example.test/org/repo'}})
 for(const url of ['https://example.test','https://example.test/a/../b','https://example.test/a/%2e%2e/b','https://example.test/a%2fb','https://example.test/repo#secret','ssh://example.test/repo'])expect(()=>normalizeRequirements({...op.input.requirements,repository:{kind:'git',url}})).toThrow()
 expect(()=>normalizeRequirements({...op.input.requirements,repository:{kind:'not_applicable',reason:''}})).toThrow()
})

test('receipt must match actor, task, operation, request ID and response',()=>{
 const r={task_id:'task',actor_user_id:2,kind:'save' as const,request_id:'id',found:true,response:task}
 expect(matchesRequirementsReceipt(op,r)).toBe(true)
 expect(matchesRequirementsReceipt(op,{...r,found:false,response:null})).toBe(true)
 for(const patch of [{actor_user_id:3},{task_id:'other'},{kind:'override' as const},{request_id:'different'},{found:false},{response:null}])expect(matchesRequirementsReceipt(op,{...r,...patch})).toBe(false)
})
