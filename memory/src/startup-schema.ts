import {applyMemorySchema} from './schema.js'
import type pg from 'pg'
import {assertMemoryRuntimeCompatibility} from './migrations/governance-v2/compatibility.js'
import {assertSharedRuntimeContract} from './migrations/shared-db/namespace.js'
import {assertMemoryNamespace} from './migrations/shared-db/schema-context.js'
/** Runtime entrypoints only verify. DDL belongs to dist/migrate-main.js using
 * an independently supplied migration URL and explicit database identity. */
type LaunchPolicy={sharedSourceProfile?:'personal-relay-only';installationAllowlist?:readonly string[]}
export async function verifyMemoryStartup(pool:pg.Pool,namespace:'public'|'memory'='public',launch:LaunchPolicy={}):Promise<void>{
 await assertMemoryNamespace(pool,namespace,'runtime-verify')
 if(namespace==='memory')await assertSharedRuntimeContract(pool,launch)
 await assertMemoryRuntimeCompatibility(pool,namespace)
}

/** R1 legacy compatibility is explicit in the namespace. Shared targets never
 * bootstrap DDL in a runtime process, including on missing schema/errors. */
export async function prepareMemoryStartup(pool:pg.Pool,config:{databaseNamespace?:'public'|'memory';schemaStartup?:'auto'|'verify'|'legacy-migrate'}&LaunchPolicy):Promise<void>{
 const namespace=config.databaseNamespace??'public',strategy=config.schemaStartup??'auto'
 if(namespace==='memory' && strategy==='legacy-migrate')throw new Error('shared_source_requires_schema_migrator')
 if(namespace==='public' && strategy!=='verify')await applyMemorySchema(pool)
 await verifyMemoryStartup(pool,namespace,config)
}
