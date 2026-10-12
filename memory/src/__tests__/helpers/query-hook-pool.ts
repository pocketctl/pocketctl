import type pg from 'pg'

/** Intercept one boundary while retaining a real transaction-owned connection. */
export function queryHookPool(pool:pg.Pool,before:(sql:string,params:unknown[])=>Promise<void>):pg.Pool {
 return {
  query:async(sql:string,params:unknown[])=>{await before(sql,params);return pool.query(sql,params)},
  connect:async()=>{
   const client=await pool.connect()
   return {query:async(sql:string,params:unknown[])=>{await before(sql,params);return client.query(sql,params)},release:()=>client.release()}
  },
 } as unknown as pg.Pool
}
