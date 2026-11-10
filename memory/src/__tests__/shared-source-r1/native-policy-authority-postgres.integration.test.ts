import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterAll,afterEach,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createReviewPolicyRepository,loadEffectiveReviewPolicySnapshot,DEFAULT_TEAM_REVIEW_POLICY,DEFAULT_ORGANIZATION_REVIEW_POLICY} from '../../governance/review-policy.js'
import {lockGitPolicyScopes} from '../../git-sync/authorization.js'
import {createTransactionBoundPool} from '../../api/transaction-bound-pool.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('policy inheritance follows native owner and parent facts',()=>{
 let f:DirectLaunchFixture,child:string,team:string,oldScope:string,newScope:string,oldParent:string,newParent:string,oldHead:string,newHead:string
 const snapshot=async()=>{const c=await f.runtime.connect();try{await c.query('BEGIN');return await loadEffectiveReviewPolicySnapshot(c,child)}finally{await c.query('ROLLBACK');c.release()}}
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);child=randomUUID();team=randomUUID();oldScope=randomUUID();newScope=randomUUID();oldParent=randomUUID();newParent=randomUUID()
  await (await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)).applyRelayControlCapture(f.pool)
  for(const id of [oldScope,newScope])await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,$1::uuid::text)",[id])
  await f.pool.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,'native policy synthetic')",[team,oldScope])
  for(const [installation,kind,scope,parent]of [[child,'team',team,oldScope],[oldParent,'organization',oldScope,null],[newParent,'organization',newScope,null]]){
   await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,'active','{}','{}','{}','from_now')",[installation,kind,scope])
   await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
   await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,parent_organization_id,state,authorization_epoch) VALUES($1,$2,$3,$4,'active',1)",[installation,kind,scope,parent])
  }
  const policies=createReviewPolicyRepository(f.runtime)
  await policies.ensurePolicySet(child,{...DEFAULT_TEAM_REVIEW_POLICY})
  oldHead=(await policies.ensurePolicySet(oldParent,{...DEFAULT_ORGANIZATION_REVIEW_POLICY})).policyVersionId
  newHead=(await policies.ensurePolicySet(newParent,{...DEFAULT_ORGANIZATION_REVIEW_POLICY,minimum_approvals:3})).policyVersionId
 },60000)
 afterEach(async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope])
  await f.pool.query("UPDATE public.extension_organizations SET state='active' WHERE organization_id=ANY($1::uuid[])",[[oldScope,newScope]])
  await f.pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
  await f.runtime.query("UPDATE memory_owner_scopes SET state='active' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
  await f.runtime.query("UPDATE memory_installations SET relay_status='active',local_status='ready' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
 })
 afterAll(async()=>{await f?.close()})
 test('the unchanged native parent contributes its actual policy version',async()=>{expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead,policy:{minimum_approvals:2}})})
 test('native parent move uses the new parent policy before local mirror refresh',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  expect(await snapshot()).toMatchObject({parentActiveVersionId:newHead,policy:{minimum_approvals:3}})
 })
 test('native parent suspension defeats an active local parent cache',async()=>{
  await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[oldScope])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('native target revocation defeats a ready active local cache',async()=>{
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[child])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('Git inheritance locks the actual native parent instead of the stale cached parent',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope]);const c=await f.runtime.connect()
  try{await c.query('BEGIN');expect((await lockGitPolicyScopes(c,{primaryInstallationId:child,configVersion:'1',scopeBindings:[]},child)).sort()).toEqual([child,newParent].sort())}finally{await c.query('ROLLBACK');c.release()}
 })
 test('current parent local privacy tombstone is enforced even with stale cached ancestry',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-privacy')",[newScope])
  try{await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')}finally{await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[newScope])}
 })
 test('native parent installation revocation cannot fall back to the organization floor',async()=>{
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[oldParent])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('local cached native states are not a second authority',async()=>{
  await f.runtime.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent]])
  await f.runtime.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent]])
  expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead,policy:{minimum_approvals:2}})
 })
 test('local parent purge remains an independent deny gate',async()=>{
  await f.runtime.query("UPDATE memory_installations SET local_status='purging' WHERE installation_id=$1",[oldParent])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('a pre-extension grant contract fails closed instead of falling back to cached policy ancestry',async()=>{
  const definition=(await f.pool.query("SELECT pg_get_functiondef('shared.memory_current_grant_states(uuid[],uuid[])'::regprocedure) AS definition")).rows[0].definition as string
  try{
   await f.pool.query(definition.replace("'policy_contract_version',1,", "'previous_policy_contract_version',1,"))
   await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await f.pool.query(definition)}
 })
 test('installed native parent tombstones fence a stale cached ancestry until COMMIT',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  const c=await f.runtime.connect(),tombstone=()=>f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-parent')",[newScope])
  try{
   await c.query('BEGIN');await loadEffectiveReviewPolicySnapshot(c,child)
   await expect(tombstone()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await tombstone();await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[newScope])}
 })
 test('native ancestry locks remain held after a service savepoint until physical COMMIT',async()=>{
  const c=await f.runtime.connect(),other=await f.pool.connect()
  try{
   await c.query('BEGIN');const alias=await createTransactionBoundPool(c).connect();await alias.query('BEGIN')
   expect(await loadEffectiveReviewPolicySnapshot(alias,child)).toMatchObject({parentActiveVersionId:oldHead})
   await alias.query('COMMIT');alias.release()
   await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'")
   await expect(other.query('SELECT team_id FROM public.extension_teams WHERE team_id=$1 FOR UPDATE NOWAIT',[team])).rejects.toMatchObject({code:'55P03'})
   await other.query('ROLLBACK');await c.query('COMMIT')
   await other.query('BEGIN');await other.query('SELECT team_id FROM public.extension_teams WHERE team_id=$1 FOR UPDATE NOWAIT',[team]);await other.query('ROLLBACK')
  }finally{await c.query('ROLLBACK');await other.query('ROLLBACK');c.release();other.release()}
 })
 test('native installed parent wins over historical terminal installations',async()=>{
  const historical=randomUUID()
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'revoked','{}','{}','{}','from_now')",[historical,oldScope])
  try{expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead})}finally{await f.pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[historical])}
 })
 test('genuinely uninstalled parent uses the existing organization floor and fences installation phantoms',async()=>{
  const scope=randomUUID(),installation=randomUUID(),c=await f.runtime.connect()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'uninstalled parent synthetic')",[scope])
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,scope])
  const insert=()=>f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}','{}','from_now')",[installation,scope])
  try{
   await c.query('BEGIN');expect(await loadEffectiveReviewPolicySnapshot(c,child)).toMatchObject({parentActiveVersionId:null,policy:{minimum_approvals:2}})
   await expect(insert()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await insert()
   await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope]);await f.pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[installation]);await f.pool.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[scope])}
 })
 test('uninstalled native parent privacy changes are fenced by its child until physical COMMIT',async()=>{
  const scope=randomUUID(),c=await f.runtime.connect()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'uninstalled private parent synthetic')",[scope])
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,scope])
  const tombstone=()=>f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic')",[scope])
  try{
   await c.query('BEGIN');await loadEffectiveReviewPolicySnapshot(c,child)
   await expect(tombstone()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await tombstone();await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[scope]);await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope]);await f.pool.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[scope])}
 })
})
