import {expect,test,vi} from 'vitest'
import {wakeCompletedPersonalProjection} from '../sources/projection-job-handoff.js'
const job=()=>({job_type:'project_shared_source',installation_id:'installation',payload:{scope:{installationId:'installation',ownerScopeKind:'personal'},root:{kind:'relay_event',key:'1:session'}}}as any)
test('acknowledged completed personal projection hints only its normalized root',()=>{
 const j=job(),wake=vi.fn();wakeCompletedPersonalProjection(j,'completed',wake)
 expect(wake).toHaveBeenCalledOnce();expect(wake).toHaveBeenCalledWith({kind:'relay_event',key:'1:session'})
 j.payload.root.key='mutated';expect(wake.mock.calls[0][0].key).toBe('1:session')
})
test.each(['deferred','failed','lost'])('%s never publishes a completion hint',outcome=>{const wake=vi.fn();wakeCompletedPersonalProjection(job(),outcome,wake);expect(wake).not.toHaveBeenCalled()})
test.each(['other-job','organization','installation-mismatch','team-root','empty-key','oversize-key','null-payload'])('%s cannot generate personal completion work',kind=>{
 const j=job(),wake=vi.fn()
 if(kind==='other-job')j.job_type='compile_episode'
 if(kind==='organization')j.payload.scope.ownerScopeKind='organization'
 if(kind==='installation-mismatch')j.payload.scope.installationId='other'
 if(kind==='team-root')j.payload.root.kind='team_collaboration'
 if(kind==='empty-key')j.payload.root.key=''
 if(kind==='oversize-key')j.payload.root.key='x'.repeat(1025)
 if(kind==='null-payload')j.payload=null
 wakeCompletedPersonalProjection(j,'completed',wake);expect(wake).not.toHaveBeenCalled()
})
