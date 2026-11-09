import pg from 'pg'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {applyMemorySchema} from './schema.js'
import {applySharedSourceContract} from './migrations/shared-db/contract.js'
import {provisionSharedDatabase} from './migrations/shared-db/namespace.js'
import {safeError} from './migrations/shared-source/database.js'
import {MEMORY_WRITER_STARTUP_OPTIONS} from './migrations/governance-v2/compatibility.js'
import {normalizeTargetInstallations} from './migrations/shared-db/target-contract.js'
export async function migrateMain(args=process.argv.slice(2)):Promise<number>{
 const [command,namespace,expectedDatabase]=args
 if(command!=='apply' || !['public','memory'].includes(namespace) || !expectedDatabase || args.length!==3){process.stderr.write('usage: migrate-main apply public|memory EXPECTED_DATABASE\n');return 2}
 const url=process.env.MEMORY_MIGRATION_DATABASE_URL
 if(!url){process.stderr.write('dedicated_migration_database_url_required\n');return 2}
 const pool=new pg.Pool({connectionString:url,max:1,options:MEMORY_WRITER_STARTUP_OPTIONS,application_name:'pocketctl-memory-migrator'})
 try{
  const targetProfile=process.env.MEMORY_MIGRATION_SOURCE_TARGET_PROFILE
  if(targetProfile!==undefined&&(namespace!=='memory'||targetProfile!=='full'&&targetProfile!=='personal-relay-only'))throw Error('unsupported_shared_source_target_profile')
  const rawInstallations=process.env.MEMORY_MIGRATION_PRESERVED_INSTALLATIONS
  if(rawInstallations!==undefined&&targetProfile!=='personal-relay-only')throw Error('shared_source_launch_scope_mismatch')
  const preservedInstallations=targetProfile==='personal-relay-only'?normalizeTargetInstallations(rawInstallations?.split(',').map(id=>id.trim().toLowerCase())):undefined
  if((await pool.query('SELECT current_database() AS name')).rows[0].name!==expectedDatabase)throw new Error('migration_database_identity_mismatch')
  await applyMemorySchema(pool,{namespace:namespace as 'public'|'memory'})
  if(namespace==='memory'){
   await applySharedSourceContract(pool,{targetProfile,preservedInstallations})
   if(process.env.MEMORY_MIGRATION_ROLES)await provisionSharedDatabase(pool,JSON.parse(process.env.MEMORY_MIGRATION_ROLES))
  }
  process.stdout.write('memory_schema_migrated\n');return 0
 }catch(e){process.stderr.write(safeError(e)+'\n');return 2}finally{await pool.end()}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await migrateMain()
