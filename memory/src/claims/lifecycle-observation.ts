import {createHash} from 'node:crypto'
import type pg from 'pg'
import type {LifecycleMode} from './lifecycle-policy.js'
import {lockCurrentRelayAuthority} from '../sources/current-grant.js'
import {sourcePoolContext} from '../sources/pool-context.js'

/** Scope authority and local readiness are independent in shared mode. */
export function lifecycleOwnerJoin(db:Pick<pg.Pool,'query'>,installation:string){
 const shared=sourcePoolContext(db).namespace==='memory'
 return {
  shared,
  join:shared?`JOIN LATERAL (
   SELECT encode(sha256(convert_to(jsonb_build_array(current.state->>'authorization_epoch',current.state->>'config_version',
    current.state->>'owner_user_id',current.state->>'owner_scope_id')::text,'UTF8')),'hex') AS authority_stamp
   FROM shared.memory_current_grant_states(ARRAY[${installation}::uuid],ARRAY[]::uuid[]) current
   WHERE current.state @> '{"owner_scope_kind":"personal","status":"active","owner_exists":true,"provider_enabled":true,"curation_input_allowed":true}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t
     WHERE t.owner_scope_kind='personal' AND t.owner_scope_id=(current.state->>'owner_scope_id')::uuid
      AND t.authorization_epoch>=(current.state->>'authorization_epoch')::bigint)
  ) owner ON TRUE`:`JOIN memory_owner_scopes owner ON owner.installation_id=${installation}
   AND owner.owner_scope_kind='personal' AND owner.state='active'`,
  ready:shared?"i.local_status='ready'":"i.local_status='ready' AND i.relay_status='active'",
  stamp:shared?'owner.authority_stamp':'NULL::text',
  localOwnerLock:shared?'':',owner',
 }
}

export function lifecycleObservationAvailableSql(authorityStamp:string,l='l'):string{
 return `EXISTS(SELECT 1 FROM memory_lifecycle_observation_windows observation
  WHERE observation.installation_id=${l}.installation_id AND observation.state='observed'
   AND (${authorityStamp} IS NULL OR starts_with(observation.settings_hash,${authorityStamp}||':'))
   AND observation.capability_since_at IS NOT NULL AND observation.capability_since_at<=observation.started_at
   AND observation.started_at<=clock_timestamp()-interval '90 days'
   AND observation.last_native_delivery_at>=clock_timestamp()-interval '24 hours'
   AND observation.last_heartbeat_at>=clock_timestamp()-(observation.max_gap_ms*interval '1 millisecond'))`
}

