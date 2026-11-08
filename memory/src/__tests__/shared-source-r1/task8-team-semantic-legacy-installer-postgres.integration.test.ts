import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 promised old96 publication prototype refuses before installer DDL',()=>{
 test('all actual installers reject stale promised fields rather than repairing them',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required');const config=JSON.parse(value)
  if(config.expected.database!=='task8_team_semantic_consumer_retry2_test')throw Error('exact_old96_prototype_required')
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,statement_timeout:5000,lock_timeout:1000})
  try{
   expect((await pool.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   for(const installer of [()=>applyMemorySchema(pool,{namespace:'memory'}),()=>applySharedSourceContract(pool),()=>provisionSharedDatabase(pool,config.roles)]){
    const client=await pool.connect(),query=client.query.bind(client),ddls:string[]=[]
    const original=client.query
    client.query=((sql:any,...args:any[])=>{const text=typeof sql==='string'?sql:sql.text;if(/^\s*(CREATE|ALTER|DROP|GRANT|REVOKE|UPDATE|INSERT|DELETE)\b/i.test(text))ddls.push(text.split(/\s+/).slice(0,4).join(' '));return (query as any)(sql,...args)}) as typeof client.query
    client.release()
    try{await expect(installer()).rejects.toThrow('team_semantic_legacy_schema_incompatible');expect(ddls).toEqual([])}finally{client.query=original}
   }
  }finally{await pool.end()}
 })
})
