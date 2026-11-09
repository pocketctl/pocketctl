import type pg from 'pg'
import {sourcePoolContext} from './pool-context.js'
import {lockCurrentRelayAuthority} from './current-grant.js'
import {assertRetainedSourceGuards,rememberRetainedSourceRead} from './retained-authority.js'
import {preparedSourceUnavailable} from './prepared-sources.js'
import {requireCurrentScopePermission,requireCurrentInstallationAuthority,assertCurrentGrantClock,TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
export type SourceReadGrant=V2GrantFacts|{installationId:string;configVersion?:string;expiresAt?:number;userId?:number}
type Db=Pick<pg.PoolClient,'query'>
/** Retained metadata/excerpt reads only. Callbacks register exact source UUIDs,
 * retain their existing knowledge permissions, and perform no raw/archive IO. */
export async function retainedSourceRead<T>(pool:pg.Pool,input:{installationId:string;authorityGrant?:SourceReadGrant},read:(client:Db)=>Promise<T>):Promise<T|undefined>{
 if(sourcePoolContext(pool).namespace!=='memory')return read(pool)
 const grant=input.authorityGrant
 if(!grant||(!('scopeBindings' in grant)&&typeof grant.configVersion!=='string'))return undefined
 const client=await pool.connect()
 try{
  await client.query('BEGIN')
  await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  const bindings='scopeBindings' in grant?grant.scopeBindings:[]
  if(!await lockCurrentRelayAuthority(client,bindings.length?bindings.map(b=>b.installation_id):[input.installationId],bindings.flatMap(b=>b.membership_id?[b.membership_id]:[])))throw new TargetBindingError('scope authority busy')
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
  if('scopeBindings' in grant)await requireCurrentScopePermission({client,grant,targetInstallationId:input.installationId,permission:'read'})
  else{if(grant.installationId!==input.installationId)throw new TargetBindingError('installation authority mismatch');await requireCurrentInstallationAuthority(client,grant,{readOnly:true})}
  const value=await read(client)
  await assertRetainedSourceGuards(client)
  await assertCurrentGrantClock(client,grant,[input.installationId])
  rememberRetainedSourceRead(client,value)
  await client.query('COMMIT');return value
 }catch(error){
  await client.query('ROLLBACK').catch(()=>undefined)
  if(error instanceof TargetBindingError||preparedSourceUnavailable(error)||(error as {code?:string}).code==='55P03')return undefined
  throw error
 }finally{client.release()}
}
