import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { openSnapshot, safeError, assertDistinctDatabases, type ExpectedIdentity, type Snapshot } from './database.js'
import { inventoryDatabase, namespaceAudit } from './inventory.js'
import { parseObjectPlan } from './classification.js'
import { scanMapping,parseSourceSelection } from './scanner.js'
import { capacityPlan, type CapacityInput } from './capacity.js'
import { ReportBundle } from './report.js'
const HELP=`Read-only shared-source maintenance (run with tsx in a full checkout):
  inventory --identity FILE --output NEW_DIR --migration-id ID --code-sha SHA [--object-plan FILE]
  map-plan --identity FILE --output NEW_DIR --migration-id ID --code-sha SHA --snapshot-id ID
           [--page-size 1..256] [--max-rows N] [--source-ids JSON_FILE] [--legacy-in-place plan] [--pre-native-logical plan] [--archive-dir DIR --archive-namespace NAME]
  capacity-plan --input FILE --output NEW_DIR --migration-id ID --code-sha SHA
Dedicated URLs: SHARED_SOURCE_MEMORY_URL and SHARED_SOURCE_RELAY_URL.
Identity file: {memory:{database,role,serverAddress,serverPort,mode},relay:{...}}.
Mapping uses isolated restores, or frozen-maintenance Memory plus live-readonly Relay
with the same reviewed maintenanceWindowId bound to --snapshot-id. It creates no backup.
Exit 0: report completed without tool blockers; 2: invalid/failed; 3: report completed with blockers; 130/143: interrupted.
No command authorizes migration, cutover, or deletion. Two DB snapshots are independent.`
async function readJson(path:string):Promise<any> {
  if((await stat(path)).size>8*1024*1024)throw new Error('input_file_limit')
  return JSON.parse(await readFile(path,'utf8'))
}
export async function main(argv=process.argv.slice(2)):Promise<number> {
  if(argv.length===0 || argv[0]==='--help'){process.stdout.write(HELP+'\n');return 0}
  const [command,...rest]=argv
  if(!['inventory','map-plan','capacity-plan'].includes(command)){process.stderr.write('invalid_command\n');return 2}
  const flags:Record<string,string>={}
  const allowed=command==='capacity-plan'?['input','output','migration-id','code-sha']:command==='inventory'?['identity','output','migration-id','code-sha','object-plan']:['identity','output','migration-id','code-sha','snapshot-id','page-size','max-rows','source-ids','archive-dir','archive-namespace','legacy-in-place','pre-native-logical']
  for(let i=0;i<rest.length;i+=2){
    const key=rest[i].slice(2),value=rest[i+1]
    if(!rest[i].startsWith('--') || !allowed.includes(key) || flags[key]!==undefined || !value || value.startsWith('--')){process.stderr.write('invalid_arguments\n');return 2}
    flags[key]=value
  }
  if(!flags.output || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(flags['migration-id']??'') || !/^[a-f0-9]{40}$/.test(flags['code-sha']??'')
    || (command==='capacity-plan'?!flags.input:!flags.identity) || (command==='map-plan' && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(flags['snapshot-id']??''))
    || !!flags['archive-dir']!==!!flags['archive-namespace']){process.stderr.write('required_arguments_missing_or_invalid\n');return 2}
  if(flags['legacy-in-place']&&flags['legacy-in-place']!=='plan'){process.stderr.write('invalid_legacy_in_place_mode\n');return 2}
  if(flags['pre-native-logical']&&flags['pre-native-logical']!=='plan'){process.stderr.write('pre_native_preparation_state_required\n');return 2}
  for(const key of ['page-size','max-rows'])if(flags[key] && (!/^[1-9][0-9]*$/.test(flags[key]) || !Number.isSafeInteger(Number(flags[key])))){process.stderr.write('invalid_scan_limit\n');return 2}
  const controller=new AbortController()
  let exitCode=2,bundle:ReportBundle|undefined,memory:Snapshot|undefined,relay:Snapshot|undefined,signalCode:number|undefined
  const interrupt=(signal:NodeJS.Signals)=>{
    signalCode=signal==='SIGINT'?130:143;controller.abort(new Error('interrupted'))
    // Closing sockets cancels active server work; rollback/disconnect releases the snapshot.
    for(const s of [memory,relay])if(s)void s.cancel().catch(()=>undefined)
  }
  const sigint=()=>interrupt('SIGINT'),sigterm=()=>interrupt('SIGTERM')
  process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
  try{
    bundle=await ReportBundle.create(flags.output)
    const run={schemaVersion:1,reportType:'run',runId:randomUUID(),migrationId:flags['migration-id'],codeSha:flags['code-sha'],
      command,startedAt:new Date().toISOString(),crossDatabaseAtomic:false,snapshotId:flags['snapshot-id']??null,
      fullMappingExecuted:false,migrationAuthorized:false,backupCreated:false,rollbackSupported:false}
    if(command==='capacity-plan'){
      const input=await readJson(flags.input)
      if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('invalid_capacity_input')
      const report=capacityPlan(input as CapacityInput)
      await bundle.write('capacity.json',report);exitCode=report.ready?0:3
    }else{
      const identity=await readJson(flags.identity)
      const sourceIds=flags['source-ids']?parseSourceSelection(await readJson(flags['source-ids'])):undefined
      if(!process.env.SHARED_SOURCE_MEMORY_URL || !process.env.SHARED_SOURCE_RELAY_URL)throw new Error('dedicated_database_urls_required')
      memory=await openSnapshot({connectionString:process.env.SHARED_SOURCE_MEMORY_URL,expected:identity.memory as ExpectedIdentity})
      controller.signal.throwIfAborted()
      relay=await openSnapshot({connectionString:process.env.SHARED_SOURCE_RELAY_URL,expected:identity.relay as ExpectedIdentity})
      assertDistinctDatabases(memory.identity,relay.identity)
      if(command==='map-plan'&&memory.expected.mode==='frozen-maintenance'&&memory.identity.maintenanceWindowId!==flags['snapshot-id'])throw Error('maintenance_mapping_scope_mismatch')
      if(command==='inventory'){
        const plans=flags['object-plan']?await readJson(flags['object-plan']):{}
        const m=await inventoryDatabase(memory,'memory',parseObjectPlan(plans.memory??{}))
        controller.signal.throwIfAborted()
        const r=await inventoryDatabase(relay,'relay',parseObjectPlan(plans.relay??{}))
        await bundle.write('inventory.json',{schemaVersion:1,reportType:'inventory',memory:m,relay:r,crossDatabaseAtomic:false,fullMappingExecuted:false,migrationReady:false})
        await bundle.write('namespace-audit.json',namespaceAudit([m,r]))
        exitCode=m.blockers.length || r.blockers.length?3:0
      }else{
        const report=await scanMapping(memory,relay,{sourceIds,preNativeLogicalPreparation:flags['pre-native-logical']==='plan',legacyInPlace:flags['legacy-in-place']==='plan',pageSize:flags['page-size']?Number(flags['page-size']):undefined,maxRows:flags['max-rows']?Number(flags['max-rows']):undefined,
          archive:flags['archive-dir']?{directory:resolve(flags['archive-dir']),namespace:flags['archive-namespace']}:undefined,
          signal:controller.signal,onDetail:row=>bundle!.detail(row)})
        await bundle.write('mapping-summary.json',report);run.fullMappingExecuted=report.fullMappingExecuted;exitCode=3
      }
    }
    await memory?.close();memory=undefined;await relay?.close();relay=undefined
    controller.signal.throwIfAborted()
    await bundle.write('run.json',{...run,completedAt:new Date().toISOString(),exitCode})
    controller.signal.throwIfAborted()
    await bundle.finish();bundle=undefined
    process.stdout.write('report_completed\n')
  }catch(error){process.stderr.write(signalCode?'interrupted\n':safeError(error)+'\n');exitCode=signalCode??2}
  finally{
    await memory?.close().catch(()=>undefined);await relay?.close().catch(()=>undefined)
    await bundle?.abort().catch(()=>undefined)
    process.off('SIGINT',sigint);process.off('SIGTERM',sigterm)
  }
  return signalCode??exitCode
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
