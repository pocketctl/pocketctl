import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { createGitProjectService, parseGitProject } from '../team/git-projects.js'
import { initializeGitTeamMemory } from '../team/git-memory-setup.js'
import { upsertProviderDefinitions } from '../extensions/catalog.js'

const url = process.env.TEST_DATABASE_URL
const integration = url && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
integration('Git project persistence and Team authority', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const u = new URL(url!), name = u.pathname.slice(1)
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) || !/test/.test(name) || u.username !== name || u.searchParams.has('options')) throw new Error('isolated test database required')
    pool = new pg.Pool({ connectionString: url, max: 8 })
    const identity = (await pool.query(`SELECT current_database() AS name,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if (identity.name !== name || identity.role !== name || identity.superuser) throw new Error('unexpected database identity')
    await initDB(pool)
    await upsertProviderDefinitions(pool)
  }, 60_000)
  afterAll(async () => { if (pool) await pool.end() })
  async function fixture() {
    const key = randomUUID(), repo = new TeamRepository(pool)
    const owner = Number((await pool.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'fixture',true) RETURNING id`, [`${key}@example.test`])).rows[0].id)
    const team = (await repo.createTeam({ actorUserId: owner, name: 'PocketCTL', requestId: key })).team
    return { owner, team, service: createGitProjectService(pool), input: parseGitProject({ name: 'Project', repository_url: 'https://github.com/owner/repo.git', branch: 'main', request_id: key }) }
  }
  test('creates a durable project before a shared Memory scope exists', async () => {
    const f = await fixture(), result = await f.service.create(f.team.id, f.owner, f.input)
    expect(result.created).toBe(true); expect(result.project.setup).toBe('memory_required')
    expect(result.project.repository_url).toBe('https://github.com/owner/repo')
    const reread = await createGitProjectService(pool).list(f.owner)
    expect(reread.projects).toContainEqual(expect.objectContaining({ id: result.project.id, name: 'Project', setup: 'memory_required' }))
    expect(reread.teams).toContainEqual(expect.objectContaining({ id: f.team.id, can_create: true }))
  })
  test('concurrent retries create one row and changed requests cannot replace it', async () => {
    const f = await fixture()
    const results = await Promise.all(Array.from({ length: 6 }, () => f.service.create(f.team.id, f.owner, f.input)))
    expect(new Set(results.map(r => r.project.id)).size).toBe(1)
    expect(results.filter(r => r.created)).toHaveLength(1)
    await expect(f.service.create(f.team.id, f.owner, { ...f.input, name: 'different' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(f.service.create(f.team.id, f.owner, { ...f.input, request_id: randomUUID() })).rejects.toMatchObject({ code: 'project_exists' })
  })
  test('viewers can see Team projects but cannot create; revocation removes reads and writes', async () => {
    const f = await fixture(); await f.service.create(f.team.id, f.owner, f.input)
    const viewer = Number((await pool.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'fixture',true) RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id)
    await pool.query(`INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id,role) VALUES($1,$2,$3,'viewer')`, [randomUUID(), f.team.id, viewer])
    expect((await f.service.list(viewer)).teams[0].can_create).toBe(false)
    expect((await f.service.list(viewer)).projects).toHaveLength(1)
    await expect(f.service.create(f.team.id, viewer, { ...f.input, request_id: randomUUID(), branch: 'other' })).rejects.toMatchObject({ code: 'creator_required' })
    await pool.query(`UPDATE collaboration_team_memberships SET state='removed' WHERE team_id=$1 AND user_id=$2`, [f.team.id, viewer])
    expect((await f.service.list(viewer)).projects).toEqual([])
    await expect(f.service.create(f.team.id, viewer, f.input)).rejects.toMatchObject({ code: 'team_access_denied' })
  })
  test('foreign accounts and dissolved teams do not expose projects', async () => {
    const f = await fixture(); await f.service.create(f.team.id, f.owner, f.input)
    expect((await f.service.list(-1)).projects).toEqual([])
    await expect(f.service.create(f.team.id, -1, f.input)).rejects.toMatchObject({ code: 'team_access_denied' })
    await pool.query(`UPDATE collaboration_teams SET state='dissolved' WHERE team_id=$1`, [f.team.id])
    expect((await f.service.list(f.owner)).projects).toEqual([])
  })
  test('initialization atomically creates one shared scope, installation and Team binding across concurrent retries',async()=>{
    const f=await fixture()
    const results=await Promise.all(Array.from({length:4},()=>initializeGitTeamMemory(pool,f.team.id,f.owner)))
    expect(new Set(results.map(r=>r.installation_id)).size).toBe(1)
    const id=results[0].installation_id
    const row=(await pool.query(`SELECT i.status,i.owner_scope_kind,i.enabled_services,m.roles FROM extension_installations i
      JOIN extension_scope_memberships m ON m.scope_id=i.owner_scope_id WHERE i.installation_id=$1`,[id])).rows[0]
    expect(row).toMatchObject({status:'pending',owner_scope_kind:'organization',enabled_services:['memory.search','memory.manage'],roles:['scope_administrator']})
    expect((await pool.query('SELECT count(*)::int AS n FROM team_memory_bindings WHERE team_id=$1',[f.team.id])).rows[0].n).toBe(1)
    expect((await f.service.create(f.team.id,f.owner,f.input)).project).toMatchObject({memory_installation_id:id,memory_status:'pending',can_initialize:true})
  })
  test('only the Team creator initializes Memory and failed setup cannot leave an orphan scope',async()=>{
    const f=await fixture(),admin=Number((await pool.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'fixture',true) RETURNING id`,[`${randomUUID()}@example.test`])).rows[0].id)
    await pool.query(`INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id,role) VALUES($1,$2,$3,'admin')`,[randomUUID(),f.team.id,admin])
    await expect(initializeGitTeamMemory(pool,f.team.id,admin)).rejects.toMatchObject({code:'creator_required'})
    await pool.query(`UPDATE extension_providers SET status='disabled' WHERE provider_id='pocketctl-memory'`)
    try{await expect(initializeGitTeamMemory(pool,f.team.id,f.owner)).rejects.toThrow('memory_provider_disabled')}
    finally{await pool.query(`UPDATE extension_providers SET status='enabled' WHERE provider_id='pocketctl-memory'`)}
    expect((await pool.query('SELECT count(*)::int AS n FROM extension_organizations WHERE created_by_user_id=$1',[f.owner])).rows[0].n).toBe(0)
  })
})
