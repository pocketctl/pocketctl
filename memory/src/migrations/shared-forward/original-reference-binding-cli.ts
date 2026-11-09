import {readFile,stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {bindOriginalPersonalReferencePage} from './original-reference-binding.js'
import {connectMaintenance} from './source-maintenance-common.js'
import {ReportBundle} from '../shared-source/report.js'
import {safeError} from '../shared-source/database.js'
import {createSourceArchiveReader} from '../../sources/archive-reader.js'
const help=`Finite offline original personal UUID binding (1..256 rows, one Session).
  --input FILE --output NEW_DIR
Input: {source:{database,databaseOid,role,serverAddress,serverPort},target:{...},copy,scope,root,mappings}.
copy is the exact forward-verification.json emitted after successful transfer verification.
Dedicated URLs: SHARED_FORWARD_SOURCE_URL and SHARED_FORWARD_TARGET_URL.
Both database identities are exact; the source must still be frozen and target
Memory writers fenced. Current reader and COMMIT authority are checked afresh.
Cold bodies require MEMORY_SHARED_ARCHIVE_DIRECTORY and MEMORY_SHARED_ARCHIVE_NAMESPACE.
No body deletion, UUID/provenance rewrite, DSN/mode switch, backup or rollback.
Interrupted pages roll back; committed pages are idempotently resumable.`
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
  const receipt=await bindOriginalPersonalReferencePage(source.client,target.client,input,{signal:controller.signal,archive})
  if(interrupted)throw Error('interrupted')
  await bundle.write('original-reference-binding.json',receipt);await bundle.finish();bundle=undefined
  process.stdout.write('original_reference_binding_completed\n');return 0
 }catch(error){process.stderr.write(interrupted?'interrupted\n':safeError(error)+'\n');return interrupted??2}
 finally{await target?.close();await source?.close();await bundle?.abort();process.removeListener('SIGINT',sigint);process.removeListener('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
