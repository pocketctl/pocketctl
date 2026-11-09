import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {TEAM_SEMANTIC_LEGACY_AUDIT_CHECK} from '../../sources/team-semantic-legacy-audit.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 exact SQL audit JSON contract without installer DDL',()=>{
 test('actual PostgreSQL rejects null/partial/future/arbitrary keys and oversize typed IDs',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required');const config=JSON.parse(value)
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:1,statement_timeout:5000,lock_timeout:1000})
  try{
   expect((await pool.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   const base={version:1,closure:'snapshot_only',disposition:'related',identityDigest:'a'.repeat(64),closureDigest:'b'.repeat(64),relations:[['source','x'.repeat(1024),'a'.repeat(64),'verified']],accounting:{version:1,digest:'c'.repeat(64),count:0,unprovenCount:0,relatedCount:0},reasons:[]}
   const check=async(audit:unknown)=>(await pool.query(`SELECT (${TEAM_SEMANTIC_LEGACY_AUDIT_CHECK}) AS ready FROM(SELECT $1::jsonb AS legacy_relation_audit) input`,[JSON.stringify(audit)])).rows[0].ready
   expect(await check(base)).toBe(true)
   for(const patch of [{version:null},{version:2},{closure:null},{disposition:null},{identityDigest:null},{closureDigest:77},{excerpt:'forbidden'},{reasons:[null]},{reasons:['future_reason']},{relations:[['source','x'.repeat(1025),'a'.repeat(64),'verified']]},{relations:[['future','id','a'.repeat(64),'verified']]},{accounting:{...base.accounting,count:null}},{accounting:{...base.accounting,count:1.5}},{accounting:{...base.accounting,requestKey:'forbidden'}}])expect(await check({...base,...patch})).toBe(false)
   const missing:any={...base};delete missing.normalization;delete missing.closure;expect(await check(missing)).toBe(false)
  }finally{await pool.end()}
 })
})
