import pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {initDB} from './db.js'
import {assertRelaySharedContract,relaySharedTarget} from './schema-runtime.js'
import {applyRelaySourceCapture,assertRelayCaptureMigrationCompatible} from './shared-source/capture.js'
import {applyRelayTeamSourceCapture} from './shared-source/team-capture.js'
import {applyRelayControlCapture} from './shared-source/control-capture.js'
import {enableSessionColdBodies} from './session-lifecycle/cold-schema.js'
export async function migrateRelay(args=process.argv.slice(2)):Promise<number>{
 if(args.length!==2 || args[0]!=='apply' || !args[1] || !process.env.RELAY_MIGRATION_DATABASE_URL){console.error('usage: RELAY_MIGRATION_DATABASE_URL=... migrate-main apply EXPECTED_DATABASE');return 2}
 const pool=new pg.Pool({connectionString:process.env.RELAY_MIGRATION_DATABASE_URL,max:1,options:'-c search_path=public,pg_catalog,shared',application_name:'pocketctl-relay-migrator'})
 try{
  if((await pool.query('SELECT current_database() AS name')).rows[0].name!==args[1])throw Error('migration_database_identity_mismatch')
  await assertRelaySharedContract(pool)
  if(await relaySharedTarget(pool))await assertRelayCaptureMigrationCompatible(pool)
  await initDB(pool)
  if(await relaySharedTarget(pool)){
   await applyRelaySourceCapture(pool)
   await applyRelayTeamSourceCapture(pool)
   await applyRelayControlCapture(pool)
  }
  if(process.env.RELAY_MIGRATION_ENABLE_COLD_BODIES==='1')await enableSessionColdBodies(pool)
  console.log('relay_schema_migrated');return 0
 }catch(e){const code=(e as {code?:string}).code;console.error(code&&/^[A-Z0-9]{5}$/.test(code)?'postgres_'+code:'relay_schema_migration_failed');return 2}finally{await pool.end()}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await migrateRelay()
