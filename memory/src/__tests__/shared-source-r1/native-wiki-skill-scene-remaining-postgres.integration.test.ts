import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {requireCurrentWikiPermission} from '../../wiki/authorization.js'
import {createWikiPublicationService} from '../../wiki/publication-service.js'
import {createSkillReadService} from '../../skills/read-service.js'
import {loadSkillConfig} from '../../skills/config.js'
import {createSceneRepository} from '../../context/scene-repository.js'
import {resolveSelectedContextReferences} from '../../context/compiler.js'
import {insertWikiCandidateFixture} from '../helpers/phase4-wiki-fixture.js'
import type {ValidatedV2Grant} from '../../governance/authorization.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('native Wiki Skills and scene authority ignores stale mirrors',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 async function setup(){
  const installation=randomUUID(),scope=randomUUID(),member=randomUUID(),source=await f.source()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'authority regression')",[scope])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}','{}','from_now')",[installation,scope])
  await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'organization',$2,$3,ARRAY['scope_administrator'])",[member,scope,source.owner])
  await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
  await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$2)",[installation,scope])
  await f.runtime.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['scope_administrator'])",[installation,member])
  const grant:ValidatedV2Grant={primaryInstallationId:installation,configVersion:'1',userId:source.owner,scopeBindings:[{installation_id:installation,owner_scope_kind:'organization',owner_scope_id:scope,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','contribute','publish','scope_admin']}]}
  const skill=createSkillReadService({pool:f.runtime,context:{globalMode:'shadow',sharedMode:'shadow',config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})},cursorSigningKey:'synthetic-only'})
  const wiki=async()=>{const c=await f.runtime.connect();try{await c.query('BEGIN');return await requireCurrentWikiPermission({client:c,grant,targetInstallationId:installation,permission:'publish'})}finally{await c.query('ROLLBACK');c.release()}}
  const scene=createSceneRepository(f.runtime)
  const create=()=>scene.create({grant,installationId:installation,name:'Authority regression',domain:'work',destinations:['shared']})
  const stale=async()=>{
   await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[installation])
   await f.pool.query('UPDATE public.extension_organizations SET authorization_epoch=2 WHERE organization_id=$1',[scope])
   await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1",[member])
   grant.configVersion='2';grant.scopeBindings[0].authorization_epoch='2';grant.scopeBindings[0].membership_revision='2'
   await f.runtime.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[installation])
   await f.runtime.query("UPDATE memory_owner_scopes SET state='suspended',owner_scope_id=$2 WHERE installation_id=$1",[installation,randomUUID()])
   await f.runtime.query("UPDATE memory_scope_memberships SET state='revoked',roles=ARRAY['reader'] WHERE membership_id=$1",[member])
  }
  const selected=async()=>{
   const w=await insertWikiCandidateFixture(f.runtime,randomUUID(),installation)
   await createWikiPublicationService(f.runtime).publish({grant,targetInstallationId:installation,wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:0})
   const section=(await f.runtime.query('SELECT section_id::text,wiki_version_id::text FROM memory_wiki_sections WHERE installation_id=$1',[installation])).rows[0]
   return ()=>resolveSelectedContextReferences(f.runtime,installation,[{source_kind:'wiki_section',source_id:section.section_id,source_version:section.wiki_version_id,owner_scope_id:scope,installation_id:installation}])
  }
  return {installation,scope,member,grant,wiki,skill,scene,create,stale,selected,identity:{installationId:installation,grant}}
 }
 for(const feature of ['wiki','skills','scene'] as const){
  const run=async(s:Awaited<ReturnType<typeof setup>>)=>feature==='wiki'?s.wiki():feature==='skills'?s.skill.list(s.identity,{}):s.create()
  test(`${feature} accepts fresh native config epoch membership roles and owner with stale mirrors`,async()=>{
   const s=await setup();await s.stale();expect(await run(s)).toBeDefined()
   if(feature==='scene'){const created=await s.create();expect(await s.scene.resolve({grant:s.grant,installationId:s.installation,destination:'shared',explicitSpaceId:created.spaceId})).toMatchObject({status:'resolved',spaceId:created.spaceId})}
  })
  for(const change of ['revoked','suspended','expired','purged','privacy'] as const)test(`${feature} rejects current native/local ${change} despite active mirrors`,async()=>{
   const s=await setup()
   if(change==='revoked')await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.member])
   if(change==='suspended')await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[s.scope])
   if(change==='expired')await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[s.member])
   if(change==='purged')await f.runtime.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[s.installation])
   if(change==='privacy')await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic')",[s.scope])
   await expect(run(s)).rejects.toThrow()
  })
 }
 test('selected Wiki resolves current native owner kind/id and ignores stale cached scope state',async()=>{
  const s=await setup(),selected=await s.selected();await s.stale()
  expect(await selected()).toMatchObject([{kind:'wiki',scopeKind:'organization'}])
 })
 for(const change of ['revoked','suspended','purged','privacy','wrong_owner'] as const)test(`selected Wiki rejects ${change} authority`,async()=>{
  const s=await setup(),selected=await s.selected()
  if(change==='revoked')await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[s.installation])
  if(change==='suspended')await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[s.scope])
  if(change==='purged')await f.runtime.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[s.installation])
  if(change==='privacy')await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic')",[s.scope])
  if(change==='wrong_owner')await f.pool.query('UPDATE public.extension_installations SET owner_scope_id=$2 WHERE installation_id=$1',[s.installation,randomUUID()])
  expect(await selected()).toBeNull()
 })
 test('personal selected Wiki keeps native ownership and local purge independent of stale scope metadata',async()=>{
  const source=await f.source(),installation=(await f.install(source,'retained_history')).inst.installation_id
  await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[installation])
  const w=await insertWikiCandidateFixture(f.runtime,randomUUID(),installation),grant={...w.grant,userId:source.owner}
  await createWikiPublicationService(f.runtime).publish({grant,targetInstallationId:installation,wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:0})
  const section=(await f.runtime.query('SELECT section_id::text,wiki_version_id::text FROM memory_wiki_sections WHERE installation_id=$1',[installation])).rows[0]
  const selected=()=>resolveSelectedContextReferences(f.runtime,installation,[{source_kind:'wiki_section',source_id:section.section_id,source_version:section.wiki_version_id,owner_scope_id:installation,installation_id:installation}])
  await f.runtime.query("UPDATE memory_owner_scopes SET state='suspended',owner_scope_kind='organization',owner_scope_id=$2 WHERE installation_id=$1",[installation,randomUUID()])
  expect(await selected()).toMatchObject([{kind:'wiki',scopeKind:'personal'}])
  await f.runtime.query("UPDATE memory_installations SET local_status='purging' WHERE installation_id=$1",[installation])
  expect(await selected()).toBeNull()
 })
})
