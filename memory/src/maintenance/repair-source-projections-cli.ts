import pg from 'pg'
import {lstat,readFile,writeFile} from 'node:fs/promises'
import {planSourceProjectionRepair,applySourceProjectionRepair} from './repair-source-projections.js'
const args=process.argv.slice(2)
if(args.length===0||args[0]==='--help')console.log(`Source projection repair only. No model calls, source rewrites, provenance backfill or global resets.
  plan --jobs PRIVATE_JSON_ARRAY --output NEW_JSON
  apply --manifest PRIVATE_JSON --output NEW_JSON
MEMORY_SOURCE_REPAIR_URL: shared Memory database; schema memory. Exact 1..32 dead
personal project_shared_source IDs. Plan freezes database identity, payload,
claim epoch and current source authority. Apply refuses changed facts and retains
checkpoints and dead-letter audit. Generic legacy failures additionally require a
current seal, no checkpoint and a reproducible first page of unhashed cold records. Deploy/verify the cause fix FIRST. Compilation,
provider_result_unknown, paid work and reference repairs require separate review.`)
else{
 let client:pg.Client|undefined
 try{
  const [action,...raw]=args,flags:Record<string,string>={}
  if(!['plan','apply'].includes(action))throw Error('source_repair_invalid_command')
  for(let i=0;i<raw.length;i+=2){if(!['--jobs','--manifest','--output'].includes(raw[i])||!raw[i+1]||flags[raw[i]])throw Error('source_repair_invalid_arguments');flags[raw[i]]=raw[i+1]}
  const file=flags[action==='plan'?'--jobs':'--manifest']
  if(!file||!flags['--output']||flags[action==='plan'?'--manifest':'--jobs']||!process.env.MEMORY_SOURCE_REPAIR_URL)throw Error('source_repair_configuration_required')
  const stat=await lstat(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>128*1024)throw Error('source_repair_private_manifest_required')
  const input=JSON.parse(await readFile(file,'utf8'))
  await writeFile(flags['--output'],JSON.stringify({state:'incomplete',action})+'\n',{flag:'wx',mode:0o600})
  client=new pg.Client({connectionString:process.env.MEMORY_SOURCE_REPAIR_URL,connectionTimeoutMillis:3000,query_timeout:6000});await client.connect()
  await client.query('BEGIN'+(action==='plan'?' READ ONLY':''));await client.query("SET LOCAL search_path TO memory,public;SET LOCAL statement_timeout='4s';SET LOCAL lock_timeout='500ms'")
  const result=action==='plan'?await planSourceProjectionRepair(client,input):await applySourceProjectionRepair(client,input)
  await client.query('COMMIT');await writeFile(flags['--output'],JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log('source_repair_completed')
 }catch(error){await client?.query('ROLLBACK').catch(()=>undefined);const m=error instanceof Error?error.message:'';console.error(/^source_repair_[a-z_]+$/.test(m)?m:'source_repair_failed');process.exitCode=2}
 finally{await client?.end().catch(()=>undefined)}
}
