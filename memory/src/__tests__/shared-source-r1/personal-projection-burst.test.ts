import type pg from 'pg'
import {afterEach,beforeEach,test,expect,vi} from 'vitest'
import {JobDeferredError} from '../../jobs/types.js'
import {SourceUnavailableError} from '@pocketctl/session-source'
const io=vi.hoisted(()=>({prepare:vi.fn(),persist:vi.fn(),scope:vi.fn(),genericPrepare:vi.fn(),genericPersist:vi.fn(),team:vi.fn(),teamPersist:vi.fn(),load:vi.fn(),check:vi.fn(),require:vi.fn(),branch:vi.fn(),shadow:vi.fn(),current:vi.fn(),completeReady:vi.fn()}))
vi.mock('../../sources/canonical-references.js',()=>({preparePersonalMetadataReferencePage:io.prepare,persistPersonalMetadataReferencePage:io.persist,prepareCanonicalReferencePage:io.genericPrepare,persistCanonicalReferencePage:io.genericPersist,completeReadyCanonicalProjection:io.completeReady}))
vi.mock('../../sources/observed-reader.js',()=>({createObservedSourceReader:()=>({checkCurrent:io.current})}))
vi.mock('../../sources/source-projection-admission.js',()=>({prepareMetadataScope:io.scope}))
vi.mock('../../sources/source-context-set.js',()=>({loadSourceContextSet:io.load,checkSourceContextSet:io.check,requireSourceContext:io.require}))
vi.mock('../../sources/source-execution.js',()=>({sourceExecutionBranchFor:io.branch}))
vi.mock('../../sources/team-semantic-publication.js',()=>({prepareTeamSemanticPublication:io.team,persistTeamSemanticPublication:io.teamPersist}))
vi.mock('../../sources/canonical-shadow-worker.js',()=>({createCanonicalShadowHandler:()=>io.shadow}))
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
const inst='20000000-0000-0000-0000-000000000011',scope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'3'},root={kind:'relay_event',key:'1:session'},scan='20000000-0000-0000-0000-000000000012',seal={targetCursor:'cursor',controlRevision:'1'}
beforeEach(()=>{vi.useFakeTimers({toFake:['performance','Date']});Object.values(io).forEach(f=>f.mockReset());io.branch.mockReturnValue('canonical-active');io.scope.mockResolvedValue(seal);io.load.mockResolvedValue({});io.prepare.mockImplementation(async()=>({token:{},count:1,hasMore:true}));io.persist.mockResolvedValue({contextReady:false});io.genericPrepare.mockResolvedValue({token:{},count:1,hasMore:true});io.genericPersist.mockResolvedValue([])})
afterEach(()=>vi.useRealTimers())
function fixture(progresses:any[]=[undefined,{state:'scanning',next_cursor:'1',source_version:{content:'1'}},{state:'scanning',next_cursor:'2',source_version:{content:'1'}},{state:'scanning',next_cursor:'3',source_version:{content:'1'}}]){
 let n=0;const pool={query:vi.fn(async()=>{const p=progresses[Math.min(n++,progresses.length-1)];return{rows:p?[structuredClone(p)]:[]}})}as unknown as pg.Pool,controller=new AbortController()
 const job:any={job_type:'project_shared_source',installation_id:inst,payload:{scope,root,distribution_scan:scan,target_cursor:'cursor'}}
 return{pool,controller,job,run:()=>createCanonicalProjectionHandler(pool)(job,controller.signal,{fence:{}as any})}
}
test('three durable finite pages finish within one original metadata job claim',async()=>{
 const f=fixture();io.persist.mockResolvedValueOnce({contextReady:false}).mockResolvedValueOnce({contextReady:false}).mockResolvedValueOnce({contextReady:true})
 await f.run();expect(io.prepare).toHaveBeenCalledTimes(3);expect(io.persist).toHaveBeenCalledTimes(3);expect(io.scope).toHaveBeenCalledOnce()
 expect(io.prepare.mock.calls.map(c=>c[4]?.next_cursor)).toEqual([undefined,'1','2']);expect(io.prepare.mock.calls.every(c=>c[3]===seal)).toBe(true)
})
test('at most four advancing pages precede the unchanged one-second defer',async()=>{
 const f=fixture([undefined,...Array.from({length:5},(_,n)=>({state:'scanning',next_cursor:String(n+1),source_version:{content:'1'}}))])
 const error=await f.run().catch(e=>e);expect(error).toMatchObject({reason:'source_not_ready'});expect(io.persist).toHaveBeenCalledTimes(4)
 expect(error.availableAt.getTime()-Date.now()).toBe(1000)
})
test('slow successful first page respects the one-second cooperative continuation bound',async()=>{
 vi.useFakeTimers({toFake:['performance','Date','setTimeout','clearTimeout']});const f=fixture();io.persist.mockImplementation(async()=>{await vi.advanceTimersByTimeAsync(1001);return{contextReady:false}})
 const error=await f.run().catch(e=>e);expect(error).toBeInstanceOf(JobDeferredError);expect(io.prepare).toHaveBeenCalledOnce();expect(error.availableAt.getTime()-Date.now()).toBe(1000)
})
test('unchanged committed progress does not spin or invent another page',async()=>{
 const p={state:'scanning',next_cursor:'fixed',source_version:{content:'1'}},f=fixture([p,p])
 await expect(f.run()).rejects.toBeInstanceOf(JobDeferredError);expect(io.persist).toHaveBeenCalledOnce()
})
test.each([undefined,{state:'ready',next_cursor:null,source_version:{content:'2'}}])('disappearing or replaced durable progress cannot restart the old scan: %s',async next=>{
 const p={state:'scanning',next_cursor:'fixed',source_version:{content:'1'}},f=fixture([p,next])
 await expect(f.run()).rejects.toThrow('canonical_reference_cursor_changed');expect(io.persist).toHaveBeenCalledOnce()
})
test('privacy denial on a later fresh page propagates and never refreshes the old scope seal',async()=>{
 const f=fixture(),denied=new SourceUnavailableError('revoked');io.prepare.mockResolvedValueOnce({token:{},count:1,hasMore:true}).mockRejectedValueOnce(denied)
 await expect(f.run()).rejects.toBe(denied);expect(io.persist).toHaveBeenCalledOnce();expect(io.scope).toHaveBeenCalledOnce()
})
test('a later busy or unknown result is never treated as another successful page',async()=>{
 const f=fixture(),busy=new JobDeferredError('source_not_ready',new Date(Date.now()+1000));io.persist.mockResolvedValueOnce({contextReady:false}).mockRejectedValueOnce(busy)
 await expect(f.run()).rejects.toBe(busy);expect(io.prepare).toHaveBeenCalledTimes(2);expect(io.persist).toHaveBeenCalledTimes(2)
})
test('abort after a committed page forbids the next progress read and body IO',async()=>{
 const f=fixture();io.persist.mockImplementation(async()=>{f.controller.abort();return{contextReady:false}})
 await expect(f.run()).rejects.toThrow('canonical_projection_aborted');expect(io.prepare).toHaveBeenCalledOnce();expect(f.pool.query).toHaveBeenCalledOnce()
})
test('generic Team and shadow execution retain their existing single-page handlers',async()=>{
 const f=fixture();f.job.payload.root={kind:'team_collaboration',key:'team:1'};await expect(f.run()).rejects.toBeInstanceOf(JobDeferredError)
 expect(io.prepare).not.toHaveBeenCalled();expect(io.genericPrepare).toHaveBeenCalledOnce();expect(io.genericPersist).toHaveBeenCalledOnce()
 const g=fixture();io.branch.mockReturnValue('canonical-shadow');await g.run();expect(io.shadow).toHaveBeenCalledOnce();expect(io.prepare).not.toHaveBeenCalled()
})

