import type pg from 'pg'
import {canonicalJsonString,canonicalPayloadHash,type SourceScope,type SourceRoot,type SourceVersion} from '@pocketctl/session-source'
import {sourcePoolContext} from './pool-context.js'
import {createObservedSourceReader} from './observed-reader.js'
interface Binding {version:1;original_session_id:string;current_session_id:string}
export function snapshotLogicalSession(event:Record<string,unknown>,route:string):{sessionId:string;envelope:Record<string,unknown>;alias:boolean}{
 if(!Object.hasOwn(event,'source_binding'))return {sessionId:route,envelope:event,alias:false}
 const b=event.source_binding as Binding
 if(!b||typeof b!=='object'||Array.isArray(b)||canonicalJsonString(Object.keys(b).sort())!==canonicalJsonString(['current_session_id','original_session_id','version'])
  ||b.version!==1||typeof b.original_session_id!=='string'||!b.original_session_id||b.original_session_id.length>128
  ||b.current_session_id!==route||b.original_session_id===route)throw Error('snapshot_source_binding_invalid')
 const envelope={...event};delete envelope.source_binding
 return {sessionId:b.original_session_id,envelope,alias:true}
}
interface Observation {scope:SourceScope;root:SourceRoot;version:SourceVersion}
interface Row {relay_event_id:string;session_id:string;event_type:string;content_hash:string|null;occurred_at?:string|Date;legacy_wire_timestamp?:string;legacy_millis?:boolean}
async function scopeFor(pool:pg.Pool,installationId:string):Promise<SourceScope>{
 if(sourcePoolContext(pool).namespace!=='memory')throw Error('alias_snapshot_requires_shared_authority')
 const states=(await pool.query('SELECT state FROM shared.memory_current_grant_states($1::uuid[],ARRAY[]::uuid[])',[[installationId]])).rows
 const s=states[0]?.state,mode=(await pool.query('SELECT mode,generation::text FROM shared.memory_source_modes WHERE installation_id=$1',[installationId])).rows[0]
 if(states.length!==1||!s||s.status!=='active'||s.provider_enabled!==true||s.owner_exists!==true||s.owner_scope_kind!=='personal'
  ||!['shared-shadow','shared-active'].includes(mode?.mode))throw Error('snapshot_source_authority_unavailable')
 return {installationId,principalUserId:s.owner_user_id,ownerScopeKind:'personal',ownerScopeId:s.owner_scope_id,
  authorizationRevision:s.authorization_epoch,configVersion:s.config_version,modeGeneration:mode.generation}
}
/** Body preparation and all optional archive IO finish before BEGIN. The
 * returned guard contains only exact current vectors for physical COMMIT. */
export async function prepareSnapshotAliasRows(pool:pg.Pool,installationId:string,rows:readonly Row[],routes?:ReadonlySet<string>){
 if(rows.length>100000)throw Error('snapshot_source_roster_limit')
 const scope=await scopeFor(pool,installationId),reader=createObservedSourceReader(pool,sourcePoolContext(pool).archive),observations:Observation[]=[],nativeTimes:{canonical_key:string;occurred_at:string}[]=[]
 const sessions=[...new Set(rows.map(r=>r.session_id))].sort()
 if(sessions.length>4096)throw Error('snapshot_source_roster_limit')
 for(const sid of sessions){
  const root:SourceRoot={kind:'relay_event',key:scope.principalUserId+':'+sid},selected=rows.filter(r=>r.session_id===sid)
  let expected:SourceVersion|undefined
  for(let n=0;n<selected.length;n+=256){
   const part=selected.slice(n,n+256),page=await reader.getHeads(scope,root,part.map(r=>r.relay_event_id))
   if(expected&&canonicalJsonString(expected)!==canonicalJsonString(page.version))throw Error('snapshot_source_authority_changed')
   expected=page.version
   for(let i=0;i<part.length;i++){
    const h=page.heads[i],r=part[i]
    // Snapshot v1 transports Date.toISOString() milliseconds. This is one
    // exact, known serialization transform, never an interval tolerance.
    const wire=r.legacy_wire_timestamp
    if(!h.occurredAt||typeof wire!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(wire)
      ||r.legacy_millis===false||wire!==new Date(h.occurredAt).toISOString())throw Error('snapshot_source_timestamp_mismatch')
    nativeTimes.push({canonical_key:r.relay_event_id,occurred_at:h.occurredAt})
    if(h.sessionKey!==r.session_id||h.eventType!==r.event_type||h.contentHash!==r.content_hash
      ||routes&&(!h.currentSessionKey||!routes.has(h.currentSessionKey)))throw Error('snapshot_source_binding_mismatch')
   }
  }
  if(expected)observations.push({scope,root,version:expected})
 }
 return {nativeTimes,async assertCurrent(client:Pick<pg.PoolClient,'query'>,forCommit=false){
  const current=createObservedSourceReader(client as pg.Pool)
  for(const o of observations){
   if((await current.checkCurrent(o.scope,o.root,o.version)).state!=='current')throw Error('snapshot_source_authority_changed')
   if(forCommit&&(await client.query('SELECT shared.lock_memory_personal_source_commit($1::jsonb,$2,$3,$4::jsonb,FALSE) AS locked',[JSON.stringify(o.scope),o.root.kind,o.root.key,JSON.stringify(o.version)])).rows[0]?.locked!==true)throw Error('snapshot_source_authority_changed')
  }
 }}
}
export const snapshotAliasRow=(event:Record<string,unknown>,sessionId:string):Row=>({relay_event_id:String(event.event_id),session_id:sessionId,event_type:String(event.event_type),content_hash:canonicalPayloadHash(event.payload??{}).toString('hex'),occurred_at:String(event.created_at),legacy_wire_timestamp:event.created_at instanceof Date?event.created_at.toISOString():String(event.created_at),legacy_millis:true})
