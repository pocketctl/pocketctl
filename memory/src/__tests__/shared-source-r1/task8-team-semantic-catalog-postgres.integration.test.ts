import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {inspectPagedCleanupCatalog} from '../../migrations/shared-forward/paged-cleanup-catalog.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 finite native header NOT VALID catalog disposition',()=>{
 test.each(['exact approved header','forged same-name definition','same name on another native table'])('%s stays inventoried and only the exact complete native contract is permitted',async variant=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),u=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_(green|retry1|retry2)_test$/.test(u.pathname.slice(1))||u.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const pool=new pg.Pool({connectionString:u.href,max:1,statement_timeout:5000,lock_timeout:1000}),client=await pool.connect()
  try{
   expect((await client.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   await client.query('BEGIN');await client.query('SET LOCAL search_path=pg_catalog')
   if(variant==='forged same-name definition')await client.query('ALTER TABLE public.collaboration_events DROP CONSTRAINT native_team_content_eligibility_pair;ALTER TABLE public.collaboration_events ADD CONSTRAINT native_team_content_eligibility_pair CHECK(TRUE) NOT VALID')
   if(variant==='same name on another native table')await client.query('ALTER TABLE public.collaboration_calls ADD CONSTRAINT native_team_content_eligibility_pair CHECK(TRUE) NOT VALID')
   const inspect=inspectPagedCleanupCatalog(client as unknown as pg.Client)
   if(variant==='exact approved header')expect((await inspect).hash).toMatch(/^[a-f0-9]{64}$/)
   else await expect(inspect).rejects.toThrow()
  }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end()}
 })
})
