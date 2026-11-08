import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {createIdempotencyStore} from '../../api/idempotency.js'
import {assertCurrentGrantClock} from '../../governance/authorization.js'
import {DeferredSourcePreparation} from '../../sources/deferred-preparation.js'
import {createMemoryPool} from '../../db.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 original API clock after source guards',()=>{
 test('real idempotency transaction refuses expiry during deferred metadata guards without committing its reservation',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),url=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_(red|green|retry1|retry2|retry3)_test$/.test(url.pathname.slice(1))||url.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const admin=new pg.Pool({connectionString:url.href,max:1,statement_timeout:5000,lock_timeout:1000})
  const runtime=createMemoryPool({databaseUrl:config.runtimeDatabaseUrls.memoryRole,databaseNamespace:'memory',dbPoolMax:2})
  const operation='task8-clock-'+randomUUID(),key=randomUUID()
  try{
   expect((await admin.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   expect((await runtime.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.memoryRole)
   const installation=(await runtime.query('SELECT installation_id::text FROM memory_installations ORDER BY installation_id LIMIT 1')).rows[0].installation_id
   const originalGrant=Object.freeze({expiresAt:Number((await runtime.query('SELECT extract(epoch from clock_timestamp())::double precision+0.25 AS expires')).rows[0].expires)})
   const beforeCommit=async(client:pg.PoolClient)=>assertCurrentGrantClock(client,originalGrant)
   let prepared=false,checked=false
   const execute=createIdempotencyStore(runtime).execute({installationId:installation,operation,key,requestCanonical:'{}',isolation:'read_committed',
    authorize:beforeCommit,beforeCommit,
    async run(){
     if(!prepared)throw new DeferredSourcePreparation(operation,async()=>{
      prepared=true
      return {async assertCurrent(client){
       checked=true
       // Deliberately cross only this captured original expiry. The bounded
       // real SQL delay is under native statement/transaction test budgets.
       await client.query('SELECT pg_sleep(LEAST(0.30,GREATEST(0,$1::double precision-extract(epoch from clock_timestamp())::double precision+0.01)))',[originalGrant.expiresAt])
      }}
     })
     return {ok:true as const,metadata:{fixture:operation}}
    }})
   await expect(execute).rejects.toThrow('grant expired')
   expect(prepared&&checked).toBe(true)
   expect((await runtime.query('SELECT count(*)::int AS n FROM memory_idempotency_keys WHERE installation_id=$1 AND operation=$2',[installation,operation])).rows[0].n).toBe(0)
  }finally{
   // Only this test's exact random reservation can exist on the pre-fix RED.
   await admin.query('DELETE FROM memory.memory_idempotency_keys WHERE operation=$1',[operation])
   await runtime.end();await admin.end()
  }
 })
})
