import { afterEach,beforeEach,expect,test,vi } from 'vitest'
import { ref } from 'vue'
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({accessToken:ref('relay-user-token')})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'https://relay.example'}))
const {resetMemoryClient}=await import('../memoryClient')
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})
beforeEach(()=>resetMemoryClient())
afterEach(()=>vi.unstubAllGlobals())
test('Git uses selected scope/service grants and preserves BIGINT revisions/idempotency across auth refresh',async()=>{
  const module=await import('../memoryGit').catch(()=>null)
  expect(module,'Git scoped transport exists').not.toBeNull()
  const calls:Array<{url:string;init:RequestInit}>=[];let writes=0
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
    calls.push({url,init})
    if(url.includes('/grants'))return json({grant:'scope-grant',expires_in:60,provider_public_origin:'https://memory.example'})
    if(init.method==='POST'&&++writes===1)return json({error:{code:'expired'}},401)
    return json({items:[]})
  }))
  const signal=new AbortController().signal
  await module!.memoryGit.connections('team-installation',undefined,signal)
  await module!.memoryGit.review('team-installation','proposal',{expected_generation:'9007199254740993',expected_revision:'9007199254740995',expected_policy_hash:'a'.repeat(64),expected_proposed_hash:'b'.repeat(64),expected_asset_revision:'9007199254740997',decision:'approve'},'stable-action',signal)
  const grants=calls.filter(c=>c.url.includes('/grants')).map(c=>JSON.parse(String(c.init.body)))
  expect(grants).toEqual([{installation_ids:['team-installation'],caller_type:'web',services:['memory.search']},{installation_ids:['team-installation'],caller_type:'web',services:['memory.manage']},{installation_ids:['team-installation'],caller_type:'web',services:['memory.manage']}])
  const mutations=calls.filter(c=>c.url.endsWith('/reviews'))
  expect(mutations).toHaveLength(2)
  for(const call of mutations){expect(new Headers(call.init.headers).get('idempotency-key')).toBe('stable-action');expect(JSON.parse(String(call.init.body)).expected_revision).toBe('9007199254740995');expect(call.init.signal).toBe(signal)}
})
test('Git transport preserves forbidden and temporary failure instead of returning empty lists',async()=>{
  const module=await import('../memoryGit').catch(()=>null);expect(module).not.toBeNull()
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/grants')?json({grant:'grant',expires_in:60,provider_public_origin:'https://memory.example'}):json({error:{code:'forbidden'}},403)))
  await expect(module!.memoryGit.connections('team')).rejects.toMatchObject({status:403,code:'forbidden'})
})
test('Git child lists keep scope read service and independent bounded cursors',async()=>{
  const {memoryGit}=await import('../memoryGit'),urls:string[]=[]
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(url);return url.includes('/grants')?json({grant:'grant',expires_in:60,provider_public_origin:'https://memory.example'}):json({items:[],next_cursor:null,total:0})}))
  expect(memoryGit.proposals).toBeTypeOf('function');expect(memoryGit.cleanup).toBeTypeOf('function')
  await memoryGit.proposals('team','connection','proposal-cursor')
  await memoryGit.cleanup('team','connection','cleanup-cursor')
  expect(urls.filter(url=>!url.includes('/grants'))).toEqual(['https://memory.example/api/v1/memory/git/connections/connection/proposals?limit=20&cursor=proposal-cursor','https://memory.example/api/v1/memory/git/connections/connection/cleanup?limit=50&cursor=cleanup-cursor'])
})
