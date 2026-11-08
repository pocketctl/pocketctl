import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {assertNativeTeamSemanticCompatible as memoryGate} from '../../migrations/shared-db/input-start-contract.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 delegated native metadata ACL NULL safety',()=>{
 test.each(['Memory independent gate','Relay independent gate'])('%s refuses a delegated grant after its exact trusted definer is absent',async name=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),u=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_(green|retry1|retry2|retry3)_test$/.test(u.pathname.slice(1))||u.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const pool=new pg.Pool({connectionString:u.href,max:1,statement_timeout:5000,lock_timeout:1000}),client=await pool.connect()
  try{
   expect((await client.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   await client.query('BEGIN')
   expect((await client.query("SELECT has_function_privilege($1,'public.read_native_team_semantic_publication(text,text)','EXECUTE') AS granted",[config.roles.migratorRole])).rows[0].granted).toBe(true)
   await client.query('DROP FUNCTION shared.read_memory_team_semantic_group(uuid,text,text)')
   const relay=await import(new URL('../../../../relay/src/shared-source/team-semantic-publication.ts',import.meta.url).href)
   const gate=name==='Memory independent gate'?memoryGate:relay.assertNativeTeamSemanticCompatible
   await expect(gate(client as unknown as Pick<pg.Pool,'query'>)).rejects.toThrow('native_team_semantic_history_missing')
  }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();await pool.end()}
 })
})
