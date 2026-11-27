import {readFile} from 'node:fs/promises'
import {createMemoryPool} from '../db.js'
import {recoverLegacyDialogueJobs} from './legacy-dialogue-repair.js'

const databaseUrl=process.env.MEMORY_DATABASE_URL??process.env.DATABASE_URL
const [action,file,...extra]=process.argv.slice(2)
if(!['plan','apply'].includes(action)||!file||extra.length||!databaseUrl)
  throw Error('Usage: MEMORY_DATABASE_URL=... node dist/episodes/legacy-dialogue-repair-cli.js plan|apply exact-keys-or-plan.json')
const pool=createMemoryPool({databaseUrl,databaseNamespace:'memory',dbPoolMax:1})
try{
  const input=JSON.parse(await readFile(file,'utf8'))
  const keys=action==='plan'?input:input.map((row:{state:string;manifest?:unknown})=>{
    if(row.state!=='verified'||!row.manifest)throw Error('verified_dialogue_manifest_required')
    return row.manifest
  })
  const result=await recoverLegacyDialogueJobs(pool,keys,action==='apply')
  console.log(JSON.stringify(result))
  if(result.some(row=>row.state==='unverified'||row.state==='busy'))process.exitCode=1
}finally{await pool.end()}
