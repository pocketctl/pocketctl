import pg from 'pg'
import type {EventEmitter} from 'node:events'
import type {Socket} from 'node:net'
import {hash,type MaintenanceDatabase} from './source-maintenance-common.js'
/** Ephemeral CancelRequest material is never returned or serialized. */
type Cancellable=pg.Client&{processID:number;host:string;port:number;_getActiveQuery():unknown;cancel(client:pg.Client,query:unknown):void;connection:EventEmitter&{stream:Socket}}
export interface PagedBackend {pid:number;started:string}
export async function capturePagedBackend(client:pg.Client):Promise<PagedBackend>{
 const row=(await client.query("SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0]
 if(!row||row.pid!==(client as Cancellable).processID)throw Error('paged_backend_identity_unproved')
 return row
}
/** The shipped pg CancelRequest uses only the original backend PID+secret.
 * Pin its destination to the original socket, rather than resolving a mutable
 * hostname again. A Unix socket retains its exact original path and port. */
export async function cancelPagedQuery(client:pg.Client):Promise<void>{
 const target=client as Cancellable,active=target._getActiveQuery();if(!active)return
 const socket=target.connection.stream,host=socket.remoteAddress??target.host,port=socket.remotePort??target.port
 if(!host||!port)throw Error('paged_cancel_endpoint_unproved')
 const cancellation=new pg.Client({host,port,connectionTimeoutMillis:500}) as Cancellable
 if(typeof cancellation.cancel!=='function')throw Error('paged_native_cancel_unavailable')
 await new Promise<void>((resolve,reject)=>{
  let finished=false
  const done=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);cancellation.connection.stream.destroy();if(error)reject(error);else resolve()}
  const timer=setTimeout(()=>done(Error('paged_native_cancel_timeout')),500)
  cancellation.connection.once('error',done);cancellation.connection.once('end',()=>done())
  try{cancellation.cancel(client,active)}catch(error){done(error as Error)}
 })
}
/** Separate bounded read-only cleanup confirmation, never business-window
 * extension. CancelRequest delivery alone is not completion acknowledgement. */
export async function confirmPagedBackendGone(config:MaintenanceDatabase,backend:PagedBackend):Promise<void>{
 const observer=new pg.Client({connectionString:config.url,application_name:'pocketctl-paged-cancel-observer',connectionTimeoutMillis:500,options:'-c search_path=pg_catalog -c statement_timeout=500 -c lock_timeout=500 -c default_transaction_read_only=on'}),until=Date.now()+1000
 const timer=setTimeout(()=>{void observer.end().catch(()=>{})},1000)
 try{
  await observer.connect()
  const identity=(await observer.query(`SELECT current_database() AS database,current_user AS role,d.oid::text AS "databaseOid",inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort" FROM pg_database d WHERE datname=current_database()`)).rows[0]
  if(hash(identity)!==hash(config.expected))throw Error('paged_cancel_observer_identity_drift')
  for(;;){const row=(await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz',[backend.pid,backend.started])).rowCount
   if(!row)return;if(Date.now()+25>=until)throw Error('paged_cancel_completion_unconfirmed');await new Promise(resolve=>setTimeout(resolve,25))
  }
 }finally{clearTimeout(timer);await observer.end().catch(()=>{})}
}
