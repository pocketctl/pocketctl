import Fastify from 'fastify'
import { describe, expect, test, vi } from 'vitest'
import { registerPreferenceRoutes } from '../user-preferences.js'
import { getTokenSessionAnalytics, parseTokenSessionQuery } from '../token-usage/session-analytics.js'
import { TeamRepository } from '../team/repository.js'
import { TeamTaskService } from '../team/task-service.js'
import { TeamSessionService } from '../team/session-service.js'

describe('User preferences',()=>{
  function setup(){
    const rows=new Map<number,any>()
    const query=vi.fn(async(sql:string,args:any[]=[])=>{
      const id=args[0]
      if(sql.startsWith('INSERT')){if(!rows.has(id))rows.set(id,{preferences:{},revision:1});return {rows:[]}}
      if(sql.startsWith('UPDATE')){rows.set(id,{preferences:JSON.parse(args[1]),revision:rows.get(id).revision+1});return {rows:[rows.get(id)]}}
      return {rows:rows.has(id)?[rows.get(id)]:[]}
    })
    const app=Fastify();registerPreferenceRoutes(app,{pool:{query,connect:async()=>({query,release(){}})} as any,verifyAccessToken:async token=>/^user-\d+$/.test(token)?{userId:Number(token.slice(5))}:null,ready:()=>true})
    return app
  }
  test('persists only the authenticated account and rejects stale updates',async()=>{
    const app=setup(),headers={authorization:'Bearer user-1'}
    expect((await app.inject({url:'/api/user/preferences'})).statusCode).toBe(401)
    expect((await app.inject({url:'/api/user/preferences',headers})).json().revision).toBe(1)
    const save=await app.inject({method:'PATCH',url:'/api/user/preferences',headers,payload:{expected_revision:1,preferences:{locale:'en',notifications:{completed:false}}}})
    expect(save.statusCode).toBe(200);expect(save.json()).toMatchObject({revision:2,preferences:{locale:'en',notifications:{completed:false,errors:true}}})
    expect((await app.inject({url:'/api/user/preferences',headers:{authorization:'Bearer user-2'}})).json().preferences.locale).toBe('zh')
    const stale=await app.inject({method:'PATCH',url:'/api/user/preferences',headers,payload:{expected_revision:1,preferences:{theme:'dark'}}})
    expect(stale.statusCode).toBe(409);expect(stale.json().revision).toBe(2)
    for(const preferences of [{locale:'fr'},{theme:'auto'},{notifications:{completed:'false'}},{notifications:{unknown:true}},{user_id:2}])expect((await app.inject({method:'PATCH',url:'/api/user/preferences',headers,payload:{expected_revision:2,preferences}})).statusCode).toBe(400)
    await app.close()
  })
})

describe('Token sessions query',()=>{
  test('bounds pagination, dates and sort while allowing literal search text',()=>{
    for(const raw of [{limit:0},{limit:101},{page:-1},{sort:'total; DROP TABLE users'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-01-01'},{from:'2025-01-01',to:'2026-10-01'}])expect(()=>parseTokenSessionQuery(raw)).toThrow()
    expect(parseTokenSessionQuery({q:"%' OR 1=1",daemon:'host',agent:'codex',page:'2',limit:'5'})).toMatchObject({q:"%' OR 1=1",page:2,limit:5,agent:'codex'})
  })
  test('paginates before fetching subagents and aggregates outside the selected page',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[{count:'21',by_agent:[{agent_type:'codex',total:'900'}],sessions:[{session_id:'s',total_tokens:'30'}]}]}).mockResolvedValueOnce({rows:[{parent_session_id:'s',agentId:'a',tokenIn:3}]})
    const page=await getTokenSessionAnalytics({query} as any,7,parseTokenSessionQuery({page:'2',limit:'5'}),true)
    expect(page).toMatchObject({total:21,page:2,limit:5,has_more:true,byAgent:[{agent_type:'codex',total:900,pct:100}],sessions:[{session_id:'s',total_tokens:30,children:[{agentId:'a',tokenIn:3}]}]})
    expect(query.mock.calls[0][1]).toEqual([7,null,null,'',null,null,5,5])
    expect(query.mock.calls[0][0]).toContain('s.user_id=$1');expect(query.mock.calls[0][0]).toContain('LIMIT $7 OFFSET $8')
    expect(query.mock.calls[1][1]).toEqual([['s']])
  })
  test('uses usage dates and retained/attributed scope honestly',async()=>{
    const query=vi.fn(async(_sql:string,_args:unknown[])=>({rows:[{count:0,by_agent:[],sessions:[]}]}))
    const input=parseTokenSessionQuery({from:'2026-09-01',to:'2026-09-30'})
    expect((await getTokenSessionAnalytics({query} as any,1,input,true)).scope).toMatchObject({basis:'attributed_usage',includes_subagents:false,timezone:'UTC'})
    expect(query.mock.calls[0][0]).toContain('NOT f.session_attribution_revoked')
    expect(query.mock.calls[0][0]).toContain("c.status='sealed'")
    expect((await getTokenSessionAnalytics({query} as any,1,input,false)).scope.basis).toBe('retained_events')
  })
})

