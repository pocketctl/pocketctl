import type pg from 'pg'
import {assertMemoryRuntimeCompatibility} from './migrations/governance-v2/compatibility.js'
import {assertSharedRuntimeContract} from './migrations/shared-db/namespace.js'
import {assertMemoryNamespace} from './migrations/shared-db/schema-context.js'
/** Runtime entrypoints only verify. DDL belongs to dist/migrate-main.js using
 * an independently supplied migration URL and explicit database identity. */
type LaunchPolicy={sharedSourceProfile?:'personal-relay-only';installationAllowlist?:readonly string[]}
export async function verifyMemoryStartup(pool:pg.Pool,namespace:'public'|'memory'='memory',launch:LaunchPolicy={}):Promise<void>{
 if(namespace!=='memory')throw Error('native_memory_database_required')
 await assertMemoryNamespace(pool,namespace,'runtime-verify')
 await assertSharedRuntimeContract(pool,launch)
 await assertMemoryRuntimeCompatibility(pool,namespace)
}

export async function prepareMemoryStartup(pool:pg.Pool,config:{databaseNamespace?:'public'|'memory';schemaStartup?:'auto'|'verify'|'legacy-migrate'}&LaunchPolicy):Promise<void>{
 if(config.schemaStartup==='legacy-migrate')throw Error('shared_source_requires_schema_migrator')
 await verifyMemoryStartup(pool,config.databaseNamespace??'memory',config)
}
