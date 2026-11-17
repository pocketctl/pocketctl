import {createHash} from 'node:crypto'
import type pg from 'pg'
import {MEMORY_USAGE_OPERATIONS} from './memory-usage-contract.js'

type DB=Pick<pg.PoolClient,'query'>
export interface UsageRepairKey {installationId:string;usageId:string}
interface Fact {installation_id:string;usage_id:string;operation:string;model:string|null;input_tokens:string;output_tokens:string;embedding_tokens:string;cached_tokens:string;cost_micros:string;occurred_at:Date}
interface Entry extends UsageRepairKey {digest:string;attempts:number;deadLetteredAt:string}
export interface UsageRepairManifest {version:1;kind:'memory-usage-repair';database:Record<string,unknown>;relayDatabase:Record<string,unknown>;entries:Entry[]}
const columns='installation_id::text,usage_id,operation,model,input_tokens::text,output_tokens::text,embedding_tokens::text,cached_tokens::text,cost_micros::text,occurred_at'
const identity=async(db:DB)=>(await db.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port`)).rows[0]
export function usageFactDigest(f:Fact):string {
 if(!(MEMORY_USAGE_OPERATIONS as readonly string[]).includes(f.operation)||!f.usage_id||f.usage_id.length>128||f.model&&f.model.length>128)throw Error('usage_fact_invalid')
 const counters=[f.input_tokens,f.output_tokens,f.embedding_tokens,f.cached_tokens,f.cost_micros].map(v=>{
  if(!/^\d+$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw Error('usage_fact_invalid');return String(BigInt(v))
 })
 const at=new Date(f.occurred_at)
 if(!Number.isFinite(at.getTime())||at.getTime()>Date.now()+300000)throw Error('usage_fact_invalid')
 return createHash('sha256').update(JSON.stringify([f.installation_id,f.usage_id,f.operation,f.model||null,...counters,at.toISOString()])).digest('hex')
}
function validateKeys(keys:UsageRepairKey[]) {
 if(!Array.isArray(keys)||keys.length<1||keys.length>100||new Set(keys.map(k=>k.installationId+'\0'+k.usageId)).size!==keys.length)throw Error('exact_usage_scope_required')
 for(const key of keys)if(!/^[0-9a-f-]{36}$/i.test(key.installationId)||!key.usageId||key.usageId.length>128)throw Error('exact_usage_scope_required')
}
async function ledgerState(relay:DB,key:UsageRepairKey,digest:string){
 const row=(await relay.query<Fact>(`SELECT ${columns} FROM extension_provider_usage_facts WHERE installation_id=$1 AND usage_id=$2`,[key.installationId,key.usageId])).rows[0]
 if(!row)return 'missing'
 if(usageFactDigest(row)!==digest)throw Error('usage_ledger_conflict')
 return 'reported'
}
/** Caller uses a read-only transaction. Never scans an unbounded dead-letter set. */
export async function planUsageRepair(memory:DB,relay:DB,keys:UsageRepairKey[]):Promise<UsageRepairManifest>{
 validateKeys(keys)
 const entries:Entry[]=[]
 for(const key of keys){
  const row=(await memory.query(`SELECT ${columns},attempts,dead_lettered_at,reported_at,last_error_code FROM memory_usage_outbox WHERE installation_id=$1 AND usage_id=$2`,[key.installationId,key.usageId])).rows[0]
  if(!row||row.reported_at||!row.dead_lettered_at||row.last_error_code!=='invalid_request')throw Error('usage_repair_not_eligible')
  const digest=usageFactDigest(row);await ledgerState(relay,key,digest)
  entries.push({...key,digest,attempts:row.attempts,deadLetteredAt:new Date(row.dead_lettered_at).toISOString()})
 }
 return {version:1,kind:'memory-usage-repair',database:await identity(memory),relayDatabase:await identity(relay),entries}
}
/** Caller owns one short transaction. Only reporting state changes; model work,
 * budgets, original fact payload and provider-result-unknown records are untouched. */
export async function applyUsageRepair(memory:DB,relay:DB,manifest:UsageRepairManifest){
 if(manifest?.version!==1||manifest.kind!=='memory-usage-repair')throw Error('usage_manifest_invalid')
 validateKeys(manifest.entries)
 if(JSON.stringify(await identity(memory))!==JSON.stringify(manifest.database)||JSON.stringify(await identity(relay))!==JSON.stringify(manifest.relayDatabase))throw Error('usage_database_identity_changed')
 const result:Array<UsageRepairKey&{state:string}>=[]
 for(const entry of [...manifest.entries].sort((a,b)=>(a.installationId+a.usageId).localeCompare(b.installationId+b.usageId))){
  const row=(await memory.query(`SELECT ${columns},attempts,dead_lettered_at,reported_at,last_error_code FROM memory_usage_outbox WHERE installation_id=$1 AND usage_id=$2 FOR UPDATE`,[entry.installationId,entry.usageId])).rows[0]
  if(!row||usageFactDigest(row)!==entry.digest)throw Error('usage_fact_changed')
  const ledger=await ledgerState(relay,entry,entry.digest)
  if(row.reported_at&&ledger!=='reported')throw Error('usage_report_unverified')
  if(row.reported_at){result.push({...entry,state:'already_reported'});continue}
  if(!row.dead_lettered_at){result.push({...entry,state:'already_requeued'});continue}
  if(new Date(row.dead_lettered_at).toISOString()!==entry.deadLetteredAt||row.attempts!==entry.attempts||row.last_error_code!=='invalid_request')throw Error('usage_repair_state_changed')
  await memory.query(`UPDATE memory_usage_outbox SET dead_lettered_at=NULL,last_error_code=NULL,
    attempts=CASE WHEN $3 THEN attempts ELSE 0 END,reported_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END
    WHERE installation_id=$1 AND usage_id=$2`,[entry.installationId,entry.usageId,ledger==='reported'])
  result.push({...entry,state:ledger==='reported'?'reconciled':'requeued'})
 }
 return result
}
