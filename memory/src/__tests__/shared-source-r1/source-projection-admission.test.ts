import {expect,test,vi,beforeEach} from 'vitest'
import {canonicalPayloadHash} from '@pocketctl/session-source'
const fixtures=vi.hoisted(()=>({states:new Map<string,any>()}))
vi.mock('../../sources/observed-reader.js',()=>({createObservedSourceReader:()=>({checkCurrent:async(scope:any)=>fixtures.states.get(scope.principalUserId)})}))
import {prepareSourceProjectionAdmission} from '../../sources/source-projection-admission.js'
// The trusted-seal combinator is tested independently of native enumeration.
// Raw Team roots no longer admit business input through this personal port.
const scope={installationId:'installation',principalUserId:'1',ownerScopeKind:'personal' as const,ownerScopeId:'installation',authorizationRevision:'1',configVersion:'1',modeGeneration:'2'}
const root={kind:'relay_event' as const,key:'1:session'},version={content:'1',authorization:'2',storage:'3'}
beforeEach(()=>fixtures.states.clear())
function fixture(){
 const scopes=[scope,{...scope,principalUserId:'2'}]
 const targets=scopes.map((source_scope,i)=>({cursor_key:String(i+1),source_scope,source_version:version,target_mode:'shared-active',state:'current'}))
 const progress=new Map(scopes.map(s=>[canonicalPayloadHash(s).toString('hex'),{state:'ready',source_version:version}]))
 const seal={scanId:'scan',controlRevision:'1',workRevision:'1',targetCount:'2'}
 fixtures.states.set('1',{state:'current',version});fixtures.states.set('2',{state:'current',version})
 const queries:string[]=[]
 const pool={query:async(sql:string,args:any[])=>{queries.push(sql)
  if(sql.includes('current_memory_source_distribution'))return {rows:[{seal}]}
  if(sql.includes('read_memory_source_context_set'))return {rows:targets}
  if(sql.includes('memory_canonical_projection_progress'))return {rows:progress.has(args[3])?[progress.get(args[3])]:[]}
  throw Error('unexpected_query')
 }}
 return {pool:pool as never,targets,progress,seal,queries}
}
test('all current principals need current projection, including the principal whose UUID was not selected',async()=>{
 const f=fixture();f.progress.delete(canonicalPayloadHash({...scope,principalUserId:'2'}).toString('hex'))
 await expect(prepareSourceProjectionAdmission(f.pool,scope,root)).rejects.toThrow('source_not_ready')
})
test.each(['team_collaboration','team_delivery'] as const)('raw %s cannot obtain business admission or run preparation SQL',async kind=>{
 const f=fixture()
 await expect(prepareSourceProjectionAdmission(f.pool,scope,{kind,key:'raw-team'})).rejects.toThrow('team_raw_business_input_forbidden')
 expect(f.queries).toEqual([])
})
test('a sealed revoked candidate remains metadata without blocking valid principals or granting itself admission',async()=>{
 const f=fixture();f.targets[1].state='revoked';f.progress.delete(canonicalPayloadHash(f.targets[1].source_scope).toString('hex'))
 const prepared=await prepareSourceProjectionAdmission(f.pool,scope,root)
 expect(prepared.observations).toHaveLength(1)
 expect(()=>prepared.requireScope({...scope,principalUserId:'3'})).toThrow('source_not_ready')
 await expect(prepareSourceProjectionAdmission(f.pool,f.targets[1].source_scope,root)).rejects.toThrow('source_not_ready')
 f.targets[1].state='unknown'
 await expect(prepareSourceProjectionAdmission(f.pool,scope,root)).rejects.toThrow('source_not_ready')
})
test('commit repeats the whole seal and every ready receipt, while storage-only cooling preserves derived readiness',async()=>{
 const f=fixture();fixtures.states.set('2',{state:'current',version:{...version,storage:'4'}})
 const prepared=await prepareSourceProjectionAdmission(f.pool,scope,root)
 expect(prepared.observations[1].version.storage).toBe('4')
 await prepared.assertCurrent(f.pool)
 expect(f.queries.some(q=>q.includes('FOR SHARE NOWAIT'))).toBe(true)
 f.progress.get(canonicalPayloadHash(f.targets[1].source_scope).toString('hex'))!.state='scanning'
 await expect(prepared.assertCurrent(f.pool)).rejects.toThrow('source_not_ready')
 f.progress.get(canonicalPayloadHash(f.targets[1].source_scope).toString('hex'))!.state='ready'
 f.seal.workRevision='2'
 await expect(prepared.assertCurrent(f.pool)).rejects.toThrow('source_not_ready')
})
