import {readFile,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {retainNecessaryOriginalPersonalReferencePage} from './necessary-original-custody.js'
import {connectMaintenance} from './source-maintenance-common.js'
import {ReportBundle} from '../shared-source/report.js'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
import {safeError} from '../shared-source/database.js'
const help=`Finite necessary original Memory custody (1..256 UUIDs, one personal Session).
  --input FILE --output NEW_DIR
Input: {source:{database,databaseOid,role,serverAddress,serverPort},target:{...},copy,scope,root,sourceEventIds,necessity?,discoveryWitness?,sourceProcessingWitness?,recurringObservationWitness?,nativeHeadWitness?}.
Requires verified copy, frozen original database, fenced target writers, current
personal/native authority and current necessity dependencies. Default
necessity=literal-reference requires literal packet handles. Explicit
necessity=accepted-session closes original references in the same accepted
personal Session, only under current retained_history admission.
Explicit necessity=source-processing requires an existing native projection task
and sourceProcessingWitness:{jobId,scanId,targetCursor}. Its sealed target must
match current personal control/mode and actual current native input. It proves
processing necessity, not accepted knowledge or original-to-Relay identity.
Optional source-processing nativeHeadWitness:{canonicalKey} uses the actual
current controlled one-ID reader instead of enumerating the Session prefix.
It proves current native input under the same root/scope/version and never an
old-to-canonical identity. All original commit and authority fences remain.
Source-processing may separately supply recurringObservationWitness:
{canonicalKey,eventType:'turn_status'} for an exact recurring ingress key with
a different, earlier current hot/cold observation. Both original and current
turn/owner/session/type/classification, unknown provenance and current version
must match independently. It never treats the witness as replacement bytes.
Ordinary custody requires no stable key or retained transport. Explicit accepted-session
discoveryWitness:{canonicalKey} separately verifies later, different original
session_discovered observations against current controlled hot/cold bytes.
Cold witnesses require MEMORY_SHARED_ARCHIVE_DIRECTORY and MEMORY_SHARED_ARCHIVE_NAMESPACE.
Keeps original UUID/body/hash/provenance in its original copied cell. It makes
no claim of Relay equivalence, canonical absence, deduplication or deletion.
Dedicated URLs: SHARED_FORWARD_SOURCE_URL and SHARED_FORWARD_TARGET_URL.
Committed pages resume idempotently; current legacy reader verifies the result.
No DSN/mode switch, backup, rollback or body export.`
export async function main(argv=process.argv.slice(2)){
 if(argv.length===0||argv[0]==='--help'){process.stdout.write(help+'\n');return 0}
 const flags:Record<string,string>={}
 for(let n=0;n<argv.length;n+=2){const flag=argv[n],value=argv[n+1];if(!['--input','--output'].includes(flag)||!value||value.startsWith('--')||flags[flag]){process.stderr.write('invalid_arguments\n');return 2}flags[flag]=value}
 if(!flags['--input']||!flags['--output']){process.stderr.write('required_arguments_missing\n');return 2}
 let source:Awaited<ReturnType<typeof connectMaintenance>>|undefined,target:Awaited<ReturnType<typeof connectMaintenance>>|undefined,bundle:ReportBundle|undefined,interrupted:number|undefined
 const controller=new AbortController(),interrupt=(code:number)=>{interrupted=code;controller.abort();void source?.close().catch(()=>{});void target?.close().catch(()=>{})},sigint=()=>interrupt(130),sigterm=()=>interrupt(143)
 process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
 try{
  if((await stat(flags['--input'])).size>8*1024*1024)throw Error('input_file_limit')
  const input=JSON.parse(await readFile(flags['--input'],'utf8'))
  if(!process.env.SHARED_FORWARD_SOURCE_URL||!process.env.SHARED_FORWARD_TARGET_URL)throw Error('dedicated_forward_urls_required')
  bundle=await ReportBundle.create(flags['--output'])
  source=await connectMaintenance({url:process.env.SHARED_FORWARD_SOURCE_URL,expected:input.source},true)
  target=await connectMaintenance({url:process.env.SHARED_FORWARD_TARGET_URL,expected:input.target},false)
  const directory=process.env.MEMORY_SHARED_ARCHIVE_DIRECTORY,namespace=process.env.MEMORY_SHARED_ARCHIVE_NAMESPACE
  if(Boolean(directory)!==Boolean(namespace))throw Error('source_archive_configuration_invalid')
  const archive=directory&&namespace?{storage:createSourceArchiveReader(directory,namespace),limits:{maxRawBytes:32*1024*1024,maxCompressedBytes:16*1024*1024,maxRecords:10000}}:undefined
  const receipt=await retainNecessaryOriginalPersonalReferencePage(source.client,target.client,input,{signal:controller.signal,archive})
  if(interrupted)throw Error('interrupted')
  await bundle.write('necessary-original-custody.json',receipt);await bundle.finish();bundle=undefined
  process.stdout.write('necessary_original_custody_completed\n');return 0
 }catch(error){process.stderr.write(interrupted?'interrupted\n':safeError(error)+'\n');return interrupted??2}
 finally{await target?.close();await source?.close();await bundle?.abort();process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
