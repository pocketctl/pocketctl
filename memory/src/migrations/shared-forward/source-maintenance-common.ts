import pg from 'pg'
import {createHash} from 'node:crypto'
import {canonicalJsonString} from '@pocketctl/session-source'
export interface MaintenanceDatabase {url:string;expected:{database:string;databaseOid:string;role:string;serverAddress:string;serverPort:string}}
export const hash=(value:unknown)=>createHash('sha256').update(canonicalJsonString(value)).digest('hex')
export const qi=(value:string)=>'"'+value.replaceAll('"','""')+'"'
const clients=new Set<pg.Client>(),closing=new WeakMap<pg.Client,Promise<void>>()
function close(c:pg.Client){let pending=closing.get(c);if(!pending){pending=c.end().finally(()=>clients.delete(c));closing.set(c,pending)}return pending}
export async function cancelSourceMaintenance(){await Promise.allSettled([...clients].map(close))}
export async function connectMaintenance(config:MaintenanceDatabase,readOnly:boolean){
 if(!config?.expected||Object.values(config.expected).length!==5||Object.values(config.expected).some(v=>typeof v!=='string'||!v))throw Error('expected_database_identity_required')
 const c=new pg.Client({connectionString:config.url,application_name:'pocketctl-source-maintenance',connectionTimeoutMillis:5000,options:`-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000 -c row_security=off -c timezone=UTC -c default_transaction_read_only=${readOnly?'on':'off'}`})
 clients.add(c)
 try{
  await c.connect()
  const actual=(await c.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  if(hash(actual)!==hash(config.expected))throw Error('database_identity_mismatch')
  if(!(await c.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper)throw Error('dedicated_administrator_required')
  return {client:c,identity:hash(actual),async close(){await close(c)}}
 }catch(e){await close(c).catch(()=>{});throw e}
}
export function assertManifest<T extends {schemaVersion:number;kind:string;manifestHash:string}>(plan:T,kind:string,version=1){
 if(!plan||plan.schemaVersion!==version||plan.kind!==kind)throw Error('invalid_maintenance_manifest')
 const {manifestHash,...rest}=plan
 if(hash(rest)!==manifestHash)throw Error('maintenance_manifest_fingerprint_mismatch')
}
export function seal<T extends object>(value:T):T&{manifestHash:string}{return {...value,manifestHash:hash(value)}}
