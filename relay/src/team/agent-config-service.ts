import { createHash } from 'node:crypto'
import type pg from 'pg'
import { requireTeamAccess } from './access.js'
import { TeamRepositoryError } from './repository.js'
import { TEAM_CONFIG_CAPABILITY, type TeamRuntimeConfig, type SessionAgentConfig, type TeamAgentConfigCapabilities } from './types.js'

type DB = Pick<pg.Pool, 'query'>
function supportsConfig(row:any):boolean{return Array.isArray(row.collaboration_capabilities)&&row.collaboration_capabilities.includes(TEAM_CONFIG_CAPABILITY)&&Array.isArray(row.agents)&&row.agents.some((a:any)=>a?.type===row.provider&&a.team_config?.schema_version===2)}
export function runtimeConfigHash(config: TeamRuntimeConfig): string {
  return createHash('sha256').update(JSON.stringify({model:config.model,reasoning_effort:config.reasoning_effort,permission_profile:config.permission_profile})).digest('hex')
}
export function bindingConfigView(row: any): SessionAgentConfig {
  return {mode:row.config_mode,default_snapshot:row.default_snapshot,override:row.config_override,
    requested_config:row.requested_config,applied_config:row.applied_config,config_revision:Number(row.config_revision),
    applied_revision:row.applied_revision == null ? null : Number(row.applied_revision),capability_revision:row.config_capability_revision,status:row.config_status}
}
export function validateRuntimeConfig(value: unknown, capability: TeamAgentConfigCapabilities): TeamRuntimeConfig {
  const c = value as TeamRuntimeConfig | null
  const model = capability.models.find(m => m.id === c?.model)
  if (!c || !model || !capability.permission_profiles.includes(c.permission_profile)
    || (c.reasoning_effort !== null && !model.reasoning_efforts.includes(c.reasoning_effort))) {
    throw new TeamRepositoryError('capability_not_supported','unsupported model, reasoning effort, or permission profile')
  }
  return {model:c.model,reasoning_effort:c.reasoning_effort??model.default_reasoning_effort??null,permission_profile:c.permission_profile}
}
// Whitelist the inventory shape: never return account metadata or native flags.
export function configCapabilities(agents: any, provider: string, capabilities: unknown, policy: any): TeamAgentConfigCapabilities {
  const raw = Array.isArray(agents) ? agents.find(a => a?.type === provider)?.team_config : null
  if (!Array.isArray(capabilities) || !capabilities.includes(TEAM_CONFIG_CAPABILITY)
    || raw?.schema_version !== 2 || typeof raw.revision !== 'string'
    || !Array.isArray(raw.models) || !raw.models.length || !Array.isArray(raw.permission_profiles)
    || !['hot','recreate'].includes(raw.runtime_switch)) throw new TeamRepositoryError('capability_not_supported','daemon does not support Team configuration')
  if (!raw.models.every((m: any) => typeof m.id === 'string' && m.id.length > 0 && Array.isArray(m.reasoning_efforts) && m.reasoning_efforts.every((e: any) => typeof e === 'string'))
    || !raw.permission_profiles.every((p: any) => typeof p === 'string')) throw new TeamRepositoryError('capability_not_supported','invalid daemon configuration inventory')
  const result: TeamAgentConfigCapabilities = {schema_version:2,revision:raw.revision,
    models:raw.models.map((m: any) => ({id:m.id,reasoning_efforts:[...m.reasoning_efforts],...(typeof m.default_reasoning_effort==='string'&&m.reasoning_efforts.includes(m.default_reasoning_effort)?{default_reasoning_effort:m.default_reasoning_effort}:{})})),permission_profiles:[...raw.permission_profiles],
    default_config:raw.default_config,default_source:typeof raw.default_source === 'string' ? raw.default_source : 'daemon',
    overridable_fields:(policy?.overridable_fields ?? []).filter((f: unknown) => f === 'model' || f === 'reasoning_effort'),read_only:raw.read_only === true,runtime_switch:raw.runtime_switch}
  result.default_config = validateRuntimeConfig(raw.default_config,result)
  return result
}