function teamPool(role='admin',targetUser=3){
  let target={membership_id:'m',team_id:'t',user_id:targetUser,role:'member',state:'active',revision:4,joined_at:'2026-10-01',ended_at:null}
  const query=vi.fn(async(sql:string,args:any[]=[])=>{
    if(sql.includes('SELECT id, team_enabled'))return {rows:[{id:args[0][0],team_enabled:true}]}
    if(sql.includes('SELECT request_hash'))return {rows:[]}
    if(sql.includes('SELECT t.team_id'))return {rows:[{team_id:'t',creator_user_id:1,state:'active',revision:8}]}
    if(sql.includes('SELECT creator_user_id'))return {rows:[{creator_user_id:1}]}
    if(sql.includes('SELECT role FROM'))return {rows:[{role}]}
    if(sql.includes('SELECT * FROM collaboration_team_memberships'))return {rows:[target]}
    if(sql.includes('UPDATE collaboration_team_memberships SET role')){target={...target,role:args[1],revision:5};return {rows:[target]}}
    if(sql.includes('FROM users WHERE id'))return {rows:[{display_name:'Member',email:'m@example.test'}]}
    if(sql.includes('SELECT session.*, member.role'))return {rows:[{team_id:'t',actor_team_role:role}]}
    return {rows:[]}
  })
  return {pool:{query,connect:async()=>({query,release(){}})} as any,query}
}
describe('Team role boundaries',()=>{
  test('admin changes a role with revision and audit; protects creator and rejects stale writes',async()=>{
    const input={teamId:'t',membershipId:'m',actorUserId:2,role:'viewer' as const,expectedRevision:4,requestId:'r'}
    const {pool,query}=teamPool();expect(await new TeamRepository(pool).changeMemberRole(input)).toMatchObject({role:'viewer',revision:5})
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO collaboration_role_audit'))).toBe(true)
    await expect(new TeamRepository(teamPool('member').pool).changeMemberRole(input)).rejects.toMatchObject({code:'team_access_denied'})
    await expect(new TeamRepository(teamPool('admin',1).pool).changeMemberRole(input)).rejects.toMatchObject({code:'invalid_state'})
    await expect(new TeamRepository(teamPool().pool).changeMemberRole({...input,expectedRevision:2})).rejects.toMatchObject({code:'revision_conflict'})
  })
  test('viewer cannot create tasks or append discussion messages',async()=>{
    const {pool,query}=teamPool('viewer')
    await expect(new TeamTaskService(pool).createTask({teamId:'t',actorUserId:2,title:'task',background:'',requestId:'a'})).rejects.toMatchObject({code:'team_access_denied'})
    await expect(new TeamSessionService(pool).appendMessage({sessionId:'s',actorUserId:2,requestId:'b',content:'test',targetMode:'discussion',targetOfferIds:[],referenceEventId:null})).rejects.toMatchObject({code:'team_access_denied'})
    expect(query.mock.calls.some(([sql])=>sql.includes('INSERT INTO team_tasks')||sql.includes('INSERT INTO collaboration_events'))).toBe(false)
  })
})
