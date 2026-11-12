import type pg from 'pg'
import type {GrantScopeBinding} from '../governance/authorization.js'
import {permissionsForMirrorRoles} from '../governance/role-permissions.js'
import {sourcePoolContext} from './pool-context.js'
type Db=Pick<pg.Pool,'query'>
interface CurrentState {installation_id:string;state:{status:string;config_version:string;provider_enabled:boolean;owner_user_id:string|null;owner_scope_kind:string;owner_scope_id:string;owner_exists:boolean;scope_state:string;parent_state:string|null;authorization_epoch:string;member_user_id:string|null;membership_id:string|null;membership_state:string|null;membership_revision:string|null;roles:string[]|null;member_exists:boolean}}
export async function loadCurrentGrantStates(db:Db,bindings:readonly GrantScopeBinding[]):Promise<CurrentState[]|undefined>{
 if(sourcePoolContext(db).namespace!=='memory'||!bindings.length)return undefined
 const ids=[...new Set(bindings.map(b=>b.installation_id))],members=[...new Set(bindings.flatMap(b=>b.membership_id?[b.membership_id]:[]))]
 if(ids.length>16||members.length>16)throw Error('grant_scope_limit')
 return (await db.query<CurrentState>('SELECT * FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[ids,members])).rows
}
export function currentBindingAllowed(binding:GrantScopeBinding,rows:CurrentState[],facts:{primaryInstallationId?:string;configVersion?:string;userId?:number},options:{allowedSharedStates?:readonly string[];allowedPrimarySharedStates?:readonly string[]}={}):boolean{
 const state=rows.find(r=>r.installation_id===binding.installation_id&&(binding.owner_scope_kind==='personal'||r.state.membership_id===binding.membership_id))?.state
 if(!state||state.status!=='active'||!state.provider_enabled||!state.owner_exists||state.owner_scope_kind!==binding.owner_scope_kind||state.owner_scope_id!==binding.owner_scope_id||state.authorization_epoch!==binding.authorization_epoch)return false
 if(binding.installation_id===facts.primaryInstallationId&&facts.configVersion!==undefined&&state.config_version!==facts.configVersion)return false
 if(binding.owner_scope_kind==='personal')return binding.membership_id===null&&(facts.userId===undefined||state.owner_user_id===String(facts.userId))
 const allowed=binding.installation_id===facts.primaryInstallationId?options.allowedPrimarySharedStates??options.allowedSharedStates??['active']:options.allowedSharedStates??['active']
 if(!allowed.includes(state.scope_state)||(binding.owner_scope_kind==='team'&&(!state.parent_state||!allowed.includes(state.parent_state))))return false
 return (facts.userId===undefined||state.member_user_id===String(facts.userId))&&state.member_exists&&state.membership_state==='active'&&state.membership_revision===binding.membership_revision&&binding.permissions.every(p=>permissionsForMirrorRoles(state.roles??[]).includes(p))
}
export async function lookupCurrentInstallation(db:Db,installationId:string):Promise<{current:boolean;configVersion:string;status:string;ownerUserId:string|null}|undefined>{
 if(sourcePoolContext(db).namespace!=='memory')return undefined
 const rows=(await db.query<CurrentState>('SELECT * FROM shared.memory_current_grant_states($1::uuid[],$2::uuid[])',[[installationId],[]])).rows
 const state=rows[0]?.state
 return currentPersonalInstallation(state)
}

/** Interpret the controlled Relay state for a personal capability. */
export function currentPersonalInstallation(state:CurrentState['state']|null|undefined){
 return {current:!!state&&state.owner_scope_kind==='personal'&&state.owner_exists&&state.provider_enabled&&state.status==='active',configVersion:state?.config_version??'0',status:state?.status??'revoked',ownerUserId:state?.owner_user_id??null}
}

/** Used only with SQL expressions defined by the owning query. */
export function personalLifecycleAuthorityStampSql(state:string):string{
 return `encode(sha256(convert_to(jsonb_build_array(${state}->>'authorization_epoch',${state}->>'config_version',
  ${state}->>'owner_user_id',${state}->>'owner_scope_id',${state}->>'provider_control_revision',
  ${state}->>'installation_control_revision')::text,'UTF8')),'hex')`
}
// A missing capture trigger can lose a disable/re-enable transition even
// when the current native rows look active again. A zero revision is valid
// before the first change only while this existing Relay contract is present.
const lifecycleControlCapture = [
  ['extension_providers','providers'], ['extension_installations','installations'],
].flatMap(([table,control])=>[['insert',4],['update',16],['delete',8]].map(([operation,type])=>
  `(to_regclass('public.${table}'),'memory_control_${control}_${operation}',
    to_regprocedure('shared.capture_memory_control_${control}()'),${type})`,
)).join(',')
export const personalLifecycleAuthorityStateSql=(state:string)=>
 `${state} @> '{"owner_scope_kind":"personal","status":"active","owner_exists":true,"provider_enabled":true,"curation_input_allowed":true}'::jsonb
 AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t
  WHERE t.owner_scope_kind='personal' AND t.owner_scope_id=(${state}->>'owner_scope_id')::uuid
   AND t.authorization_epoch>=(${state}->>'authorization_epoch')::bigint)
 AND EXISTS(SELECT 1 FROM shared.memory_source_contract c WHERE c.singleton AND to_jsonb(c)->>'control_capture_version'='1')
 AND NOT EXISTS(SELECT 1 FROM (VALUES ${lifecycleControlCapture}) required(rel,trigger_name,fn,type)
  WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=required.rel AND t.tgname=required.trigger_name
   AND t.tgfoid=required.fn AND t.tgtype=required.type AND t.tgenabled IN('O','A')))`

/** Nonblocking public authority barrier. Caller must be inside BEGIN and call
 * before local Memory/resource locks. No raw table capability is exposed. */
export async function lockCurrentRelayAuthority(db:Db,installationIds:readonly string[],memberIds:readonly string[]=[]):Promise<boolean>{
 if(sourcePoolContext(db).namespace!=='memory')return true
 const ids=[...new Set(installationIds)].sort(),members=[...new Set(memberIds)].sort()
 if(!ids.length||ids.length>16||members.length>16)throw Error('grant_scope_limit')
 return (await db.query<{locked:boolean}>('SELECT shared.lock_memory_grant_authority($1::uuid[],$2::uuid[]) AS locked',[ids,members])).rows[0]?.locked===true
}

/** The handoff is specific to both Relay authority and local Context settings. */
export function personalLifecycleDeliveryStampSql(installation:string,authorityStamp:string):string{
 return `encode(sha256(convert_to(jsonb_build_array(${authorityStamp},
  (SELECT jsonb_build_array(p.revision,p.consume_mode) FROM memory_curation_policies p WHERE p.installation_id=${installation}),
  (SELECT jsonb_agg(jsonb_build_array(s.setting_id,s.revision,s.mode) ORDER BY s.setting_id)
   FROM memory_context_settings s WHERE s.installation_id=${installation}))::text,'UTF8')),'hex')`
}