export function createLifecycleObservationService(input:{pool:pg.Pool;mode:LifecycleMode}){
 return {
  async listActivePersonalOwners(limit=100,afterInstallationId?:string):Promise<string[]>{
   if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('invalid_observation_batch')
   const authority=lifecycleOwnerJoin(input.pool,'i.installation_id')
   return (await input.pool.query(`SELECT i.installation_id FROM memory_installations i ${authority.join}
    WHERE ${authority.ready} AND($2::uuid IS NULL OR i.installation_id>$2) ORDER BY i.installation_id LIMIT $1`,[limit,afterInstallationId??null])).rows.map(r=>r.installation_id)
  },
  async recordObservationHeartbeat(options:{installationId:string;maxGapMs?:number}):Promise<'unknown'|'observed'>{
   const maxGap=options.maxGapMs??300000
   if(!Number.isInteger(maxGap)||maxGap<60000||maxGap>300000)throw new Error('invalid_observation_gap')
   const c=await input.pool.connect()
   try{
    await c.query('BEGIN')
    await c.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'")
    if(!await lockCurrentRelayAuthority(c,[options.installationId])){await c.query('ROLLBACK');return 'unknown'}
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0)),pg_advisory_xact_lock(hashtextextended('lifecycle-observation:'||$1,0))",[options.installationId])
    const authority=lifecycleOwnerJoin(c,'i.installation_id')
    const owner=(await c.query<{authority_stamp:string|null}>(`SELECT ${authority.stamp} AS authority_stamp FROM memory_installations i
     JOIN memory_curation_policies p USING(installation_id) ${authority.join}
     WHERE i.installation_id=$1 AND ${authority.ready} AND p.consume_mode='enabled'
     FOR SHARE OF i,p${authority.localOwnerLock}`,[options.installationId])).rows[0]
    const settings=(await c.query(`SELECT scope_kind,scope_key,agent,mode,revision::text FROM memory_context_settings
     WHERE installation_id=$1 ORDER BY scope_kind,scope_key,agent NULLS FIRST FOR SHARE`,[options.installationId])).rows
    const settingsEnabled=input.mode==='enabled'&&!!owner&&settings.some(s=>s.scope_kind==='installation'&&s.scope_key==='global'&&s.agent===null&&s.mode==='enabled')&&settings.every(s=>s.mode==='enabled')
    const prefix=owner?.authority_stamp ? owner.authority_stamp+':' : ''
    const fingerprint=prefix+createHash('sha256').update(JSON.stringify(settings)).digest('hex')
    const prior=(await c.query('SELECT * FROM memory_lifecycle_observation_windows WHERE installation_id=$1 FOR UPDATE',[options.installationId])).rows[0]
    // A different Relay authority cannot inherit the old continuous interval.
    if(prefix&&prior&&!prior.settings_hash.startsWith(prefix)){
     await c.query('SELECT memory_invalidate_lifecycle_observation($1::uuid)',[options.installationId])
     await c.query('UPDATE memory_lifecycle_observation_windows SET settings_hash=$2 WHERE installation_id=$1',[options.installationId,fingerprint])
     await c.query('COMMIT')
     return 'unknown'
    }
    const enabled=settingsEnabled&&!!prior?.capability_since_at&&(!prior.last_limitation_at||prior.capability_since_at>=prior.last_limitation_at)
    if(!enabled&&!prior&&!(prefix&&settingsEnabled)){await c.query('COMMIT');return 'unknown'}
    const now=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    if(prior?.capability_since_at&&(!prior.last_native_delivery_at||now.getTime()-prior.last_native_delivery_at.getTime()>86400000)||prior?.last_heartbeat_at&&now.getTime()-prior.last_heartbeat_at.getTime()>Math.min(maxGap,prior.max_gap_ms)){
     await c.query('SELECT memory_invalidate_lifecycle_observation($1::uuid)',[options.installationId]);await c.query('COMMIT');return 'unknown'
    }
    const continuous=enabled&&prior?.started_at&&prior.last_heartbeat_at&&prior.settings_hash===fingerprint&&now.getTime()-prior.last_heartbeat_at.getTime()<=Math.min(maxGap,prior.max_gap_ms)
    const start=enabled?(continuous?new Date(Math.max(prior.started_at.getTime(),prior.capability_since_at.getTime())):now):null
    const state=enabled&&start&&now.getTime()-start.getTime()>=90*86400000?'observed':'unknown'
    await c.query(`INSERT INTO memory_lifecycle_observation_windows(installation_id,state,started_at,last_heartbeat_at,max_gap_ms,settings_hash)
     VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id) DO UPDATE SET state=EXCLUDED.state,started_at=EXCLUDED.started_at,
      last_heartbeat_at=EXCLUDED.last_heartbeat_at,max_gap_ms=EXCLUDED.max_gap_ms,settings_hash=EXCLUDED.settings_hash,
      capability_since_at=CASE WHEN $7 THEN memory_lifecycle_observation_windows.capability_since_at ELSE NULL END,
      last_limitation_at=CASE WHEN $7 THEN memory_lifecycle_observation_windows.last_limitation_at ELSE clock_timestamp() END,
      updated_at=clock_timestamp()`,[options.installationId,state,start,enabled?now:null,maxGap,fingerprint,settingsEnabled])
    await c.query(`UPDATE memory_claim_lifecycle SET observation_state=$2,observation_started_at=$3
     WHERE installation_id=$1 AND(observation_state<>$2 OR observation_started_at IS DISTINCT FROM $3::timestamptz)`,[options.installationId,state,start])
    await c.query('COMMIT');return state
   }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e}finally{c.release()}
  },
 }
}

/** Trusted API outcome hook for off/degraded requests that produced no pack.
 * The reason is bounded for callers; no request text is persisted. */
export async function invalidateLifecycleObservation(pool:pg.Pool,installationId:string,_reason:'context_off'|'shadow_only'|'degraded'|'unsupported_adapter'|'unavailable'):Promise<void>{
 await pool.query('SELECT memory_invalidate_lifecycle_observation($1::uuid)',[installationId])
}
