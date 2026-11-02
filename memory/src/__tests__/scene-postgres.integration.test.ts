import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {logicalIdentity} from '../claims/logical-identity.js'
import {createSceneRepository} from '../context/scene-repository.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('contextual space persistence',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(){
  const f=await governanceFixture(pool),repo=createSceneRepository(pool)
  const grant={primaryInstallationId:f.personal,configVersion:'1',scopeBindings:[{installation_id:f.personal,owner_scope_kind:'personal' as const,owner_scope_id:f.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read','scope_admin']}]}
  return {f,repo,grant}
 }
 test('stores non-repository life space; revalidates grant on read',async()=>{
  const {f,repo,grant}=await setup()
  const space=await repo.create({grant,installationId:f.personal,name:'旅行',domain:'life',destinations:['personal']})
  expect(await repo.resolve({grant,installationId:f.personal,destination:'personal',explicitSpaceId:space.spaceId})).toMatchObject({status:'resolved',spaceId:space.spaceId})
  expect((await repo.resolve({grant,installationId:f.personal,destination:'work',explicitSpaceId:space.spaceId})).status).toBe('unresolved')
  await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=2 WHERE installation_id=$1',[f.personal])
  await expect(repo.resolve({grant,installationId:f.personal,destination:'personal',explicitSpaceId:space.spaceId})).rejects.toThrow()
 })
 test('installation boundary enforced by service and composite entity FK',async()=>{
  const {f,repo,grant}=await setup()
  await expect(repo.create({grant,installationId:f.team,name:'wrong',domain:'life',destinations:['personal']})).rejects.toThrow()
  const space=await repo.create({grant,installationId:f.personal,name:'旅行',domain:'life',destinations:['personal']})
  await expect(pool.query(`INSERT INTO memory_entities(installation_id,space_id,entity_id,kind,name) VALUES($1,$2,gen_random_uuid(),'person','same name')`,[f.team,space.spaceId])).rejects.toThrow()
 })
 test('same-name spaces remain distinct; archived space cannot resolve',async()=>{
  const {f,repo,grant}=await setup()
  const a=await repo.create({grant,installationId:f.personal,name:'项目',domain:'work',destinations:['personal']})
  const b=await repo.create({grant,installationId:f.personal,name:'项目',domain:'personal_project',destinations:['personal']})
  expect(a.spaceId).not.toBe(b.spaceId)
  await pool.query("UPDATE memory_spaces SET state='archived',revision=revision+1 WHERE space_id=$1",[a.spaceId])
  expect((await repo.resolve({grant,installationId:f.personal,destination:'personal',explicitSpaceId:a.spaceId})).status).toBe('unresolved')
 })
 test('one logical identity maps to one Claim and must bind an entity in that space',async()=>{
  const {f,repo,grant}=await setup()
  const a=await repo.create({grant,installationId:f.personal,name:'A',domain:'work',destinations:['personal']})
  const b=await repo.create({grant,installationId:f.personal,name:'B',domain:'work',destinations:['personal']})
  const entity=(await pool.query(`INSERT INTO memory_entities(installation_id,space_id,kind,name) VALUES($1,$2,'service','API') RETURNING entity_id`,[f.personal,a.spaceId])).rows[0].entity_id
  const key=logicalIdentity({installationId:f.personal,spaceId:a.spaceId,subjectEntityId:entity,predicateId:'service.timeout',cardinality:'single'})
  const sql=`INSERT INTO memory_logical_claims(installation_id,space_id,subject_entity_id,logical_key,predicate_id,cardinality,claim_id) VALUES($1,$2,$3,$4,'service.timeout','single',$5)`
  await expect(pool.query(sql,[f.personal,b.spaceId,entity,key,f.claim])).rejects.toThrow()
  await pool.query(sql,[f.personal,a.spaceId,entity,key,f.claim])
  await expect(pool.query(sql,[f.personal,a.spaceId,entity,key,f.claim])).rejects.toThrow()
  expect((await pool.query('SELECT count(*)::int n FROM memory_logical_claims')).rows[0].n).toBe(1)
 })

})
