import {constants} from 'node:fs'
import {open,mkdir,lstat,readdir,rename,unlink,realpath} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {hostname} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import type pg from 'pg'
import {inventoryMemory} from '../migrations/governance-v2/inventory.js'

const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const receiptName=new RegExp(`^(${uuid})\\.receipt\\.json$`)
const partialName=new RegExp(`^${uuid}\\.details\\.ndjson\\.partial$`)
const flags=constants.O_RDONLY|constants.O_NOFOLLOW
async function owned(path:string){const s=await lstat(path);if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(!s.isFile()&&!s.isDirectory()))throw new Error('unsafe_retention_report_path');return s}
async function root(directory:string){const dir=resolve(directory);await mkdir(dir,{recursive:true,mode:0o700});const s=await owned(dir);if(!s.isDirectory()||await realpath(dir)!==dir)throw new Error('unsafe_retention_report_directory');return dir}
async function readJson(path:string){await owned(path);const f=await open(path,flags);try{const s=await f.stat();if(!s.isFile()||s.size>262144)throw new Error('invalid_report_receipt');return JSON.parse(await f.readFile('utf8'))}finally{await f.close()}}
async function verifyDetail(path:string,expected:string){
 let file
 try{await owned(path);file=await open(path,flags)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e}
 try{const s=await file.stat();if(!s.isFile())throw new Error('unsafe_retention_report_path');const h=createHash('sha256');for await(const chunk of file.createReadStream({autoClose:false}))h.update(chunk);if(h.digest('hex')!==expected)throw new Error('report_hash_mismatch');return true}finally{await file.close()}
}
async function writeAtomic(path:string,value:unknown){const temp=path+'.'+randomUUID()+'.tmp',f=await open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify(value));await f.sync()}finally{await f.close()}await rename(temp,path)}
async function lock<T>(directory:string,fn:(dir:string)=>Promise<T>):Promise<T|undefined>{
 const dir=await root(directory),path=join(dir,'.retention.lock')
 let f
 try{f=await open(path,'wx',0o600)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e
  // An unreadable, foreign-host or live lock is never assumed abandoned.
  try{const s=await owned(path),v=await readJson(path);if(v.host!==hostname()||!Number.isInteger(v.pid)||v.pid<1||Date.now()-s.mtimeMs<3600000)return
   try{process.kill(v.pid,0);return}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')return}
   const current=await owned(path);if(current.ino!==s.ino)return;await unlink(path)
  }catch{return}
  try{f=await open(path,'wx',0o600)}catch{return}
 }
 try{await f.writeFile(JSON.stringify({pid:process.pid,host:hostname()}));await f.sync();return await fn(dir)}finally{await f.close();await unlink(path)}
}

/** Only this explicit command enrolls an inventory export into managed expiry.
 * Arbitrary --details exports and backups are never scanned. */
export async function createManagedInventoryReport(pool:pg.Pool,directory:string,migrationRunId?:string){
 return lock(directory,async dir=>{
  if(migrationRunId&&!(await pool.query('SELECT 1 FROM memory_governance_migration_runs WHERE run_id=$1',[migrationRunId])).rowCount)throw new Error('migration_run_missing')
  const id=randomUUID(),partial=join(dir,id+'.details.ndjson.partial'),details=join(dir,id+'.details.ndjson'),f=await open(partial,'wx',0o600),hash=createHash('sha256')
  let inventory
  try{inventory=await inventoryMemory(pool,{onFindingBatch:async items=>{for(const item of items){const line=JSON.stringify(item)+'\n';hash.update(line);await f.writeFile(line)}}});await f.sync()}finally{await f.close()}
  // Receipt is durable before cleanup can ever own the directory lock.
  const receipt={format:'pocketctl-memory-inventory-v1',id,createdAt:new Date().toISOString(),migrationRunId:migrationRunId??null,
   detailsHash:hash.digest('hex'),detailsReclaimedAt:null,summary:{schemaVersion:inventory.schemaVersion,compatible:inventory.compatible,
    counts:inventory.counts,findingCounts:inventory.findingCounts,tableBytes:inventory.tableBytes,environmentFingerprint:inventory.environmentFingerprint}}
  await writeAtomic(join(dir,id+'.receipt.json'),receipt)
  await rename(partial,details)
  return {id,details,receipt:join(dir,id+'.receipt.json')}
 })
}

export async function retainInventoryReports(pool:Pick<pg.Pool,'query'>,directory:string,limit=500){
 return await lock(directory,async dir=>{
  let reclaimed=0,partials=0,examined=0
  // Directory is dedicated and opt-in. Only our exact UUID namespace is read.
  for(const name of await readdir(dir)){
   if(examined>=limit)break
   if(partialName.test(name)){
    const path=join(dir,name),s=await owned(path);if(Date.now()-s.mtimeMs>=14*86400000){await unlink(path);partials++;examined++}continue
   }
   const match=receiptName.exec(name);if(!match)continue
   const path=join(dir,name),v=await readJson(path)
   if(v.format!=='pocketctl-memory-inventory-v1'||v.id!==match[1]||v.detailsReclaimedAt||!Number.isFinite(Date.parse(v.createdAt))||Date.now()-Date.parse(v.createdAt)<14*86400000)continue
   if(v.migrationRunId){const run=(await pool.query('SELECT details_reclaimed_at FROM memory_governance_migration_runs WHERE run_id=$1',[v.migrationRunId])).rows[0];if(!run?.details_reclaimed_at)continue}
   examined++
   const details=join(dir,match[1]+'.details.ndjson')
   const exists=await verifyDetail(details,v.detailsHash)
   // Compact summary precedes detail removal. Marked receipts also resume a
   // crash between these two operations on the next pass.
   await writeAtomic(path,{...v,detailsReclaimedAt:new Date().toISOString()})
   if(exists){await unlink(details);reclaimed++}
  }
  // Resume a previously committed receipt whose detail unlink was interrupted.
  for(const name of await readdir(dir)){
   if(reclaimed>=limit)break
   const m=receiptName.exec(name);if(!m)continue
   const v=await readJson(join(dir,name));if(v.format!=='pocketctl-memory-inventory-v1'||v.id!==m[1]||!v.detailsReclaimedAt)continue
   const details=join(dir,m[1]+'.details.ndjson');if(await verifyDetail(details,v.detailsHash)){await unlink(details);reclaimed++}
  }
  return {reports:reclaimed,partials,busy:false}
 })??{reports:0,partials:0,busy:true}
}
