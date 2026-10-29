import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'

import { resolveTeamCollaborationConfig } from '../team/config.js'
import { TeamRepositoryError } from '../team/repository.js'
import { registerTeamTaskRoutes, type TeamTaskRouteService } from '../team/task-routes.js'

function service(overrides: Partial<TeamTaskRouteService> = {}): TeamTaskRouteService {
  return {
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    restoreTask: vi.fn(),
    setHolder: vi.fn(),
    linkSession: vi.fn(),
    ...overrides,
  }
}

function appFor(testService: TeamTaskRouteService, enabled = true) {
  const app = Fastify()
  registerTeamTaskRoutes(app, {
    config: resolveTeamCollaborationConfig(enabled ? { TEAM_COLLABORATION: 'on',TEAM_TASK_READINESS_V1:'on' } : {}),
    service: testService,
    verifyAccessToken: async token => token === 'valid' ? { userId: 17 } : null,
    getDatabaseReady: () => true,
  })
  return app
}

describe('Team task routes', () => {
  test.each(['utf8','unicode-escaped'] as const)('maximum multilingual requirements survive %s HTTP transport without truncation',async encoding=>{
    const requirements={goal:'目'.repeat(9990)+'GOAL-TAIL1',scope:'范'.repeat(9990)+'SCOPE-END1',acceptance:'验'.repeat(9990)+'CHECK-END1',repository:{kind:'not_applicable',reason:'Transport-only acceptance'}}
    const app=appFor(service({updateRequirements:async input=>({id:input.taskId,requirements:input.requirements}) as never}))
    const json=JSON.stringify({request_id:'maximum-'+encoding,expected_revision:1,requirements})
    const payload=encoding==='utf8'?json:json.replace(/[^\x00-\x7f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))
    try{
      const response=await app.inject({method:'PUT',url:'/api/team/tasks/ctk_long/requirements',headers:{authorization:'Bearer valid','content-type':'application/json'},payload})
      expect(response.statusCode).toBe(200)
      const actual=response.json().task.requirements
      expect(actual.goal).toBe(requirements.goal);expect(actual.scope).toBe(requirements.scope);expect(actual.acceptance).toBe(requirements.acceptance)
    }finally{await app.close()}
  })
  test('requirements HTTP transport still rejects bodies above its bounded envelope',async()=>{
    const app=appFor(service())
    try{
      const response=await app.inject({method:'PUT',url:'/api/team/tasks/ctk_long/requirements',headers:{authorization:'Bearer valid','content-type':'application/json'},payload:' '.repeat(256*1024)+'{}'})
      expect(response.statusCode).toBe(413)
    }finally{await app.close()}
  })
  test('self-holder receipts require identity and remain readable with writes disabled',async()=>{
    const selfHolderReceipt=vi.fn(async()=>({task_id:'t',actor_user_id:17,request_id:'claim',found:false,response:null}))
    const app=appFor(service({selfHolderReceipt} as never),false)
    const url='/api/team/tasks/t/holders/self/receipt?request_id=claim'
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401)
    const found = await app.inject({method:'GET',url,headers:{authorization:'Bearer valid'}})
    expect(found.json()).toMatchObject({found:false,response:null})
    expect(found.headers['cache-control']).toBe('private, no-store')
    expect(selfHolderReceipt).toHaveBeenCalledWith('t',17,'claim')
    for(const query of ['', 'request_id=', 'request_id=%20claim', 'request_id=a%00', 'request_id=a&holder_user_id=99', 'request_id=a&kind=claim']) {
      expect((await app.inject({method:'GET',url:'/api/team/tasks/t/holders/self/receipt?'+query,headers:{authorization:'Bearer valid'}})).statusCode).toBe(400)
    }
    expect(selfHolderReceipt).toHaveBeenCalledTimes(1)
    selfHolderReceipt.mockRejectedValueOnce(new TeamRepositoryError('team_access_denied','denied'))
    expect((await app.inject({method:'GET',url,headers:{authorization:'Bearer valid'}})).statusCode).toBe(403)
    await app.close()
  })

  test('original requirements receipt is authenticated and readable with write flags off',async()=>{
    const requirementReceipt=vi.fn(async()=>({task_id:'t',actor_user_id:17,kind:'save',request_id:'original',found:false,response:null}))
    const app=appFor(service({requirementReceipt} as never),false)
    const url='/api/team/tasks/t/requirements/receipt?kind=save&request_id=original'
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401)
    expect((await app.inject({method:'GET',url,headers:{authorization:'Bearer valid'}})).json()).toMatchObject({found:false})
    expect(requirementReceipt).toHaveBeenCalledWith('t',17,'save','original')
    for(const query of ['kind=delete&request_id=a','kind=save','kind=save&request_id=a&user_id=99'])expect((await app.inject({method:'GET',url:'/api/team/tasks/t/requirements/receipt?'+query,headers:{authorization:'Bearer valid'}})).statusCode).toBe(400)
    expect(requirementReceipt).toHaveBeenCalledTimes(1);await app.close()
  })

  test('pool filters are bounded and mine always uses authenticated identity',async()=>{
    const listTasks=vi.fn(async()=>[]),app=appFor(service({listTasks}))
    const valid=await app.inject({method:'GET',url:'/api/team/teams/t/tasks?pool=mine',headers:{authorization:'Bearer valid'}})
    expect(valid.statusCode).toBe(200)
    expect(listTasks).toHaveBeenCalledWith('t',17,false,'mine')
    for(const query of ['pool=other','pool=unclaimed&include_deleted=true','pool=mine&user_id=99']){
      const response=await app.inject({method:'GET',url:'/api/team/teams/t/tasks?'+query,headers:{authorization:'Bearer valid'}})
      expect(response.statusCode).toBe(400)
    }
    expect(listTasks).toHaveBeenCalledTimes(1);await app.close()
  })
  test('history rejects malformed cursors before accessing storage',async()=>{
    const requirementHistory=vi.fn(async()=>({events:[],next_before_revision:null})),app=appFor(service({requirementHistory} as never))
    const valid=await app.inject({method:'GET',url:'/api/team/tasks/t/requirements/history?before_revision=7',headers:{authorization:'Bearer valid'}})
    expect(valid.statusCode).toBe(200)
    expect(requirementHistory).toHaveBeenCalledWith('t',17,7)
    for(const cursor of ['0','-1','1.2','1e3','9007199254740992']){
      expect((await app.inject({method:'GET',url:'/api/team/tasks/t/requirements/history?before_revision='+cursor,headers:{authorization:'Bearer valid'}})).statusCode).toBe(400)
    }
    expect(requirementHistory).toHaveBeenCalledTimes(1);await app.close()
  })

  test('requirements use authenticated identity and reject malformed repository references',async()=>{
    const updateRequirements=vi.fn(async()=>({id:'ctk_1',revision:2}))
    const app=appFor(service({updateRequirements} as never))
    const base={request_id:'requirements-1',expected_revision:1,requirements:{goal:'Goal',scope:'Module',acceptance:'Checks',repository:null}}
    const response=await app.inject({method:'PUT',url:'/api/team/tasks/ctk_1/requirements',headers:{authorization:'Bearer valid'},payload:base})
    expect(response.statusCode).toBe(200)
    expect(updateRequirements).toHaveBeenCalledWith({taskId:'ctk_1',actorUserId:17,requestId:'requirements-1',expectedRevision:1,requirements:base.requirements})
    const bad=await app.inject({method:'PUT',url:'/api/team/tasks/ctk_1/requirements',headers:{authorization:'Bearer valid'},payload:{...base,requirements:{...base.requirements,repository:{kind:'git',url:'file:///private'}}}})
    expect(bad.statusCode).toBe(400)
    expect(updateRequirements).toHaveBeenCalledTimes(1)
    await app.close()
  })
  test('requirements and override writes stay disabled with the independent flag off',async()=>{
    const updateRequirements=vi.fn(),overrideRequirements=vi.fn()
    const app=Fastify()
    registerTeamTaskRoutes(app,{config:resolveTeamCollaborationConfig({TEAM_COLLABORATION:'on'}),service:service({updateRequirements,overrideRequirements} as never),verifyAccessToken:async()=>({userId:17})})
    for(const [method,path,payload] of [['PUT','requirements',{requirements:{goal:'',scope:'',acceptance:'',repository:null}}],['POST','requirements/override',{reason:'Known missing context'}]] as const){
      const response=await app.inject({method,url:'/api/team/tasks/ctk_1/'+path,headers:{authorization:'Bearer valid'},payload:{request_id:'r',expected_revision:1,...payload}})
      expect(response.statusCode).toBe(503)
    }
    expect(updateRequirements).not.toHaveBeenCalled();expect(overrideRequirements).not.toHaveBeenCalled()
    await app.close()
  })

  test('creates a lightweight task with the authenticated actor', async () => {
    const createTask = vi.fn(async input => ({ id: 'ctk_1', revision: 1, ...input }))
    const app = appFor(service({ createTask }))
    const response = await app.inject({
      method: 'POST', url: '/api/team/teams/ctm_1/tasks',
      headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-create', title: '  Investigate  ', background: 'Facts only' },
    })
    expect(response.statusCode).toBe(201)
    expect(createTask).toHaveBeenCalledWith({
      teamId: 'ctm_1', actorUserId: 17, title: 'Investigate', background: 'Facts only', requestId: 'task-create',
    })
    await app.close()
  })

  test('does not turn a disabled Team feature into a task write path', async () => {
    const updateTask = vi.fn()
    const app = appFor(service({ updateTask }), false)
    const response = await app.inject({
      method: 'PATCH', url: '/api/team/tasks/ctk_1', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-update', expected_revision: 1, state: 'in_progress' },
    })
    expect(response.statusCode).toBe(503)
    expect(updateTask).not.toHaveBeenCalled()
    await app.close()
  })

  test('returns revision and creator authorization failures from the service', async () => {
    const app = appFor(service({
      updateTask: vi.fn(async () => { throw new TeamRepositoryError('revision_conflict', 'revision mismatch', 3) }),
      setHolder: vi.fn(async () => { throw new TeamRepositoryError('creator_required', 'team creator authority required') }),
    }))
    const stale = await app.inject({
      method: 'PATCH', url: '/api/team/tasks/ctk_1', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'task-stale', expected_revision: 2, background: 'new' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'revision_conflict', current_revision: 3, retryable: true })

    const forbidden = await app.inject({
      method: 'PUT', url: '/api/team/tasks/ctk_1/holders/99', headers: { authorization: 'Bearer valid' },
      payload: { request_id: 'holder-other', expected_revision: 3 },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json().error.code).toBe('creator_required')
    await app.close()
  })
})
