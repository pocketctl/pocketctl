import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { recoverRuntime } from './recover-runtime.js'

const args=process.argv.slice(2)
if (!args[0] || args.some((arg,i)=>i>0 && arg!=='--apply') || args.length>2) {
  throw new Error('usage: node --env-file=.env dist/maintenance/recover-runtime-cli.js manifest.json [--apply]')
}
const rawManifest=await readFile(args[0],'utf8')
if(Buffer.byteLength(rawManifest)>1024*1024)throw new Error('recovery_manifest_too_large')
const manifest=JSON.parse(rawManifest)
if (!manifest || typeof manifest.installationId!=='string' || !/^[0-9a-f-]{36}$/i.test(manifest.installationId)
  || (manifest.discoveryEnvelopes!==undefined && !Array.isArray(manifest.discoveryEnvelopes))
  || (manifest.failedRunIds!==undefined && (!Array.isArray(manifest.failedRunIds) || manifest.failedRunIds.some((id:unknown)=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))))) throw new Error('invalid_recovery_manifest')
if(!process.env.MEMORY_DATABASE_URL)throw new Error('MEMORY_DATABASE_URL required')
const pool=new pg.Pool({connectionString:process.env.MEMORY_DATABASE_URL,max:1})
try {
  console.log(JSON.stringify(await recoverRuntime(pool,{installationId:manifest.installationId,discoveryEnvelopes:manifest.discoveryEnvelopes,failedRunIds:manifest.failedRunIds,apply:args.includes('--apply')})))
} finally { await pool.end() }
