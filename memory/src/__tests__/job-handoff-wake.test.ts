import {beforeEach,afterEach,test,expect,vi} from 'vitest'
import {createJobWorker} from '../jobs/worker.js'
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers())
function fixture(){
 const claimJobs=vi.fn(async()=>[]),controller=new AbortController(),errors:unknown[]=[]
 const worker=createJobWorker({pool:{}as any,jobs:{claimJobs}as any,workerId:'wake-worker',signal:controller.signal,onError:e=>errors.push(e)})
 return{worker,claimJobs,controller,errors}
}
test('durable dispatch wake claims immediately with the original default periodic interval',async()=>{
 const f=fixture();f.worker.start();try{(f.worker as any).wake();await vi.advanceTimersByTimeAsync(1);expect(f.claimJobs).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(499);expect(f.claimJobs).toHaveBeenCalledTimes(2)}finally{await f.worker.stop()}
})
test('hints before start and after stop or abort never open admission',async()=>{
 const f=fixture();(f.worker as any).wake();await vi.advanceTimersByTimeAsync(1);expect(f.claimJobs).not.toHaveBeenCalled();f.worker.start();await f.worker.stop();(f.worker as any).wake();await vi.advanceTimersByTimeAsync(1000);expect(f.claimJobs).not.toHaveBeenCalled()
 const g=fixture();g.worker.start();g.controller.abort();(g.worker as any).wake();await vi.advanceTimersByTimeAsync(1);expect(g.claimJobs).not.toHaveBeenCalled();await g.worker.stop()
})
test('many concurrent hints during a physical claim coalesce into one fresh subsequent claim',async()=>{
 const f=fixture();let release!:(x:any)=>void;f.claimJobs.mockImplementationOnce(()=>new Promise(r=>{release=r}));f.worker.start();try{
 (f.worker as any).wake();await vi.advanceTimersByTimeAsync(1);expect(f.claimJobs).toHaveBeenCalledOnce();for(let n=0;n<50;n++)(f.worker as any).wake();await vi.advanceTimersByTimeAsync(1);expect(f.claimJobs).toHaveBeenCalledOnce();release([]);await vi.advanceTimersByTimeAsync(1);expect(f.claimJobs).toHaveBeenCalledTimes(2);expect(f.errors).toEqual([])
 }finally{release?.([]);await f.worker.stop()}
})
