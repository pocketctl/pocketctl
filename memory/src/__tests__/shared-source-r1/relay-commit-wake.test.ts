import {EventEmitter} from 'node:events'
import type pg from 'pg'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {createRelayCommitWakeListener} from '../../sources/relay-commit-wake.js'
import {bindSourcePool,registerPhysicalSourcePool} from '../../sources/pool-context.js'
let stops:(()=>Promise<void>)[]=[]
beforeEach(()=>{vi.useFakeTimers();stops=[]});afterEach(async()=>{for(const stop of stops)await stop();vi.useRealTimers()})
function client(){return Object.assign(new EventEmitter(),{query:vi.fn(async(_sql:string)=>({rows:[]})),release:vi.fn()})}
function fixture(max=5){const c=client(),pool={options:{max},connect:vi.fn(async()=>c)}as unknown as pg.Pool;bindSourcePool(pool,{namespace:'memory'});registerPhysicalSourcePool(pool);const controller=new AbortController(),wake=vi.fn(),errors:unknown[]=[],listener=createRelayCommitWakeListener({pool,signal:controller.signal,wake,onError:e=>errors.push(e)});stops.push(listener.stop);return{c,pool,controller,wake,errors,listener}}
test('one existing-pool subscription ignores payload and only hints matching COMMIT channel',async()=>{
 const f=fixture();await f.listener.start();await f.listener.start();expect(f.pool.connect).toHaveBeenCalledOnce();expect(f.c.query).toHaveBeenCalledExactlyOnceWith('LISTEN pocketctl_realtime');f.wake.mockClear()
 f.c.emit('notification',{channel:'foreign'});f.c.emit('notification',{channel:'pocketctl_realtime',get payload(){throw Error('payload_must_not_be_read')}});expect(f.wake).toHaveBeenCalledExactlyOnceWith();expect(f.errors).toEqual([])
 await f.listener.stop();await f.listener.stop();expect(f.c.query).toHaveBeenLastCalledWith('UNLISTEN pocketctl_realtime');expect(f.c.release).toHaveBeenCalledExactlyOnceWith();f.c.emit('notification',{channel:'pocketctl_realtime'});expect(f.wake).toHaveBeenCalledOnce()
})
test('pre-abort and stopped lifecycle never checkout or subscribe',async()=>{
 const f=fixture();f.controller.abort();await f.listener.start();await f.listener.stop();await f.listener.start();expect(f.pool.connect).not.toHaveBeenCalled();expect(f.wake).not.toHaveBeenCalled()
})
test('LISTEN failure destroys once then retries after the original second',async()=>{
 const f=fixture(),next=client();f.c.query.mockRejectedValueOnce(Error('listen_failed'));(f.pool.connect as any).mockResolvedValueOnce(f.c).mockResolvedValue(next);await f.listener.start();expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);expect(f.errors).toHaveLength(1);await vi.advanceTimersByTimeAsync(999);expect(f.pool.connect).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1);expect(f.pool.connect).toHaveBeenCalledTimes(2);expect(next.query).toHaveBeenCalledWith('LISTEN pocketctl_realtime')
})
test('disconnected listener destroys its owned connection and reconnects without replaying payload',async()=>{
 const f=fixture(),next=client();(f.pool.connect as any).mockResolvedValueOnce(f.c).mockResolvedValue(next);await f.listener.start();f.wake.mockClear();f.c.emit('error',Error('socket_lost'));expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);await vi.advanceTimersByTimeAsync(1000);expect(next.query).toHaveBeenCalledWith('LISTEN pocketctl_realtime');expect(f.errors).toHaveLength(1)
})
test('failed UNLISTEN is destroyed rather than recycled with an unknown subscription',async()=>{
 const f=fixture();await f.listener.start();f.c.query.mockRejectedValueOnce(Error('unlisten_failed'));await f.listener.stop();expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);await vi.advanceTimersByTimeAsync(5000);expect(f.pool.connect).toHaveBeenCalledOnce()
})
test('late checkout after bounded timeout and stop cannot LISTEN or reopen admission',async()=>{
 const f=fixture();let resolve!:(x:any)=>void;(f.pool.connect as any).mockImplementation(()=>new Promise(r=>{resolve=r}));const start=f.listener.start();await vi.advanceTimersByTimeAsync(1001);await start;expect(f.errors).toHaveLength(1);await vi.advanceTimersByTimeAsync(5000);expect(f.pool.connect).toHaveBeenCalledOnce();await f.listener.stop();resolve(f.c);await vi.advanceTimersByTimeAsync(1);expect(f.c.query).not.toHaveBeenCalled();expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);expect(f.wake).not.toHaveBeenCalled()
})
test('a slow LISTEN is destroyed at one second and its late ACK cannot wake after stop',async()=>{
 const f=fixture();let resolve!:(x:any)=>void;f.c.query.mockImplementationOnce(()=>new Promise(r=>{resolve=r}));const start=f.listener.start();await vi.advanceTimersByTimeAsync(1001);await start;await f.listener.stop();resolve({rows:[]});await vi.advanceTimersByTimeAsync(1);expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);expect(f.wake).not.toHaveBeenCalled()
})
test('a discarded listener socket cannot turn a late error into an unhandled process exception',async()=>{
 const f=fixture();f.c.query.mockRejectedValueOnce(Error('listen_failed'));await f.listener.start();expect(f.c.release).toHaveBeenCalledWith(true)
 expect(()=>f.c.emit('error',Error('late_socket_error'))).not.toThrow();expect(f.errors).toHaveLength(1);expect(f.wake).not.toHaveBeenCalled()
})
test('abort closes an established subscription once and never admits late messages',async()=>{
 const f=fixture();await f.listener.start();f.wake.mockClear();f.controller.abort();await f.listener.stop();expect(f.c.query).toHaveBeenLastCalledWith('UNLISTEN pocketctl_realtime');expect(f.c.release).toHaveBeenCalledExactlyOnceWith();f.c.emit('notification',{channel:'pocketctl_realtime'});expect(f.wake).not.toHaveBeenCalled()
})

test('inherited namespace alone cannot turn a client-shaped object into a factory-owned pool',()=>{
 const pool={connect:vi.fn()}as unknown as pg.Pool;bindSourcePool(pool,{namespace:'memory'})
 expect(()=>createRelayCommitWakeListener({pool,signal:new AbortController().signal,wake:vi.fn()})).toThrow('relay_commit_listener_requires_memory_pool');expect(pool.connect).not.toHaveBeenCalled()
})
test('a single configured connection remains available to the ordinary polling fallback',async()=>{
 const f=fixture(1);await f.listener.start();await f.listener.stop();expect(f.pool.connect).not.toHaveBeenCalled();expect(f.wake).not.toHaveBeenCalled()
})
