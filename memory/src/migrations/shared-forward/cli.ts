import {readFile,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {ReportBundle} from '../shared-source/report.js'
import {beginForwardCapacityRun} from './capacity-admission.js'
import {safeError} from '../shared-source/database.js'
import {planForwardMigration,applyForwardMigration,verifyForwardMigration,cancelForwardMigrations,type ForwardConfig,type ForwardManifest} from './engine.js'
const help=`Forward-only Memory namespace migration; dedicated administrator only.
  plan --identity FILE --output NEW_DIR --migration-id UUID --code-sha SHA [--max-row-bytes N] [--wal-checkpoint-bytes N]
  apply|resume --identity FILE --manifest FILE --capacity FILE --output NEW_DIR --migration-id UUID --code-sha SHA [--max-row-bytes N] [--wal-checkpoint-bytes N]
  verify --identity FILE --manifest FILE --output NEW_DIR --migration-id UUID --code-sha SHA [--max-row-bytes N] [--wal-checkpoint-bytes N]
Dedicated URLs: SHARED_FORWARD_SOURCE_URL and SHARED_FORWARD_TARGET_URL.
Identity: {source:{database,role,serverAddress,serverPort},target:{...}}.
Source must be drained with CONNECT fenced. Target must be closed/pristine.
No backup, restore, rollback, DSN switch, source deletion, grant bypass or activation.
Transfer batches contain at most 128 rows/8 MiB (one admitted larger row may
reach 32 MiB); default row ceiling 32 MiB. Original PostgreSQL
row JSON stays opaque, so bigint/JSON values never pass through JS numbers.
Exit 0: requested operation verified; 2: failed; 130/143: interrupted.
Verification is physical transfer proof, not migration/business acceptance.`
async function readJson(path:string){
 if((await stat(path)).size>8*1024*1024)throw Error('input_file_limit')
 return JSON.parse(await readFile(path,'utf8'))
}
export async function main(argv=process.argv.slice(2)):Promise<number>{
 if(argv.length===0||argv[0]==='--help'){process.stdout.write(help+'\n');return 0}
 const [command,...args]=argv,flags:Record<string,string>={}
 if(!['plan','apply','resume','verify'].includes(command)){process.stderr.write('invalid_command\n');return 2}
 for(let i=0;i<args.length;i+=2){
  const key=args[i].slice(2),value=args[i+1]
  if(!args[i].startsWith('--')||!['identity','manifest','capacity','output','migration-id','code-sha','max-row-bytes','wal-checkpoint-bytes'].includes(key)||flags[key]!==undefined||!value||value.startsWith('--')){process.stderr.write('invalid_arguments\n');return 2}
  flags[key]=value
 }
 if(!flags.identity||!flags.output||!flags['migration-id']||!flags['code-sha']||command!=='plan'&&!flags.manifest||command==='plan'&&flags.manifest){process.stderr.write('required_arguments_missing\n');return 2}
 if((command==='apply'||command==='resume')&&!flags.capacity||flags.capacity&&(command==='plan'||command==='verify')){process.stderr.write('forward_capacity_required_or_unexpected\n');return 2}
 if(flags['wal-checkpoint-bytes']&&!/^[1-9][0-9]*$/.test(flags['wal-checkpoint-bytes'])){process.stderr.write('invalid_forward_wal_checkpoint_limit\n');return 2}
 if(flags['max-row-bytes']&&!/^[1-9][0-9]*$/.test(flags['max-row-bytes'])){process.stderr.write('invalid_row_byte_limit\n');return 2}
 let bundle:ReportBundle|undefined,interrupted:number|undefined
 const interrupt=(code:number)=>{interrupted=code;void cancelForwardMigrations()}
 const sigint=()=>interrupt(130),sigterm=()=>interrupt(143)
 process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
 try{
  const identity=await readJson(flags.identity)
  if(!process.env.SHARED_FORWARD_SOURCE_URL||!process.env.SHARED_FORWARD_TARGET_URL)throw Error('dedicated_forward_urls_required')
  const config:ForwardConfig={source:{url:process.env.SHARED_FORWARD_SOURCE_URL,expected:identity.source},target:{url:process.env.SHARED_FORWARD_TARGET_URL,expected:identity.target},migrationId:flags['migration-id'],codeSha:flags['code-sha'],maxRowBytes:Number(flags['max-row-bytes']??32*1024*1024),...(flags['wal-checkpoint-bytes']?{walCheckpointBytes:Number(flags['wal-checkpoint-bytes'])}:{})}
  bundle=await ReportBundle.create(flags.output)
  const manifest:ForwardManifest=command==='plan'?await planForwardMigration(config):await readJson(flags.manifest)
  const capacity=flags.capacity?await readJson(flags.capacity):undefined
  const capacityRun=capacity?beginForwardCapacityRun(capacity,manifest):undefined
  if(interrupted)throw Error('interrupted')
  if(command==='plan')await bundle.write('copy-manifest.json',manifest)
  else{
   if(command!=='verify')await bundle.write('copy-resource-observation.json',await applyForwardMigration(config,manifest,{capacity}))
   if(interrupted)throw Error('interrupted')
   const receipt=await verifyForwardMigration(config,manifest)
   await bundle.write('forward-verification.json',receipt)
  }
  if(interrupted)throw Error('interrupted')
  if(capacity)await bundle.write('capacity-admission.json',{schemaVersion:1,kind:'memory-forward-capacity-admission',manifestHash:manifest.manifestHash,measuredAt:capacity.measuredAt,validUntil:capacity.validUntil,report:capacityRun!.check()})
  await bundle.write('run.json',{schemaVersion:1,kind:'memory-forward-run',command,migrationId:config.migrationId,codeSha:config.codeSha,manifestHash:manifest.manifestHash,backupCreated:false,rollbackSupported:false,activationAuthorized:false,completedAt:new Date().toISOString()})
  await bundle.finish();bundle=undefined;process.stdout.write('forward_report_completed\n');return 0
 }catch(e){process.stderr.write(interrupted?'interrupted\n':safeError(e)+'\n');return interrupted??2}
 finally{await bundle?.abort();process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
