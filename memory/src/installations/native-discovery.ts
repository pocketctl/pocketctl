import type pg from 'pg'
import {sourcePoolContext,sourceConnectionKey} from '../sources/pool-context.js'
import {parseProviderInstallationV2} from '../relay/installations.js'
import {createInstallationRegistry} from './repository.js'
import type {ProviderInstallationItemV2} from '../relay/contracts.js'

/** Called at startup and by durable native control work. There is no HTTP
 * fallback or discovery timer in the shared database runtime. */
export function createNativeInstallationDiscovery(options:{pool:pg.Pool;signal:AbortSignal;installationAllowlist?:ReadonlySet<string>}){
 const {pool,signal}=options,registry=createInstallationRegistry(pool)
 if(sourcePoolContext(pool).namespace!=='memory'||sourceConnectionKey(pool)!==pool)throw Error('native_inventory_requires_physical_pool')
 let running:Promise<number>|undefined,stopped=false
 async function discover(){
  const items:ProviderInstallationItemV2[]=[],seen=new Set<string>()
  let cursor:string|null=null,revision:string|undefined,complete=false,bytes=0
  for(let n=0;n<10000;n++){
   if(stopped||signal.aborted)throw Error('native_inventory_aborted')
   const page:{installations:unknown[];control_revision:string;has_more:boolean;next_cursor:string|null}|undefined=(await pool.query('SELECT shared.memory_installation_inventory_page($1::uuid,128,$2::bigint) AS page',[cursor,revision??null])).rows[0]?.page
   if(!page||!Array.isArray(page.installations)||page.installations.length>128||typeof page.control_revision!=='string'||!/^[1-9][0-9]*$/.test(page.control_revision)
    ||typeof page.has_more!=='boolean'||page.next_cursor!==null&&typeof page.next_cursor!=='string'||revision!==undefined&&page.control_revision!==revision)throw Error('invalid_native_inventory_page')
   bytes+=Buffer.byteLength(JSON.stringify(page));if(bytes>8*1024*1024)throw Error('native_inventory_byte_limit')
   revision=page.control_revision
   let lastId:string|null=cursor
   for(const raw of page.installations){
    const item=parseProviderInstallationV2(raw)
    if(seen.has(item.installation_id)||lastId!==null&&item.installation_id<=lastId)throw Error('invalid_native_inventory_page')
    lastId=item.installation_id
    seen.add(item.installation_id)
    if(seen.size>4096)throw Error('native_inventory_installation_limit')
    if(!options.installationAllowlist?.size||options.installationAllowlist.has(item.installation_id.toLowerCase()))items.push(item)
   }
   if(!page.has_more){complete=true;break}
   if(!page.installations.length||page.next_cursor!==lastId)throw Error('invalid_native_inventory_page')
   cursor=page.next_cursor
  }
  if(!complete||!revision)throw Error('native_inventory_incomplete')
  if(stopped||signal.aborted)throw Error('native_inventory_aborted')
  await registry.applyDiscovery({generation:await registry.currentGeneration()+1,items,sourceControlRevision:revision})
  return items.length
 }
 return {
  start(){/* The shared source scheduler owns native control wakeups. */},
  discoverOnce():Promise<number>{if(!running)running=discover().finally(()=>{running=undefined});return running},
  async stop(){stopped=true;await running},
 }
}
