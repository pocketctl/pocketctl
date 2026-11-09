import type pg from 'pg'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {teamSemanticRegistrationTransaction} from '../../sources/team-semantic-registration-transport.js'
beforeEach(()=>vi.useFakeTimers())
afterEach(()=>vi.useRealTimers())
// A connected transport that never answers cannot be reproduced with a healthy
// local PostgreSQL server. These sockets are fault-injection doubles only.
test.each(['BEGIN','SET','GUARD','RAW','COMMIT','ROLLBACK'])('whole transaction deadline destroys a hung %s socket and prevents late SQL',async phase=>{
 const sent:string[]=[],released:unknown[]=[],destroyed:string[]=[]
 let lateResponse:((value:unknown)=>void)|undefined
 const client={query(sql:string){
  const command=sql.startsWith('SET ')?'SET':sql;sent.push(command)
  if(command===phase)return new Promise(resolve=>{lateResponse=resolve})
  return Promise.resolve({rows:[]})
 },release(destroy?:boolean){released.push(destroy)},connection:{stream:{destroy(){destroyed.push('socket')}}}}
 const pool={connect:async()=>client} as unknown as pg.Pool
 let state='pending',message=''
 const operation=teamSemanticRegistrationTransaction(pool,async c=>{
  await c.query('GUARD');await c.query('RAW');if(phase==='ROLLBACK')throw Error('synthetic_work_failure');return 7
 }).then(()=>{state='resolved'},error=>{state='rejected';message=error.message})
 await vi.advanceTimersByTimeAsync(5100)
 expect(state).toBe('rejected');expect(message).toBe('team_semantic_registration_budget_exceeded')
 expect(released).toEqual([true]);expect(destroyed).toEqual(['socket'])
 const atTimeout=[...sent];lateResponse?.({rows:[]});await vi.advanceTimersByTimeAsync(10);await operation
 expect(sent).toEqual(atTimeout);expect(released).toEqual([true])
})
test('pool acquisition has a bounded wait and a late client is discarded without sending BEGIN',async()=>{
 const sent:string[]=[],released:unknown[]=[],destroyed:string[]=[]
 let lateClient:((value:pg.PoolClient)=>void)|undefined
 const client={query(sql:string){sent.push(sql);return Promise.resolve({rows:[]})},release(destroy?:boolean){released.push(destroy)},connection:{stream:{destroy(){destroyed.push('socket')}}}} as unknown as pg.PoolClient
 const pool={connect:()=>new Promise<pg.PoolClient>(resolve=>{lateClient=resolve})} as unknown as pg.Pool
 let state='pending'
 const operation=teamSemanticRegistrationTransaction(pool,async()=>7).then(()=>{state='resolved'},()=>{state='rejected'})
 await vi.advanceTimersByTimeAsync(1100);expect(state).toBe('rejected')
 lateClient!(client);await vi.advanceTimersByTimeAsync(10);await operation
 expect(sent).toEqual([]);expect(released).toEqual([true]);expect(destroyed).toEqual(['socket'])
})
test('successful and failed live transactions release exactly once and preserve their result/error',async()=>{
 const sent:string[]=[],released:unknown[]=[]
 const client={query:async(sql:string)=>{sent.push(sql);return {rows:[]}},release(destroy?:boolean){released.push(destroy)}} as unknown as pg.PoolClient
 const pool={connect:async()=>client} as unknown as pg.Pool
 expect(await teamSemanticRegistrationTransaction(pool,async c=>{await c.query('GUARD');return 7})).toBe(7)
 await expect(teamSemanticRegistrationTransaction(pool,async()=>{throw Error('synthetic_work_failure')})).rejects.toThrow('synthetic_work_failure')
 expect(sent.filter(s=>s==='COMMIT')).toHaveLength(1);expect(sent.filter(s=>s==='ROLLBACK')).toHaveLength(1)
 expect(released).toEqual([undefined,undefined]);expect(vi.getTimerCount()).toBe(0)
})
