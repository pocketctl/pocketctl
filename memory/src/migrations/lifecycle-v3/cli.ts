import {readFileSync,writeFileSync} from 'node:fs'
import pg from 'pg'
import {inventoryLifecycle,manifestDigest,type LifecycleManifest,type LifecycleMode} from './inventory.js'
import {applyLifecycleManifest} from './backfill.js'
import {verifyLifecycleManifest} from './verification.js'
// No startup/schema application and no URL argument that can leak into process
// listings. All commands require an explicit fixed owner list or manifest.
async function main(){
 const [command,...args]=process.argv.slice(2),values=new Map<string,string>()
 for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1]||values.has(args[i]))throw new Error('invalid_arguments');values.set(args[i],args[i+1])}
 if(!['plan','apply','verify'].includes(command))throw new Error('command_must_be_plan_apply_verify')
 const allowed=command==='plan'?['--owners','--output','--target-mode']:command==='apply'?['--manifest','--expected-digest','--policy-version','--batch-size']:['--manifest']
 if([...values.keys()].some(k=>!allowed.includes(k)))throw new Error('invalid_arguments')
 const url=process.env.MEMORY_DATABASE_URL;if(!url)throw new Error('database_configuration_missing')
 const pool=new pg.Pool({connectionString:url})
 try{
  if(command==='plan'){
   const output=values.get('--output');if(!output)throw new Error('output_required')
   const m=await inventoryLifecycle(pool,(values.get('--owners')??'').split(',').filter(Boolean),{targetMode:values.get('--target-mode') as LifecycleMode|undefined})
   writeFileSync(output,JSON.stringify(m,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({status:'planned',digest:manifestDigest(m),count:m.items.length,read_only:true}))
  }else{
   const path=values.get('--manifest');if(!path)throw new Error('manifest_required');const m=JSON.parse(readFileSync(path,'utf8')) as LifecycleManifest
   const result=command==='verify'?await verifyLifecycleManifest(pool,m):await applyLifecycleManifest(pool,m,{expectedDigest:values.get('--expected-digest')??'',policyVersion:values.get('--policy-version')??'',batchSize:values.has('--batch-size')?Number(values.get('--batch-size')):undefined})
   console.log(JSON.stringify(result));if('status'in result&&result.status!=='pass')process.exitCode=1
  }
 }finally{await pool.end()}
}
main().catch(error=>{const code=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'lifecycle_migration_failed';console.error(JSON.stringify({status:'error',reason:code}));process.exitCode=2})
