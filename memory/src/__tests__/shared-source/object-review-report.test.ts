import {test,expect} from 'vitest'
import {reviewRelayObjects} from '../../migrations/shared-source/object-review.js'
const h='a'.repeat(64),changed='b'.repeat(64)
const object={key:'table:public.events',kind:'table',schema:'public',name:'events',definitionHash:h}
test('Relay preservation is bound to the exact frozen roster and hashes; drift never inherits retain approval',()=>{
 const result=reviewRelayObjects([object],[object])
 expect(result.plan[object.key]).toEqual({action:'retain-relay',definitionHash:h})
 expect(result.allObjectsReviewed).toBe(true)
 expect(reviewRelayObjects([{...object,definitionHash:changed}],[object]).allObjectsReviewed).toBe(false)
 expect(reviewRelayObjects([object,{...object,key:'table:public.new'}],[object]).unreviewed).toHaveLength(1)
 expect(reviewRelayObjects([],[object]).missing).toEqual([object.key])
 expect(reviewRelayObjects([object,object],[object]).allObjectsReviewed).toBe(false)
})
test('global Memory service role receives one consistent retirement disposition in both inventories',()=>{
 const role={...object,key:'role:*.'+h,kind:'role',schema:'*',name:h}
 expect(reviewRelayObjects([role],[role],h).plan[role.key].action).toBe('retire-after-gate')
 expect(reviewRelayObjects([{...role,definitionHash:changed}],[role],h).allObjectsReviewed).toBe(false)
})

test('offline CLI publishes private metadata atomically, refuses overwrite and cleans a real SIGINT between file writes',async()=>{
 const {mkdtemp,writeFile,readFile,readdir,stat,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path'),{pathToFileURL}=await import('node:url'),{spawnSync}=await import('node:child_process')
 const {TABLE_POLICY}=await import('../../migrations/shared-source/table-policy.js')
 const root=await mkdtemp(join(tmpdir(),'shared-object-review-')),owner='c'.repeat(64)
 try{
  const dbAcl={key:'permission:*.database.'+h,kind:'permission',schema:'*',name:h,definitionHash:h,ownerFingerprint:owner,grants:['CONNECT','CREATE','TEMPORARY'].map(privilege=>({grantorFingerprint:owner,granteeFingerprint:owner,public:false,privilege,grantable:false}))}
  const objects=Object.keys(TABLE_POLICY).map(name=>({key:'table:public.'+name,kind:'table',schema:'public',name,definitionHash:h,payload:'private-body-must-not-export'}))
  const inventory={schemaVersion:1,reportType:'inventory',credential:'postgres://private-credential-must-not-export',memory:{identity:{fingerprint:h},objects:[...objects,dbAcl]},relay:{identity:{fingerprint:owner},objects:[object,{...dbAcl,ownerFingerprint:owner}]}}
  const files:{[key:string]:unknown}={'inventory.json':inventory,'baseline.json':{schemaVersion:1,objects},'proofs.json':{internalTriggers:[],sequenceStateProofs:[],extensionMembers:[]}}
  for(const [name,value] of Object.entries(files))await writeFile(join(root,name),JSON.stringify(value),{mode:0o600})
  const args=['--inventory',join(root,'inventory.json'),'--baseline',join(root,'baseline.json'),'--proofs',join(root,'proofs.json'),'--relay-baseline',join(root,'inventory.json'),'--output',join(root,'review')]
  const cli=resolve('src/migrations/shared-source/object-review-cli.ts'),run=()=>spawnSync(process.execPath,['--import','tsx',cli,...args],{encoding:'utf8',timeout:10000})
  const normal=run();expect(normal.status,normal.stderr).toBe(0)
  for(const name of await readdir(join(root,'review'))){const file=join(root,'review',name);expect((await stat(file)).mode&0o777).toBe(0o600);expect(await readFile(file,'utf8')).not.toMatch(/private-body|private-credential|postgres:\/\//)}
  const again=run();expect(again.status).toBe(2);expect(again.stderr).toContain('report_exists')
  const interruptedArgs=[...args.slice(0,-1),join(root,'interrupted')]
  const runner=join(root,'interrupt.mjs')
  await writeFile(runner,`import {ReportBundle} from ${JSON.stringify(pathToFileURL(resolve('src/migrations/shared-source/report.ts')).href)};
import {main} from ${JSON.stringify(pathToFileURL(cli).href)};
const write=ReportBundle.prototype.write;
ReportBundle.prototype.write=async function(name,value){await write.call(this,name,value);if(name==='memory-object-plan.json'){process.kill(process.pid,'SIGINT');await new Promise(resolve=>setTimeout(resolve,20));}};
process.exitCode=await main(${JSON.stringify(interruptedArgs)});`)
  const interrupted=spawnSync(process.execPath,['--import','tsx',runner],{encoding:'utf8',timeout:10000})
  expect(interrupted.status,interrupted.stderr).toBe(130);expect(interrupted.stderr).toContain('interrupted')
  const names=await readdir(root);expect(names.some(name=>name.startsWith('.interrupted')||name==='interrupted'||name==='interrupted.lock')).toBe(false)
 }finally{await rm(root,{recursive:true,force:true})}
})
