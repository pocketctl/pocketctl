import {applyGovernanceCommand} from './apply-cli.js'
import pg from 'pg'
import {open,rename,unlink} from 'node:fs/promises'
import {resolve} from 'node:path'
import {inventoryMemory} from './inventory.js'
import {openRelayInventory} from './relay-inventory.js'
import type {MigrationInventoryItem} from './manifest.js'
async function main():Promise<void>{
 const command=process.argv[2]??'plan'
 if(command==='apply'){
  const url=process.env.MEMORY_MIGRATION_DATABASE_URL;if(!url)throw new Error('migration_database_required')
  const pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000})
  try{console.log(JSON.stringify(await applyGovernanceCommand(pool,process.argv.slice(3)),null,2))}finally{await pool.end()};return
 }
 if(command!=='plan'){console.error('unknown migration command; plan is the read-only default');process.exitCode=2;return}
 const args=process.argv.slice(3)
 let details:string|undefined,relay=false
 for(let i=0;i<args.length;i++){
  if(args[i]==='--details'&&args[i+1]&&!details)details=resolve(args[++i])
  else if(args[i]==='--relay'&&!relay)relay=true
  else{console.error('invalid plan argument');process.exitCode=2;return}
 }
 if(relay&&!process.env.MEMORY_MIGRATION_RELAY_DATABASE_URL){console.error('MEMORY_MIGRATION_RELAY_DATABASE_URL is required for --relay');process.exitCode=2;return}
 const connectionString=process.env.MEMORY_MIGRATION_DATABASE_URL
 if(!connectionString){console.error('MEMORY_MIGRATION_DATABASE_URL is required');process.exitCode=2;return}
 const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000})
 const relayPool=relay?new pg.Pool({connectionString:process.env.MEMORY_MIGRATION_RELAY_DATABASE_URL,max:1,connectionTimeoutMillis:5000}):undefined
 const partial=details?details+'.partial':undefined
 let file:Awaited<ReturnType<typeof open>>|undefined,session:Awaited<ReturnType<typeof openRelayInventory>>|undefined
 try{
  file=partial?await open(partial,'wx',0o600):undefined
  const sink=file?async(items:MigrationInventoryItem[])=>{for(const item of items)await file!.write(JSON.stringify(item)+'\n')}:undefined
  session=relayPool?await openRelayInventory(relayPool,sink):undefined
  const memory=await inventoryMemory(pool,{onFindingBatch:sink,onScopeBatch:session?.scopes,onTeamSourceBatch:session?.sources})
  await session?.finish()
  await file?.close();file=undefined
  if(partial&&details)await rename(partial,details)
  console.log(JSON.stringify(session?{memory,relay:session.manifest,reconciliation:session.reconciliation}:memory,null,2))
 }catch(error){await session?.finish(false).catch(()=>undefined);await file?.close().catch(()=>undefined);if(partial)await unlink(partial).catch(()=>undefined);throw error}
 finally{await pool.end();await relayPool?.end()}
}
main().catch(()=>{console.error('Migration inventory failed; no credentials or source content are included in this error.');process.exitCode=1})
