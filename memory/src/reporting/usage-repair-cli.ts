import pg from 'pg'
import {lstat,readFile,writeFile} from 'node:fs/promises'
import {planUsageRepair,applyUsageRepair} from './usage-repair.js'
const help=`Usage accounting only: no model calls and no source replay.
  plan --ids PRIVATE_JSON --output NEW_JSON
  apply --manifest PRIVATE_JSON --output NEW_JSON
Keys: exact [{installationId,usageId}], at most 100; only invalid_request dead letters.
MEMORY_USAGE_REPAIR_URL and RELAY_USAGE_REPAIR_URL provide database connections.
MEMORY_USAGE_REPAIR_SCHEMA=memory (or public for isolated legacy tests).
Both identities and immutable fact digests are frozen. Apply rechecks Relay facts,
marks matching facts reported, and requeues absent facts for the ordinary reporter.
Run only AFTER the Relay usage contract fix is deployed. Provider unknown outcomes
require independent provider evidence; this tool cannot retry or reconcile those.`
const args=process.argv.slice(2)
if(args.length===0||args[0]==='--help'){console.log(help)}else{
 let memory:pg.Client|undefined,relay:pg.Client|undefined
 try{
  const [action,...raw]=args,flags:Record<string,string>={}
  if(!['plan','apply'].includes(action))throw Error('invalid_command')
  for(let i=0;i<raw.length;i+=2){if(!['--ids','--manifest','--output'].includes(raw[i])||!raw[i+1]||flags[raw[i]])throw Error('invalid_arguments');flags[raw[i]]=raw[i+1]}
  const file=flags[action==='plan'?'--ids':'--manifest']
  if(!file||!flags['--output']||flags[action==='plan'?'--manifest':'--ids'])throw Error('invalid_arguments')
  const stat=await lstat(file)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>128*1024)throw Error('private_manifest_required')
  const input=JSON.parse(await readFile(file,'utf8'))
  const schema=process.env.MEMORY_USAGE_REPAIR_SCHEMA??'memory'
  if(!['memory','public'].includes(schema)||!process.env.MEMORY_USAGE_REPAIR_URL||!process.env.RELAY_USAGE_REPAIR_URL)throw Error('repair_configuration_required')
  // Reserve the private output before any mutation; no overwriting receipts.
  await writeFile(flags['--output'],JSON.stringify({state:'incomplete',action})+'\n',{flag:'wx',mode:0o600})
  memory=new pg.Client({connectionString:process.env.MEMORY_USAGE_REPAIR_URL,connectionTimeoutMillis:3000,query_timeout:6000})
  relay=new pg.Client({connectionString:process.env.RELAY_USAGE_REPAIR_URL,connectionTimeoutMillis:3000,query_timeout:6000,options:'-c default_transaction_read_only=on -c statement_timeout=4000'})
  await memory.connect();await relay.connect()
  await memory.query('BEGIN'+(action==='plan'?' READ ONLY':''));await memory.query(`SET LOCAL search_path TO ${schema},public;SET LOCAL statement_timeout='4s';SET LOCAL lock_timeout='500ms'`)
  await relay.query('BEGIN READ ONLY');await relay.query('SET LOCAL search_path TO public')
  const result=action==='plan'?await planUsageRepair(memory,relay,input):await applyUsageRepair(memory,relay,input)
  await relay.query('COMMIT');await memory.query('COMMIT')
  await writeFile(flags['--output'],JSON.stringify(result,null,2)+'\n',{mode:0o600})
  console.log('usage_repair_completed')
 }catch(error){await memory?.query('ROLLBACK').catch(()=>undefined);await relay?.query('ROLLBACK').catch(()=>undefined)
  const message=error instanceof Error?error.message:''
  console.error(/^(usage_|exact_usage_|private_manifest_|repair_configuration_|invalid_)[a-z_]+$/.test(message)?message:'usage_repair_failed');process.exitCode=2
 }finally{await memory?.end().catch(()=>undefined);await relay?.end().catch(()=>undefined)}
}
