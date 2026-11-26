import { describe, expect, it, vi } from 'vitest'
import { Router } from '../router.js'
import { classifyDaemonEvent } from '../ingress/event-policy.js'
import { publicAdoption, validAdoptionCommand } from '../session-adoption.js'

function socket(): any {
  return { readyState:1, sent:[] as any[], send(raw:string) { this.sent.push(JSON.parse(raw)) } }
}
function fixture() {
  let owner = true, team = false
  const row = { daemon_id:'host', agent_type:'codex', source:'terminal', parent_session_id:null, is_subagent:false }
  const query = vi.fn(async (sql:string, values:unknown[]) => ({
    rows: sql.includes('JOIN daemons') ? (owner && values[0] === 'session' && values[1] === 9 ? [{...row,has_team_binding:team}] : []) : [],
  }))
  const router = new Router({query} as any), r = router as any
  const client=socket(), peer=socket(), host=socket()
  router.registerClient(client,9); router.registerClient(peer,9)
  r.daemons.set('host',{ws:host,userId:9,supportsSessionAdoption:true})
  const command=(type='session_adopt_status', fields={})=>router.handleClientMessage(client,{type,session_id:'session',request_id:'r1',...fields})
  return {router,r,client,peer,host,query,row,command,revoke:()=>{owner=false},makeTeam:()=>{team=true}}
}
describe('native session adoption routing',()=>{
  it('rejects alternate targets, mode confusion, excessive waits and missing cancel operation',()=>{
    const cmd={type:'session_adopt',session_id:'s',request_id:'r'}
    for(const bad of [{daemon_id:'other'},{socket:'/tmp/sock'},{adoption_request_id:'spoof'},{wait_ms:120001},{wait_ms:-1},{wait_ms:1.25},{unarchive:'true'},{operation_id:'x'},{session_id:'pending-2'},{session_id:'../../rollout'}])
      expect(validAdoptionCommand({...cmd,...bad})).toBe(false)
    expect(validAdoptionCommand({...cmd,type:'session_adopt_cancel'})).toBe(false)
    expect(validAdoptionCommand({...cmd,type:'session_adopt_status',unarchive:true})).toBe(false)
    expect(validAdoptionCommand({...cmd,type:'session_adopt_cancel',operation_id:'op1'})).toBe(true)
  })
  it('checks current host and session ownership for status, start and cancel',async()=>{
    const f=fixture()
    for(const type of ['session_adopt','session_adopt_status','session_adopt_cancel'])
      await f.command(type,{session_id:'other',...(type==='session_adopt_cancel'?{operation_id:'op'}:{})})
    expect(f.host.sent).toHaveLength(0)
    expect(f.client.sent.map((v:any)=>v.error)).toEqual(['forbidden','forbidden','forbidden'])
    f.r.daemons.get('host').supportsSessionAdoption=false
    await f.command()
    expect(f.client.sent.at(-1).error).toBe('daemon_upgrade_required')
    f.r.daemons.delete('host')
    await f.command()
    expect(f.client.sent.at(-1).error).toBe('daemon_offline')
  })
  it('never forwards observation, child or Team sessions',async()=>{
    const f=fixture()
    f.row.source='observer'; await f.command()
    f.row.source='terminal';f.row.agent_type='codex-desktop';await f.command()
    f.row.agent_type='codex';f.row.is_subagent=true;await f.command()
    f.row.is_subagent=false;f.makeTeam();await f.command()
    expect(f.client.sent.map((x:any)=>x.error)).toEqual(Array(4).fill('unsupported_source'))
    expect(f.host.sent).toHaveLength(0)
  })
  it('returns only the sanitized receipt to its requester and rechecks revocation',async()=>{
    const f=fixture()
    const response=(id:string)=>({type:'session_adoption_result',request_id:id,session_id:'session',adoption:{
      version:1,session_id:'session',operation_id:'op',phase:'waiting',revision:2,reason:'active_writer',allowed_actions:['cancel','exec'],home:'/secret',error:'raw'}})
    await f.command('session_adopt',{wait_ms:120000})
    const id=f.host.sent[0].request_id
    expect(f.host.sent[0]).toMatchObject({type:'session_adopt',adoption_request_id:'r1',session_id:'session',wait_ms:120000})
    expect(id).not.toBe('r1')
    f.router.handleDaemonMessage('other',response(id))
    expect(f.client.sent).toHaveLength(0)
    f.router.handleDaemonMessage('host',response(id))
    await vi.waitFor(()=>expect(f.client.sent).toHaveLength(1))
    expect(f.client.sent[0]).toMatchObject({request_id:'r1',adoption:{allowed_actions:['cancel']}})
    expect(JSON.stringify(f.client.sent)).not.toContain('/secret')
    expect(f.peer.sent).toHaveLength(0)
    expect(classifyDaemonEvent(response(id)).durable).toBe(false)
    await f.command('session_adopt_status',{operation_id:'op'})
    f.revoke()
    f.router.handleDaemonMessage('host',response(f.host.sent[1].request_id))
    await vi.waitFor(()=>expect(f.client.sent.at(-1).error).toBe('forbidden'))
  })
  it('pauses new remote work while retaining status and operation-specific cancel',async()=>{
    vi.stubEnv('RELAY_CODEX_SESSION_ADOPTION_START','off')
    try {
      const f=fixture()
      await f.command('session_adopt',{unarchive:true,wait_ms:120000})
      expect(f.host.sent).toHaveLength(0)
      expect(f.client.sent[0].error).toBe('remote_start_paused')
      await f.command()
      f.router.handleDaemonMessage('host',{type:'session_adoption_result',request_id:f.host.sent[0].request_id,session_id:'session',
        adoption:{version:1,session_id:'session',revision:7,phase:'waiting',reason:'active_writer',operation_id:'op',allowed_actions:['cancel','wait']}})
      await vi.waitFor(()=>expect(f.client.sent.at(-1).adoption).toMatchObject({start_enabled:false,allowed_actions:['cancel'],operation_id:'op',revision:7}))
      await f.command('session_adopt_cancel',{operation_id:'op'})
      expect(f.host.sent.at(-1)).toMatchObject({type:'session_adopt_cancel',operation_id:'op'})
    } finally { vi.unstubAllEnvs() }
  })
  it('rejects mismatched reply identities and disables unknown reasons',()=>{
    for (const phase of ['checking','binding']) {
      expect(publicAdoption({version:1,session_id:'s',operation_id:'op',phase,reason:'',revision:2,allowed_actions:null},'s'))
        .toMatchObject({version:1,phase,reason:'',allowed_actions:[]})
    }
    for (const version of [undefined,0,2]) {
      expect(publicAdoption({version,session_id:'s',phase:'managed',reason:'managed',revision:1,local_managed:true,remote_ready:true},'s')).toBeNull()
    }
    expect(publicAdoption({version:1,session_id:'s',phase:'future',reason:'managed',revision:1,local_managed:true,remote_ready:true},'s')).toBeNull()
    expect(publicAdoption({version:1,session_id:'other',phase:'available',revision:0},'s')).toBeNull()
    expect(publicAdoption({version:1,session_id:'s',phase:'managed',revision:0,reason:'new',local_managed:true,remote_ready:true,allowed_actions:['adopt']},'s'))
      .toMatchObject({phase:'blocked',reason:'unverified',allowed_actions:[],local_managed:false,remote_ready:false})
  })
})
