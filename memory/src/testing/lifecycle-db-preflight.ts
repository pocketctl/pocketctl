import pg from 'pg'
import {memoryTestDatabaseConfig,assertMemoryTestDatabase} from './test-db.js'
let pool:pg.Pool|undefined
try {
 if(process.env.RUN_MEMORY_POSTGRES_INTEGRATION!=='1'||!process.env.MEMORY_TEST_DATABASE_URL)throw new Error()
 const url=process.env.MEMORY_TEST_DATABASE_URL
 const memory=memoryTestDatabaseConfig(url)
 if(process.env.TEST_DATABASE_URL&&memoryTestDatabaseConfig(process.env.TEST_DATABASE_URL).database===memory.database)throw new Error()
 pool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:3000})
 await assertMemoryTestDatabase(pool,url)
 const schemaPresent=(await pool.query("SELECT to_regclass('public.memory_schema_migrations') IS NOT NULL AS present")).rows[0].present
 const schemaVersion=schemaPresent?Number((await pool.query('SELECT COALESCE(MAX(version),0) n FROM memory_schema_migrations')).rows[0].n):0
 process.stdout.write(JSON.stringify({status:'pass',non_superuser:true,loopback:true,schema_version:schemaVersion})+'\n')
} catch { process.stderr.write('lifecycle_database_guard_failed\n');process.exitCode=2 }
finally { await pool?.end() }
