import {describe,expect,test} from 'vitest'
import {parseTaskRequirements,taskReadiness} from '../team/task-readiness.js'

describe('task requirements advisory contract',()=>{
  test('incomplete drafts enumerate all missing fields without preventing creation',()=>{
    const draft=parseTaskRequirements({goal:'',scope:'',acceptance:'',repository:null})
    expect(taskReadiness(draft)).toEqual({status:'needs_information',missing:['goal','scope','repository','acceptance']})
  })
  test('non-code work explicitly explains why a repository is not applicable',()=>{
    const draft=parseTaskRequirements({goal:'Review',scope:'Release notes',acceptance:'Approved copy',repository:{kind:'not_applicable',reason:'Documentation review only'}})
    expect(taskReadiness(draft)).toEqual({status:'ready',missing:[]})
    expect(()=>parseTaskRequirements({...draft,repository:{kind:'not_applicable',reason:' '}})).toThrow()
  })
  test('normalizes a descriptive repository reference without granting access',()=>{
    const draft=parseTaskRequirements({goal:' Fix ',scope:' module ',acceptance:' tests ',repository:{kind:'git',url:'https://example.test/org/repo.git'}})
    expect(draft.goal).toBe('Fix')
    expect(taskReadiness(draft).status).toBe('ready')
  })
  test.each(['file:///private/data','https://token@example.test/repo','https://example.test/repo?token=secret','https://example.test/repo#secret','../repo','https://example.test/org/../repo','ssh://git@example.test/repo'])('rejects unsafe or ambiguous repository %s',url=>{
    expect(()=>parseTaskRequirements({goal:'x',scope:'x',acceptance:'x',repository:{kind:'git',url}})).toThrow()
  })
  test('rejects unexpected identity, model decisions and unbounded text',()=>{
    const draft={goal:'',scope:'',acceptance:'',repository:null}
    for(const extra of [{actor_user_id:99},{ready:true},{override:'model says ready'},{scope:'x'.repeat(10001)}])expect(()=>parseTaskRequirements({...draft,...extra})).toThrow()
    expect(()=>parseTaskRequirements({...draft,repository:{kind:'git',url:'https://example.test/repo',access_token:'secret'}})).toThrow()
  })
})
