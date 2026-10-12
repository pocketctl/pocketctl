import {createHash} from 'node:crypto'
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import type pg from 'pg'
import {assertMemoryTestDatabase} from './test-db.js'
const execute=promisify(execFile)
/** Destructive fixture measurement, deliberately unavailable from the plan CLI.
 * Requires the runner's fixed disposable database/role; never a business target. */
export async function measureInventoryRecovery(pool:pg.Pool,url:string,options:{beforeRestore?:()=>Promise<void>}={}){
 let target:URL
 try{target=new URL(url)}catch{throw Error('isolated_upgrade_database_required')}
 if(!['postgresql:','postgres:'].includes(target.protocol)||target.hostname!=='127.0.0.1'||target.username!=='pocketctl_memory_upgrade_test'||target.pathname!=='/pocketctl_memory_upgrade_test'||target.search)throw Error('isolated_upgrade_database_required')
 await assertMemoryTestDatabase(pool,url)
 const schemaVersion=Number((await pool.query('SELECT MAX(version) AS v FROM memory_schema_migrations')).rows[0].v)
 async function digest(){
  const names=(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows
  const hash=createHash('sha256')
  for(const {tablename} of names){
   const quoted='"'+String(tablename).replaceAll('"','""')+'"'
   const rows=(await pool.query(`SELECT to_jsonb(record)::text AS row FROM public.${quoted} record ORDER BY to_jsonb(record)::text`)).rows
   hash.update(JSON.stringify([tablename,rows]))
  }
  hash.update(JSON.stringify((await pool.query("SELECT sequencename,last_value,increment_by,cycle FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows))
  return hash.digest('hex')
 }
 const beforeDigest=await digest(),directory=await mkdtemp(join(tmpdir(),'inventory-recovery-')),backup=join(directory,'fixture.dump')
 const env={PATH:process.env.PATH,PGHOST:target.hostname,PGPORT:target.port||'5432',PGUSER:target.username,PGPASSWORD:decodeURIComponent(target.password),PGDATABASE:'pocketctl_memory_upgrade_test'}
 try{
  let started=performance.now()
  await execute('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',backup],{env,timeout:30000,maxBuffer:1024*1024})
  const backupMs=Math.round(performance.now()-started),backupBytes=(await stat(backup)).size,backupHash=createHash('sha256').update(await readFile(backup)).digest('hex')
  await options.beforeRestore?.()
  started=performance.now()
  await execute('pg_restore',['--clean','--if-exists','--no-owner','--no-privileges','--exit-on-error','--dbname','pocketctl_memory_upgrade_test',backup],{env,timeout:30000,maxBuffer:1024*1024})
  const restoreMs=Math.round(performance.now()-started),afterDigest=await digest()
  if(afterDigest!==beforeDigest)throw Error('isolated_recovery_digest_mismatch')
  return {backupBytes,backupMs,restoreMs,backupHash,beforeDigest,afterDigest,schemaVersion,productionEstimate:false}
 }catch{throw Error('isolated_recovery_failed')}
 finally{await rm(directory,{recursive:true,force:true})}
}
