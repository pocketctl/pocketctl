import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { fingerprint } from './report.js'
import {assertFrozenMemorySource} from './maintenance.js'
export interface ExpectedIdentity {database:string;role:string;serverAddress:string;serverPort:string;databaseOid?:string;mode:'inventory'|'isolated-restore'|'frozen-maintenance'|'live-readonly';maintenanceWindowId?:string}
export interface DatabaseConfig {connectionString:string;expected:ExpectedIdentity}
export interface Snapshot {
  client:pg.PoolClient
  expected:ExpectedIdentity
  identity:{fingerprint:string;databaseFingerprint:string;serverVersion:string;snapshotId:string;databaseSnapshot:string;startedAt:string;crossDatabaseAtomic:false;maintenanceWindowId?:string;maintenanceFenceVerified?:boolean}
  currentNativeSessionAuthority?(sessionId:string,ownerUserId:number,eventId?:string):Promise<Record<string,any>>
  close():Promise<void>
  cancel():Promise<void>
}
export async function openSnapshot(config:DatabaseConfig):Promise<Snapshot> {
  const expected=config.expected
  if(!expected || !['database','role','serverAddress','serverPort'].every(k=>typeof expected[k as keyof ExpectedIdentity]==='string' && expected[k as keyof ExpectedIdentity])
    || !['inventory','isolated-restore','frozen-maintenance','live-readonly'].includes(expected.mode))throw new Error('expected_database_identity_required')
  if(['frozen-maintenance','live-readonly'].includes(expected.mode)&&! /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(expected.maintenanceWindowId??''))throw Error('maintenance_window_id_required')
  const pool=new pg.Pool({connectionString:config.connectionString,max:1,connectionTimeoutMillis:5000,
    options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c search_path=pg_catalog',application_name:'pocketctl-shared-source-readonly'})
  let client:pg.PoolClient|undefined
  try{
    client=await pool.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'")
    await client.query('SET LOCAL search_path=pg_catalog')
    // Fail rather than returning silently filtered rows under RLS.
    await client.query('SET LOCAL row_security=off')
    const row=(await client.query(`SELECT current_database() AS database,current_user AS role,
      inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort",
      d.oid::text AS "databaseOid",current_setting('server_version_num') AS version,
      txid_current_snapshot()::text AS snapshot,transaction_timestamp()::text AS started
      FROM pg_catalog.pg_database d WHERE d.datname=current_database()`)).rows[0]
    for(const key of ['database','role','serverAddress','serverPort','databaseOid'] as const)
      if(expected[key]!==undefined && expected[key]!==row[key])throw new Error('database_identity_mismatch')
    const major=Math.floor(Number(row.version)/10000)
    if(major<13)throw new Error('unsupported_postgres_version')
    if(expected.mode==='frozen-maintenance')await assertFrozenMemorySource(client)
    const identity={databaseFingerprint:fingerprint(JSON.stringify([row.database,row.databaseOid,row.serverAddress,row.serverPort])),fingerprint:fingerprint(JSON.stringify([row.database,row.databaseOid,row.serverAddress,row.serverPort,row.role])),
      serverVersion:row.version,snapshotId:randomUUID(),databaseSnapshot:row.snapshot,startedAt:row.started,crossDatabaseAtomic:false as const,
      ...(['frozen-maintenance','live-readonly'].includes(expected.mode)?{maintenanceWindowId:expected.maintenanceWindowId,maintenanceFenceVerified:expected.mode==='frozen-maintenance'}:{})}
    let closed=false
    const nativeConfig={connectionString:config.connectionString,expected:{...expected}}
    return {client,expected,identity,currentNativeSessionAuthority:(id,owner,eventId)=>currentNativeSessionAuthority(nativeConfig,id,owner,eventId),async cancel(){
      if(closed)return;closed=true
      client!.release(true);await pool.end()
    },async close(){
      if(closed)return;closed=true
      try{await client!.query('ROLLBACK')}finally{client!.release();await pool.end()}
    }}
  }catch(error){
    if(client){await client.query('ROLLBACK').catch(()=>undefined);client.release(true)}
    await pool.end();throw error
  }
}
export function assertRestored(snapshot:Snapshot):void {
  if(snapshot.expected.mode!=='isolated-restore' || !/(^|_)(test|restore|rehearsal)(_|$)/i.test(snapshot.expected.database))
    throw new Error('mapping_requires_isolated_restore')
}
export function assertMappingSnapshots(memory:Snapshot,relay:Snapshot){
 if(memory.expected.mode==='frozen-maintenance'){
  if(memory.identity.maintenanceFenceVerified!==true||relay.expected.mode!=='live-readonly'||memory.identity.maintenanceWindowId!==relay.identity.maintenanceWindowId)throw Error('maintenance_mapping_scope_mismatch')
  assertDistinctDatabases(memory.identity,relay.identity);return
 }
 assertRestored(memory);assertRestored(relay)
}
export function safeError(error:unknown):string {
  const code=(error as {code?:unknown})?.code
  if(typeof code==='string' && /^[0-9A-Z]{5}$/.test(code))return 'postgres_'+code
  const message=(error as Error)?.message
  return typeof message==='string' && /^[a-z][a-z0-9_:-]{0,160}$/.test(message)?message:'maintenance_failed'
}

export function assertDistinctDatabases(a:{databaseFingerprint:string},b:{databaseFingerprint:string}):void {
  if(a.databaseFingerprint===b.databaseFingerprint)throw new Error('distinct_databases_required')
}

/** Fresh observation, deliberately separate from the historical RR snapshot.
 * It can authorize current native routing only, never caller-selected SQL. */
async function currentNativeSessionAuthority(config:DatabaseConfig,sessionId:string,ownerUserId:number,eventId?:string):Promise<Record<string,any>>{
 if(typeof sessionId!=='string'||sessionId.length<1||sessionId.length>128||!Number.isSafeInteger(ownerUserId)||ownerUserId<=0)throw Error('native_current_authority_invalid')
 if(eventId!==undefined&&!/^[1-9][0-9]{0,18}$/.test(eventId))throw Error('native_current_event_invalid')
 const client=new pg.Client({connectionString:config.connectionString,connectionTimeoutMillis:5000,query_timeout:5000,
  options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=5000 -c search_path=pg_catalog',application_name:'pocketctl-native-current-authority'})
 client.on('error',()=>{})
 let timedOut=false
 const timer=setTimeout(()=>{timedOut=true;void client.end().catch(()=>{})},8000)
 try{
  await client.connect();await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')
  const row=(await client.query(`SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS "serverAddress",
   inet_server_port()::text AS "serverPort",d.oid::text AS "databaseOid" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  for(const key of ['database','role','serverAddress','serverPort','databaseOid'] as const)
   if(config.expected[key]!==undefined&&row[key]!==config.expected[key])throw Error('database_identity_mismatch')
  const authority=eventId===undefined
   ?(await client.query('SELECT public.native_session_authority($1,$2,NULL) AS authority',[sessionId,ownerUserId])).rows[0]?.authority
   :(await client.query('SELECT public.native_event_authority($1::bigint,$2) AS authority',[eventId,ownerUserId])).rows[0]?.authority
  if(eventId!==undefined&&authority?.state==='current'&&(authority.eventId!==eventId||authority.logicalSessionId!==sessionId||authority.ownerRetired!==false))throw Error('native_current_event_invalid')
  if(authority?.state==='current'&&authority.contractVersion!==3)throw Error('native_current_contract_unknown')
  if(!authority||typeof authority!=='object'||Array.isArray(authority)||timedOut)throw Error('native_current_authority_unavailable')
  await client.query('COMMIT');return authority
 }catch{throw Error('native_current_authority_unavailable')}
 finally{clearTimeout(timer);await Promise.race([client.end().catch(()=>{}),new Promise<void>(resolve=>{const t=setTimeout(resolve,1000);t.unref()})])}
}
