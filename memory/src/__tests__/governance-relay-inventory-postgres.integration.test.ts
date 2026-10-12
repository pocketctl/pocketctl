import pg from 'pg'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {beforeAll,afterAll,beforeEach,describe,test,expect} from 'vitest'
import {applyMemoryV50Fixture,V50_IDS} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios} from '../testing/fixtures/memory-v50-upgrade.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,relayUrl=process.env.RELAY_TEST_DATABASE_URL
const suite=url&&relayUrl&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const OWNER='a0500300-0000-4000-8000-000000000001',ORG='a0500300-0000-4000-8000-000000000002',SOURCE='a0500300-0000-4000-8000-000000000003'
suite('separate read-only Relay/Memory inventory reconciliation',()=>{
 let memory:pg.Pool,relay:pg.Pool,user:number
 beforeAll(async()=>{
  memory=new pg.Pool({connectionString:url});relay=new pg.Pool({connectionString:relayUrl})
  await assertMemoryTestDatabase(memory,url!)
  const u=new URL(relayUrl!)
  if(u.hostname!=='127.0.0.1'||u.pathname!=='/pocketctl_relay_upgrade_test'||u.username!=='pocketctl_relay_upgrade_test'||u.search)throw Error('Relay isolated identity required')
  const r=(await relay.query('SELECT current_database() AS db,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super')).rows[0]
  if(r.db!==u.username||r.role!==u.username||r.super)throw Error('Relay isolated role required')
 })
 afterAll(async()=>{await memory?.end();await relay?.end()})
 beforeEach(async()=>{
  await memory.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await relay.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await applyMemoryV50Fixture(memory,url!);await seedMemoryV50UpgradeScenarios(memory,url!)
  const module=fileURLToPath(new URL('../../../relay/src/db.ts',import.meta.url));await (await import(module)).initDB(relay)
  user=Number((await relay.query("INSERT INTO users(email,password_hash,team_enabled) VALUES('inventory-private@example.test','private-not-exported',true) RETURNING id")).rows[0].id)
  await relay.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}')")
  await relay.query("INSERT INTO extension_organizations(organization_id,name) VALUES($1,'private organization')",[ORG])
  await relay.query("INSERT INTO extension_teams(team_id,organization_id,name,authorization_epoch) VALUES($1,$2,'private team',1)",[OWNER,ORG])
  for(const [installation,kind,owner] of [[V50_IDS.personal,'personal',V50_IDS.personal],[V50_IDS.team,'team',OWNER]])await relay.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy) VALUES($1,'pocketctl-memory',$2,$3,$4,'active','{}','{}','{}','{}','from_now')`,[installation,kind==='personal'?user:null,kind,owner])
  await memory.query('UPDATE memory_owner_scopes SET owner_scope_id=$2 WHERE installation_id=$1',[V50_IDS.team,OWNER])
  await relay.query("INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES('ctm_inventory','private collaborative team',$1)",[user])
  await relay.query("INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES('cmm_inventory','ctm_inventory',$1)",[user])
  await relay.query("INSERT INTO team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,created_by_user_id) VALUES('cmb_inventory','ctm_inventory','team',$1,$2,$3)",[OWNER,V50_IDS.team,user])
  await relay.query("INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES('css_inventory','ctm_inventory',$1,'private session')",[user])
  await relay.query("INSERT INTO collaboration_session_participants(participant_id,team_session_id,user_id,added_by_user_id,revision) VALUES('csp_inventory','css_inventory',$1,$1,1)",[user])
  const payload={team_source:{team_id:'ctm_inventory',team_session_id:'css_inventory',read_scope:{team_memory_binding_id:'cmb_inventory',team_memory_binding_revision:1,target_installation_id:V50_IDS.team,target_owner_scope_kind:'team',target_owner_scope_id:OWNER,participant_user_id:user,participant_revision:1}}}
  await memory.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,event_type,occurred_at,payload,payload_hash) VALUES($1,$2,'feed','inventory-source','agent_message',NOW(),$3,sha256($4::bytea))`,[SOURCE,V50_IDS.personal,payload,Buffer.from(JSON.stringify(payload))])
 },60000)
 const run=()=>spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../migrations/governance-v2/cli.ts',import.meta.url)),'plan','--relay'],{encoding:'utf8',env:{...process.env,MEMORY_MIGRATION_DATABASE_URL:url,MEMORY_MIGRATION_RELAY_DATABASE_URL:relayUrl}})
 test('matches distinct owner/installation identities and records two non-atomic snapshot watermarks without private fields',()=>{
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m).toHaveProperty('relay.compatible',true);expect(m.reconciliation.snapshotsAreAtomic).toBe(false)
  expect(m.reconciliation.counts).toMatchObject({scopeMatched:2,sourceMatched:1})
  expect(m.relay.watermarks).toHaveProperty('scopeOutboxId')
  expect(r.stdout).not.toContain('inventory-private@example.test');expect(r.stdout).not.toContain('private session');expect(r.stdout).not.toContain('isolated-relay-test')
 })
 test('reports stale scope epoch and participant generation without deleting accepted capsules',async()=>{
  await relay.query('UPDATE extension_teams SET authorization_epoch=2 WHERE team_id=$1',[OWNER])
  await relay.query("UPDATE collaboration_session_participants SET revision=2,state='removed' WHERE participant_id='csp_inventory'")
  const before=Number((await memory.query('SELECT COUNT(*) AS n FROM knowledge_versions')).rows[0].n)
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m).toHaveProperty('reconciliation.items');expect(m.reconciliation.items).toContainEqual(expect.objectContaining({id:V50_IDS.team,reason:'scope_epoch_mismatch'}))
  expect(m).toHaveProperty('reconciliation.items');expect(m.reconciliation.items).toContainEqual(expect.objectContaining({id:SOURCE,reason:'participant_generation_mismatch'}))
  expect(Number((await memory.query('SELECT COUNT(*) AS n FROM knowledge_versions')).rows[0].n)).toBe(before)
 })
 test('binding replacement is distinct from participant re-entry',async()=>{
  await relay.query("UPDATE team_memory_bindings SET revision=2 WHERE binding_id='cmb_inventory'")
  const r=run();expect(r.status,r.stderr).toBe(0)
  expect(JSON.parse(r.stdout)).toHaveProperty('reconciliation.items');expect(JSON.parse(r.stdout).reconciliation.items).toContainEqual(expect.objectContaining({id:SOURCE,reason:'binding_generation_mismatch'}))
 })
 test('a missing Relay schema is not silently treated as an empty authoritative registry',async()=>{
  await relay.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const r=run();expect(r.status,r.stderr).toBe(0);expect(JSON.parse(r.stdout)).toHaveProperty('relay.compatible',false)
 })
 test('malformed source provenance cannot echo payload text into the manifest',async()=>{
  await memory.query(`UPDATE source_events SET payload=jsonb_set(payload,'{team_source,team_id}','"PRIVATE_SOURCE_TEXT_MARKER with spaces"') WHERE source_event_id=$1`,[SOURCE])
  const r=run();expect(r.status,r.stderr).toBe(0)
  expect(r.stdout).not.toContain('PRIVATE_SOURCE_TEXT_MARKER')
  expect(JSON.parse(r.stdout)).toHaveProperty('reconciliation.items')
  expect(JSON.parse(r.stdout).reconciliation.items).toContainEqual(expect.objectContaining({id:SOURCE,reason:'invalid_source_provenance'}))
 })
 test('reconciliation scans all source pages while every stdout preview remains bounded',async()=>{
  await memory.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,event_type,occurred_at,payload,payload_hash)
   SELECT gen_random_uuid(),installation_id,origin,'page-'||n,event_type,occurred_at,payload,payload_hash FROM source_events CROSS JOIN generate_series(1,107)n WHERE source_event_id=$1`,[SOURCE])
  const r=run();expect(r.status,r.stderr).toBe(0);const m=JSON.parse(r.stdout)
  expect(m).toHaveProperty('reconciliation.counts.sourceMatched',108)
  expect(m.memory.teamSources.length).toBeLessThanOrEqual(100)
  expect(m.memory.teamSourcesTruncated).toBe(true)
 })

 test('a participant identifier outside the PostgreSQL user-id domain is quarantined without aborting the scan',async()=>{
  await memory.query(`UPDATE source_events SET payload=jsonb_set(payload,'{team_source,read_scope,participant_user_id}','999999999999') WHERE source_event_id=$1`,[SOURCE])
  const r=run();expect(r.status,r.stderr).toBe(0)
  expect(JSON.parse(r.stdout).reconciliation.items).toContainEqual(expect.objectContaining({id:SOURCE,reason:'invalid_source_provenance'}))
 })

})
