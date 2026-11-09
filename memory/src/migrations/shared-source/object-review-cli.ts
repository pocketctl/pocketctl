/** Offline metadata review only. No database, application or model imports. */
import {readFile,stat} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {reviewMemoryObjects,reviewRelayObjects,type CatalogReviewProofs} from './object-review.js'
import {ReportBundle} from './report.js'
import type {CatalogObject} from './classification.js'
const usage='Offline object review: --inventory <inventory.json> --baseline <independently-rebuilt-inventory.json> --proofs <proofs.json> --relay-baseline <frozen-inventory.json> --output <new-directory>'
export async function main(args=process.argv.slice(2)):Promise<number>{
 let bundle:ReportBundle|undefined,interrupted:number|undefined
 const sigint=()=>{interrupted=130},sigterm=()=>{interrupted=143},check=()=>{if(interrupted)throw Error('interrupted')}
 process.once('SIGINT',sigint);process.once('SIGTERM',sigterm)
 try{
 if(args.includes('--help')){console.log(usage);return 0}
 const options=new Map<string,string>()
 for(let i=0;i<args.length;i+=2){if(!['--inventory','--baseline','--proofs','--relay-baseline','--output'].includes(args[i])||!args[i+1]||options.has(args[i]))throw Error('invalid_review_arguments');options.set(args[i],args[i+1])}
 if(options.size!==5)throw Error('invalid_review_arguments')
 const inputs:Record<string,{sha256:string;bytes:string}>=Object.create(null)
 const read=async(key:string)=>{if((await stat(options.get(key)!)).size>16*1024*1024)throw Error('invalid_review_input_size');const bytes=await readFile(options.get(key)!);inputs[key.slice(2)]={sha256:createHash('sha256').update(bytes).digest('hex'),bytes:String(bytes.length)};return JSON.parse(bytes.toString())}
 const inventory=await read('--inventory'),baseline=await read('--baseline'),proofs:CatalogReviewProofs=await read('--proofs'),relayBaseline=await read('--relay-baseline')
 const objects=(value:any):CatalogObject[]=>{
  if(!value||!Array.isArray(value.objects)||value.objects.some((o:any)=>!o||typeof o.key!=='string'||typeof o.kind!=='string'||typeof o.schema!=='string'||typeof o.name!=='string'||typeof o.definitionHash!=='string'))throw Error('invalid_review_inventory')
  return value.objects
 }
 if(inventory.schemaVersion!==1||inventory.reportType!=='inventory'||baseline.schemaVersion!==1||relayBaseline.schemaVersion!==1)throw Error('invalid_review_inventory')
 const memory=objects(inventory.memory),relay=objects(inventory.relay)
 const owner=(os:CatalogObject[])=>{const a=os.filter(o=>o.key.startsWith('permission:*.database.'));if(a.length!==1||typeof a[0].ownerFingerprint!=='string')throw Error('database_owner_not_unique');return a[0].ownerFingerprint}
 proofs.memoryDatabaseOwnerFingerprint=owner(memory);proofs.relayDatabaseOwnerFingerprint=owner(relay)
 const memoryReview=reviewMemoryObjects(memory,objects(baseline),proofs),relayReview=reviewRelayObjects(relay,objects(relayBaseline.relay),proofs.memoryDatabaseOwnerFingerprint)
 const complete=memoryReview.allObjectsReviewed&&memoryReview.sourceTableRosterComplete&&relayReview.allObjectsReviewed
 check();bundle=await ReportBundle.create(options.get('--output')!)
 const write=async(name:string,value:unknown)=>{check();await bundle!.write(name,value)}
  await write('memory-object-plan.json',memoryReview.plan)
  await write('relay-object-plan.json',relayReview.plan)
  await write('memory-object-review.json',memoryReview)
  await write('relay-object-review.json',relayReview)
  await write('review-receipt.json',{schemaVersion:1,reportType:'offline-catalog-review',createdAt:new Date().toISOString(),inputs,
   memoryObjects:String(memory.length),relayObjects:String(relay.length),sourceTableRosterComplete:memoryReview.sourceTableRosterComplete,
   allObjectsReviewed:complete,
   baselineContract:'independent-source-code-schema-plus-explicit-proofs',relayContract:'frozen-preservation-roster',
   databaseIdentities:[inventory.memory.identity.fingerprint,inventory.relay.identity.fingerprint],
   databaseAccessed:false,bodyExported:false,mappingExecuted:false,migrationAuthorized:false,
   limitations:['A disposition is not permission to copy, delete or activate. Full mapping, active dependencies and capacity are separate gates.','Live sequence state is point-in-time metadata and must be refreshed after the source is drained.']})
  check();await bundle.finish();bundle=undefined
 console.log(JSON.stringify({allObjectsReviewed:complete,memoryObjects:memory.length,relayObjects:relay.length,migrationAuthorized:false}))
 return complete?0:2
 }catch(error){console.error(interrupted?'interrupted':error instanceof Error&&/^(invalid_review_|database_owner_not_unique|report_exists|invalid_catalog_review_proofs)/.test(error.message)?error.message:'object_review_failed');return interrupted??2}
 finally{await bundle?.abort();process.off('SIGINT',sigint);process.off('SIGTERM',sigterm)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await main()