test('only positive personal context-ready completion hints the source producer',async()=>{
 const ready=vi.fn(),f=fixture();io.persist.mockResolvedValueOnce({contextReady:true});await createCanonicalProjectionHandler(f.pool,{onReady:ready} as any)(f.job,f.controller.signal,{}as any);expect(ready).toHaveBeenCalledWith(root)
 const g=fixture();io.persist.mockRejectedValueOnce(Error('unknown_commit'));await expect(createCanonicalProjectionHandler(g.pool,{onReady:ready}as any)(g.job,g.controller.signal,{}as any)).rejects.toThrow('unknown_commit');expect(ready).toHaveBeenCalledOnce()
})

test('current ready personal progress survives storage-only change without opening source bodies',async()=>{
 const version={content:'1',authorization:'1',storage:'1'},current={...version,storage:'2'}
 const f=fixture([{state:'ready',next_cursor:null,source_version:version}])
 io.current.mockResolvedValue({state:'current',version:current});io.completeReady.mockResolvedValue(true)
 await f.run()
 expect(io.completeReady).toHaveBeenCalledWith(f.pool,scope,root,current,{deferMs:1000})
 expect(io.prepare).not.toHaveBeenCalled()
 expect(io.persist).not.toHaveBeenCalled()
})
test('ready personal progress whose installation watermark cannot be confirmed uses a fresh page',async()=>{
 const version={content:'1',authorization:'1',storage:'1'},f=fixture([{state:'ready',next_cursor:null,source_version:version}])
 io.current.mockResolvedValue({state:'current',version});io.completeReady.mockResolvedValue(false)
 io.persist.mockResolvedValueOnce({contextReady:true})
 await f.run()
 expect(io.completeReady).toHaveBeenCalledOnce()
 expect(io.prepare).toHaveBeenCalledOnce()
 expect(io.persist).toHaveBeenCalledOnce()
})
test('a newer content revision cannot complete an old ready checkpoint',async()=>{
 const version={content:'1',authorization:'1',storage:'1'},f=fixture([{state:'ready',next_cursor:null,source_version:version}])
 io.current.mockResolvedValue({state:'current',version:{...version,content:'2'}})
 io.persist.mockResolvedValueOnce({contextReady:true})
 await f.run()
 expect(io.completeReady).not.toHaveBeenCalled()
 expect(io.prepare).toHaveBeenCalledOnce()
})
test('an authority denial before ready recovery prevents watermark completion and body reads',async()=>{
 const version={content:'1',authorization:'1',storage:'1'},f=fixture([{state:'ready',next_cursor:null,source_version:version}])
 io.current.mockResolvedValue({state:'revoked'})
 await expect(f.run()).rejects.toMatchObject({code:'revoked'})
 expect(io.completeReady).not.toHaveBeenCalled()
 expect(io.prepare).not.toHaveBeenCalled()
})
test('explicit changed metadata input waits with original delay and no inline proof retry',async()=>{
 const f=fixture(),changed=new SourceUnavailableError('changed');io.prepare.mockRejectedValueOnce(changed)
 const error=await f.run().catch(e=>e);expect(error).toBeInstanceOf(JobDeferredError);expect(error.reason).toBe('source_not_ready');expect(error.availableAt.getTime()-Date.now()).toBe(1000);expect(io.prepare).toHaveBeenCalledOnce();expect(io.persist).not.toHaveBeenCalled();expect(io.scope).toHaveBeenCalledOnce()
})

test('realistic 201ms successful pages complete full tail full work within one original claim',async()=>{
 const f=fixture();let n=0;io.persist.mockImplementation(async()=>{await vi.advanceTimersByTimeAsync(201);return{contextReady:++n===3}})
 await f.run();expect(io.prepare).toHaveBeenCalledTimes(3);expect(io.scope).toHaveBeenCalledOnce();expect(performance.now()).toBe(603)
})
test('elapsed successful-page work stops before fourth IO after the one-second budget is spent',async()=>{
 const f=fixture();io.persist.mockImplementation(async()=>{await vi.advanceTimersByTimeAsync(450);return{contextReady:false}})
 await expect(f.run()).rejects.toBeInstanceOf(JobDeferredError);expect(io.prepare).toHaveBeenCalledTimes(3);expect(performance.now()).toBe(1350)
})
