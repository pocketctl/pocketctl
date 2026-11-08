import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {assertTeamSemanticLegacySchema} from '../../sources/team-semantic-migration.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 promised audit shape is exact rather than same-name',()=>{
 for(const name of ['memory_team_semantic_legacy_audit_pair','memory_team_semantic_legacy_disposition'])test('rejects forged '+name+' in rollback-only window',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required');const config=JSON.parse(value),p=new pg.Client({connectionString:config.databaseUrl,statement_timeout:5000,lock_timeout:1000})
  await p.connect()
  try{
   expect((await p.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   await assertTeamSemanticLegacySchema(p)
   await p.query('BEGIN')
   await p.query('ALTER TABLE memory.memory_team_semantic_publications DROP CONSTRAINT '+name)
   await p.query('ALTER TABLE memory.memory_team_semantic_publications ADD CONSTRAINT '+name+' CHECK(TRUE)')
   await expect(assertTeamSemanticLegacySchema(p)).rejects.toThrow('team_semantic_legacy_schema_incompatible')
  }finally{await p.query('ROLLBACK');await p.end()}
 })
})