export class TeamAgentConfigService {
  constructor(private readonly pool: pg.Pool) {}
  private async binding(db: DB, sessionId: string, offerId: string, actor: number, lock = false) {
    await requireTeamAccess(db,actor,lock)
    const row = (await db.query(`SELECT b.*, o.provider,o.config_policy,o.config_policy_revision,o.state AS offer_state,o.owner_user_id AS offer_owner,
      d.agents,d.collaboration_capabilities,d.status AS daemon_status,m.role,s.state AS session_state
      FROM collaboration_session_agent_bindings b
      JOIN collaboration_sessions s ON s.team_session_id=b.team_session_id
      JOIN collaboration_teams t ON t.team_id=s.team_id AND t.state='active'
      JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=$3 AND m.state='active'
      JOIN collaboration_session_participants p ON p.team_session_id=s.team_session_id AND p.user_id=$3 AND p.state='active'
      JOIN team_agent_offers o ON o.offer_id=b.offer_id
      JOIN users owner ON owner.id=o.owner_user_id AND owner.team_enabled=true
      JOIN collaboration_team_memberships om ON om.team_id=s.team_id AND om.user_id=o.owner_user_id AND om.state='active'
      JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
      WHERE b.team_session_id=$1 AND b.offer_id=$2 AND b.state='active'
      ${lock ? 'FOR UPDATE OF s,b FOR SHARE OF m,p,t,o,om,owner,d' : ''}`, [sessionId,offerId,actor])).rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found','Agent binding not found')
    if (lock && row.role === 'viewer') throw new TeamRepositoryError('team_access_denied','read-only team member')
    return row
  }
  async offerCapabilities(teamId: string, offerId: string, actor: number) {
    await requireTeamAccess(this.pool,actor)
    const row = (await this.pool.query(`SELECT o.*,d.agents,d.collaboration_capabilities,d.status FROM team_agent_offers o
      JOIN collaboration_teams t ON t.team_id=o.team_id AND t.state='active'
      JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=$3 AND m.state='active'
      JOIN users owner ON owner.id=o.owner_user_id AND owner.team_enabled=true
      JOIN collaboration_team_memberships om ON om.team_id=o.team_id AND om.user_id=o.owner_user_id AND om.state='active'
      JOIN daemons d ON d.daemon_id=o.daemon_id AND d.user_id=o.owner_user_id
      WHERE o.team_id=$1 AND o.offer_id=$2 AND o.state='active'`,[teamId,offerId,actor])).rows[0]
    if (!row) throw new TeamRepositoryError('team_not_found','Agent offer not found')
    if (row.status !== 'online') throw new TeamRepositoryError('agent_unavailable','Agent is offline')
    return {...configCapabilities(row.agents,row.provider,row.collaboration_capabilities,row.config_policy),policy_revision:Number(row.config_policy_revision)}
  }
  async capabilities(sessionId: string, offerId: string, actor: number) {
    const row = await this.binding(this.pool,sessionId,offerId,actor)
    if (row.daemon_status !== 'online' || row.offer_state !== 'active') throw new TeamRepositoryError('agent_unavailable','Agent is offline')
    return {...configCapabilities(row.agents,row.provider,row.collaboration_capabilities,row.config_policy),policy_revision:Number(row.config_policy_revision)}
  }
  async updatePolicy(input:{teamId:string;offerId:string;actorUserId:number;requestId:string;expectedRevision:number;fields:string[]}) {
    if(!input.fields.every(f=>['model','reasoning_effort'].includes(f))||new Set(input.fields).size!==input.fields.length)throw new TeamRepositoryError('invalid_state','only model and effort can be delegated')
    const fields=[...input.fields].sort(),operation=`team.config-policy:${input.offerId}`,hash=createHash('sha256').update(JSON.stringify({fields,revision:input.expectedRevision})).digest('hex')
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN');await requireTeamAccess(client,input.actorUserId,true)
      const row=(await client.query(`SELECT o.* FROM team_agent_offers o
        JOIN collaboration_teams t ON t.team_id=o.team_id AND t.state='active'
        JOIN collaboration_team_memberships m ON m.team_id=o.team_id AND m.user_id=$3 AND m.state='active' AND m.role<>'viewer'
        WHERE o.team_id=$1 AND o.offer_id=$2 AND o.owner_user_id=$3 AND o.state='active' FOR UPDATE OF o FOR SHARE OF t,m`,[input.teamId,input.offerId,input.actorUserId])).rows[0]
      if(!row)throw new TeamRepositoryError('team_access_denied','only the active Agent owner may delegate configuration')
      const prior=(await client.query(`SELECT request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3`,[input.actorUserId,operation,input.requestId])).rows[0]
      if(prior){if(prior.request_hash!==hash)throw new TeamRepositoryError('idempotency_conflict','policy request reused');await client.query('COMMIT');return prior.response}
      if(Number(row.config_policy_revision)!==input.expectedRevision)throw new TeamRepositoryError('revision_conflict','sharing policy changed',Number(row.config_policy_revision))
      const result={policy_revision:input.expectedRevision+1,overridable_fields:fields}
      // A policy revision is independent of native Offer identity. Revocation is
      // rechecked at Call admission/dispatch, without invalidating native history.
      await client.query(`UPDATE team_agent_offers SET config_policy=$2::jsonb,config_policy_revision=config_policy_revision+1 WHERE offer_id=$1`,[input.offerId,JSON.stringify({overridable_fields:fields})])
      await client.query(`INSERT INTO collaboration_team_idempotency(user_id,operation,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)`,[input.actorUserId,operation,input.requestId,hash,JSON.stringify(result)])
      await client.query('COMMIT');return result
    }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  async initialize(db: DB, sessionId: string, offerId: string, actor: number, config?: {mode:'default'|'custom';override?:Partial<TeamRuntimeConfig>;capability_revision?:string}) {
    const row = await this.binding(db,sessionId,offerId,actor,true)
    if(process.env.TEAM_AGENT_CONFIG_V2!=='on'){if(config?.mode==='custom')throw new TeamRepositoryError('team_feature_disabled','Team Agent configuration is disabled');return}
    if (!supportsConfig(row)) {if(config?.mode==='custom'||Object.keys(config?.override??{}).length)throw new TeamRepositoryError('capability_not_supported','provider does not support isolated Team configuration');return}
    const cap = configCapabilities(row.agents,row.provider,row.collaboration_capabilities,row.config_policy)
    if (config?.capability_revision && config.capability_revision !== cap.revision) throw new TeamRepositoryError('revision_conflict','capability revision changed')
    const override = config?.mode === 'custom' ? config.override ?? {} : {}
    this.authorizeOverride(row,actor,override)
    const requested = validateRuntimeConfig({...cap.default_config,...override},cap)
    await db.query(`UPDATE collaboration_session_agent_bindings SET default_snapshot=$2::jsonb,requested_config=$3::jsonb,
      config_mode=$4,config_override=$5::jsonb,config_capability_revision=$6,config_status='pending',config_updated_by_user_id=$7 WHERE binding_id=$1`,
      [row.binding_id,JSON.stringify(cap.default_config),JSON.stringify(requested),config?.mode ?? 'default',JSON.stringify(override),cap.revision,actor])
  }
  async freeze(db:DB,sessionId:string,offerId:string,actor:number,mode?:import('./types.js').TeamRunMode) {
    let row=await this.binding(db,sessionId,offerId,actor,true)
    if(process.env.TEAM_AGENT_CONFIG_V2!=='on'){if(row.requested_config)throw new TeamRepositoryError('team_feature_disabled','Team configuration is disabled');return null}
    if (!row.requested_config && !supportsConfig(row)) return null // explicit legacy v1 path
    if (!row.requested_config) {
      await this.initialize(db,sessionId,offerId,actor)
      row=await this.binding(db,sessionId,offerId,actor,true)
    }
    if(row.daemon_status!=='online'||row.offer_state!=='active')throw new TeamRepositoryError('agent_unavailable','Agent is not callable')
    const cap=configCapabilities(row.agents,row.provider,row.collaboration_capabilities,row.config_policy)
    if(cap.revision!==row.config_capability_revision)throw new TeamRepositoryError('revision_conflict','Agent capabilities changed; confirm configuration',Number(row.config_revision))
    if(row.config_updated_by_user_id != null && Number(row.config_updated_by_user_id)!==Number(row.owner_user_id)) this.authorizeOverride(row,Number(row.config_updated_by_user_id),row.config_override)
    let config=validateRuntimeConfig(row.requested_config,cap)
    if(mode && mode!=='execute'){
      const profile=cap.permission_profiles.find(p=>p==='read_only'||p==='read-only')
      if(!cap.read_only||!profile)throw new TeamRepositoryError('capability_not_supported','Agent cannot enforce read-only discussion')
      config={...config,permission_profile:profile}
    }
    return {requested_config:config,config_revision:Number(row.config_revision),config_hash:runtimeConfigHash(config),capability_revision:cap.revision}
  }
  private authorizeOverride(row: any, actor: number, override: Partial<TeamRuntimeConfig>) {
    if (Object.keys(override).some(k => !['model','reasoning_effort','permission_profile'].includes(k))) throw new TeamRepositoryError('capability_not_supported','unknown configuration field')
    if (Number(row.owner_user_id) === actor) return
    const allowed = row.config_policy?.overridable_fields ?? []
    if (Object.keys(override).some(key => key === 'permission_profile' || !allowed.includes(key))) throw new TeamRepositoryError('offer_owner_required','Agent owner authorization required')
  }
  async update(input: {sessionId:string;offerId:string;actorUserId:number;requestId:string;expectedRevision:number;mode:'default'|'custom';override:Partial<TeamRuntimeConfig>;capabilityRevision:string}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`team:config:${input.actorUserId}:${input.sessionId}:${input.offerId}:${input.requestId}`])
      const row = await this.binding(client,input.sessionId,input.offerId,input.actorUserId,true)
      const operation = `team.config:${row.binding_id}`
      const payloadHash = createHash('sha256').update(JSON.stringify({mode:input.mode,override:Object.fromEntries(Object.entries(input.override).sort()),expected:input.expectedRevision,capability:input.capabilityRevision})).digest('hex')
      const prior = (await client.query(`SELECT * FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3`,[input.actorUserId,operation,input.requestId])).rows[0]
      if (prior) {
        if (prior.request_hash !== payloadHash) throw new TeamRepositoryError('idempotency_conflict','request_id reused with different configuration')
        await client.query('COMMIT'); return prior.response as SessionAgentConfig
      }
      if (!['active','paused'].includes(row.session_state)) throw new TeamRepositoryError('invalid_state','session no longer accepts configuration changes')
      if (Number(row.config_revision) !== input.expectedRevision) throw new TeamRepositoryError('revision_conflict','configuration revision changed',Number(row.config_revision))
      if (row.daemon_status !== 'online' || row.offer_state !== 'active') throw new TeamRepositoryError('agent_unavailable','Agent is offline')
      const cap = configCapabilities(row.agents,row.provider,row.collaboration_capabilities,row.config_policy)
      if (cap.revision !== input.capabilityRevision) throw new TeamRepositoryError('revision_conflict','capability revision changed',Number(row.config_revision))
      // Restoring defaults can itself change a permission boundary. Nonowners
      // may restore only the fields the owner explicitly delegated.
      const snapshot = row.default_snapshot ?? cap.default_config
      const override = input.mode === 'custom' ? input.override : {}
      this.authorizeOverride(row,input.actorUserId,override)
      const base=Number(row.owner_user_id)!==input.actorUserId && input.mode==='custom' ? {...snapshot,permission_profile:row.requested_config?.permission_profile??snapshot.permission_profile} : snapshot
      const requested = validateRuntimeConfig({...base,...override},cap)
      if (Number(row.owner_user_id) !== input.actorUserId && row.requested_config) {
        const changed = Object.fromEntries(Object.entries(requested).filter(([k,v]) => v !== row.requested_config[k]))
        this.authorizeOverride(row,input.actorUserId,changed)
      }
      const updated = (await client.query(`UPDATE collaboration_session_agent_bindings SET config_mode=$2,default_snapshot=COALESCE(default_snapshot,$3::jsonb),
        config_override=$4::jsonb,requested_config=$5::jsonb,config_revision=config_revision+1,config_capability_revision=$6,config_status='pending',config_updated_by_user_id=$7,updated_at=NOW()
        WHERE binding_id=$1 RETURNING *`,[row.binding_id,input.mode,JSON.stringify(snapshot),JSON.stringify(override),JSON.stringify(requested),cap.revision,input.actorUserId])).rows[0]
      const result = bindingConfigView(updated)
      await client.query(`INSERT INTO collaboration_team_idempotency(user_id,operation,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)`,[input.actorUserId,operation,input.requestId,payloadHash,JSON.stringify(result)])
      await client.query('COMMIT'); return result
    } catch(e) {await client.query('ROLLBACK');throw e} finally {client.release()}
  }
}
