import {beforeEach,expect,test,vi} from 'vitest'
import {SourceUnavailableError} from '@pocketctl/session-source'
import {JobDeferredError} from '../../jobs/types.js'
const io=vi.hoisted(()=>({select:vi.fn(),resolve:vi.fn(),proof:vi.fn(),seal:vi.fn(),execution:{token:{}},generic:vi.fn()}))
vi.mock('../../sources/observed-reader.js',()=>({createObservedSourceReader:()=>({getHeads:io.generic}),createObservedPersonalMetadataReader:()=>({selectKeys:io.select,resolve:io.resolve,proof:io.proof})}))
vi.mock('../../sources/pool-context.js',()=>({sourcePoolContext:()=>({namespace:'memory'}),sourceConnectionKey:(pool:unknown)=>pool}))
vi.mock('../../sources/source-execution.js',()=>({metadataSourceExecution:()=>io.execution,sourceExecutionBranchFor:()=> 'canonical-active',guardSourceExecutionCommit:vi.fn()}))
vi.mock('../../sources/source-projection-admission.js',()=>({prepareMetadataScope:io.seal,personalMetadataEnvelope:vi.fn(),prepareSourceProjectionAdmission:vi.fn()}))
import {prepareEpisodeProjectionSources} from '../../sources/prepared-sources.js'
const id='10000000-0000-0000-0000-000000000001',scope={installationId:'installation',ownerScopeKind:'personal'},root={kind:'relay_event',key:'1:session'}
function fixture(){
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('SELECT to_jsonb(t)'))return {rows:[{snapshot:{terminal_at:'2026-11-11'}}],rowCount:1}
  if(sql.includes('source_kind IS DISTINCT'))return {rows:[],rowCount:0}
  if(sql.includes('FROM shared.memory_source_modes'))return {rows:[{mode:'shared-active',generation:'3'}],rowCount:1}
  if(sql.includes('shared.memory_source_ref_context'))return {rows:[{source_event_id:id,context:{scope,root}}],rowCount:1}
  if(sql.includes('xmin::text AS row_version'))return {rows:[{source_event_id:id,mapping_state:'verified',source_kind:'relay_event',canonical_key:'1',body_reclaimed_at:null}],rowCount:1}
  return {rows:[{source_event_id:id}],rowCount:1}
 });return {query,run:()=>prepareEpisodeProjectionSources({query}as any,'installation','turn')}
}
beforeEach(()=>{vi.clearAllMocks();io.select.mockResolvedValue({heads:[],observedVersion:{}});io.seal.mockResolvedValue({})})
test.each(['selection','body'])('typed invalidation during %s yields before episode output without retry',async phase=>{
 const changed=new SourceUnavailableError('changed');if(phase==='selection')io.select.mockRejectedValueOnce(changed);else io.resolve.mockRejectedValueOnce(changed)
 const f=fixture(),error=await f.run().catch(e=>e)
 expect(error).toBeInstanceOf(JobDeferredError);expect(error.reason).toBe('source_not_ready');expect(error.availableAt.getTime()-Date.now()).toBeGreaterThan(900)
 expect(io.select).toHaveBeenCalledOnce();expect(io.resolve).toHaveBeenCalledTimes(phase==='selection'?0:1);expect(io.proof).not.toHaveBeenCalled();expect(io.generic).not.toHaveBeenCalled()
 expect(f.query.mock.calls.some(([sql])=>/BEGIN|INSERT|UPDATE|COMMIT/.test(sql))).toBe(false)
})
test.each([new SourceUnavailableError('revoked'),new SourceUnavailableError('missing'),Error('unknown IO'),Object.assign(Error('source_metadata_scan_changed'),{code:'P0001'}),Error('source_reference_hash_mismatch')])('other failures retain their original identity: %s',async failure=>{
 io.resolve.mockRejectedValueOnce(failure);const f=fixture();await expect(f.run()).rejects.toBe(failure);expect(io.select).toHaveBeenCalledOnce();expect(io.resolve).toHaveBeenCalledOnce();expect(io.proof).not.toHaveBeenCalled()
})
