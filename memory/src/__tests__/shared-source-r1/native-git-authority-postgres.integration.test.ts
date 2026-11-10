import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {requireCurrentGitAuthorization,type GitAuthorizationStamp} from '../../git-sync/authorization.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('Git background stamps use current native authority before mirror refresh',()=>{
 let f:DirectLaunchFixture,stamp:GitAuthorizationStamp
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);const {owner}=await f.source(),installation=randomUUID(),organization=randomUUID(),member=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'native Git synthetic organization')",[organization])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}','{}','from_now')",[installation,organization])
  await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'organization',$2,$3,ARRAY['contributor'])",[member,organization,owner])
  await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,state,authorization_epoch) VALUES($1,'organization',$2,'active',1)",[installation,organization])
  await f.runtime.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['contributor'],'active',1)",[installation,member])
  stamp={installationId:installation,ownerScopeKind:'organization',ownerScopeId:organization,membershipId:member,membershipRevision:'1',authorizationEpoch:'1',configVersion:'1'}
 },60000)
 afterAll(async()=>{await f?.close()})
 const authorize=async()=>{const c=await f.runtime.connect();try{await c.query('BEGIN');return await requireCurrentGitAuthorization(c,stamp,'contribute')}finally{await c.query('ROLLBACK');c.release()}}
 test('current native and local facts authorize an unchanged background stamp',async()=>{expect(await authorize()).toEqual(stamp)})
 test('native installation config changes defeat a still-current local mirror',async()=>{
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[stamp.installationId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[stamp.installationId])}
 })
 test('native member revocation defeats a stale active local member',async()=>{
  await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[stamp.membershipId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.pool.query("UPDATE public.extension_scope_memberships SET state='active',membership_revision=1 WHERE membership_id=$1",[stamp.membershipId])}
 })
 test('native scope suspension defeats a stale active local scope',async()=>{
  await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[stamp.ownerScopeId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.pool.query("UPDATE public.extension_organizations SET state='active' WHERE organization_id=$1",[stamp.ownerScopeId])}
 })
 test('a current native background stamp does not wait for stale local config and roles',async()=>{
  const fresh={...stamp,configVersion:'2',membershipRevision:'2'},client=await f.runtime.connect()
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[stamp.installationId])
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,roles=ARRAY['publisher'] WHERE membership_id=$1",[stamp.membershipId])
  try{
   await client.query('BEGIN');expect(await requireCurrentGitAuthorization(client,fresh,'publish')).toEqual(fresh)
  }finally{
   await client.query('ROLLBACK');client.release();await f.pool.query('UPDATE public.extension_installations SET config_version=1 WHERE installation_id=$1',[stamp.installationId])
   await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=1,roles=ARRAY['contributor'] WHERE membership_id=$1",[stamp.membershipId])
  }
 })
 test('native background authorization retains local expiry and privacy tombstones',async()=>{
  await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[stamp.membershipId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.runtime.query('UPDATE memory_scope_memberships SET valid_until=NULL WHERE membership_id=$1',[stamp.membershipId])}
  await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-local-privacy')",[stamp.ownerScopeId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[stamp.ownerScopeId])}
 })
 test('native background authorization does not restore revoked native membership from local roles',async()=>{
  await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked' WHERE membership_id=$1",[stamp.membershipId])
  try{await expect(authorize()).rejects.toThrow('git_authorization_stale')}finally{await f.pool.query("UPDATE public.extension_scope_memberships SET state='active' WHERE membership_id=$1",[stamp.membershipId])}
 })
 test('background authorization retains the native commit barrier through the transaction',async()=>{
  const reader=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await reader.query('BEGIN');await requireCurrentGitAuthorization(reader,stamp,'contribute')
   await writer.query('BEGIN')
   await expect(writer.query('SELECT 1 FROM public.extension_installations WHERE installation_id=$1 FOR UPDATE NOWAIT',[stamp.installationId])).rejects.toMatchObject({code:'55P03'})
  }finally{await writer.query('ROLLBACK');writer.release();await reader.query('ROLLBACK');reader.release()}
 })
})
