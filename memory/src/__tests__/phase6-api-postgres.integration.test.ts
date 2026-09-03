import Fastify from 'fastify'
import pg from 'pg'
import { randomUUID, createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { createIdempotencyStore } from '../api/idempotency.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { createGitRuntime } from '../git-sync/runtime.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { prepareGovernedImport,requireImportQuorum,assertImportApproval,lockImportProposal } from '../git-sync/governance-adapter.js'
import {createGitReadService} from '../git-sync/read-service.js'
import {registerMemoryTools} from '../mcp/tools.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const suite = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('Phase 6 REST authority, transaction and retained body boundaries', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await applyMemorySchema(pool)
  }, 60_000)
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations CASCADE') })
  afterAll(async () => { await pool?.end() })
  test('READ COMMITTED inner commit cannot escape failed API idempotency transaction', async () => {
    const s = await gitImportFixture(pool)
    const notices: string[] = []
    const watched = await pool.connect()
    watched.on('notice', notice => notices.push(notice.message ?? 'notice'))
    watched.release()
    const result = await createIdempotencyStore(pool).execute({
      installationId: s.f.installationId, operation: 'git:test', key: 'rollback', requestCanonical: 'fixture',
      run: async client => {
        const inner = await createTransactionBoundPool(client).connect()
        await inner.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await inner.query("UPDATE memory_git_connections SET target_id='must-rollback' WHERE connection_id=$1", [s.f.connectionId])
        await inner.query('COMMIT'); inner.release()
        return { ok: false, error: new Error('later failure') }
      },
    })
    expect(result.kind).toBe('failed')
    expect((await pool.query('SELECT target_id FROM memory_git_connections WHERE connection_id=$1', [s.f.connectionId])).rows[0].target_id).toBe('fixture-target')
    expect((await pool.query('SELECT count(*)::int n FROM memory_idempotency_keys')).rows[0].n).toBe(0)
    expect(notices).toEqual([])
  })
  test('transaction adapter rolls back only inner changes and rejects alternate transaction commands',async()=>{
    const s=await gitImportFixture(pool)
    const result=await createIdempotencyStore(pool).execute({installationId:s.f.installationId,operation:'git:savepoint',key:'inner',requestCanonical:'same',isolation:'read_committed',run:async client=>{
      expect((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation).toBe('read committed')
      const bound=createTransactionBoundPool(client),inner=await bound.connect()
      await inner.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await inner.query("UPDATE memory_git_connections SET target_id='rolled-back' WHERE connection_id=$1",[s.f.connectionId])
      await inner.query('ROLLBACK')
      expect((await client.query('SELECT target_id FROM memory_git_connections WHERE connection_id=$1',[s.f.connectionId])).rows[0].target_id).toBe('fixture-target')
      await expect(inner.query('BEGIN ISOLATION LEVEL SERIALIZABLE')).rejects.toThrow('unsupported_transaction_control')
      await expect(inner.query({text:'COMMIT AND CHAIN'})).rejects.toThrow('unsupported_transaction_control')
      await expect(bound.query('COMMIT')).rejects.toThrow('unsupported_transaction_control')
      return {ok:true,metadata:{saved:true}}
    }})
    expect(result.kind).toBe('completed')
  })
  test('parser errors use finite non-content error codes',async()=>{
    const s=await setup()
    try {
      const request={method:'POST' as const,url:`/api/v1/memory/git/connections/${s.f.connectionId}/previews`,headers:{'content-type':'application/json','idempotency-key':'bad-json'}}
      const invalid=await s.app.inject({...request,payload:'{"private-secret":'})
      expect(invalid.statusCode).toBe(400);expect(invalid.json()).toEqual({error:{code:'invalid_request',message:'invalid_request'}})
      const large=await s.app.inject({...request,payload:'x'.repeat(131073)})
      expect(large.statusCode).toBe(413);expect(large.json().error.code).toBe('size_limit')
    }finally{await s.app.close()}
  })
  async function setup(kinds = ['rule']) {
    const s = await gitImportFixture(pool, kinds)
    const module = await import('../api/git-routes.js').catch(() => null)
    expect(module, 'Git REST integration exists').not.toBeNull()
    let actor = s.f.grant
    let mode: 'off' | 'shadow' | 'enabled' = 'shadow'
    const app = Fastify()
    const required: string[] = []
    module!.registerGitRoutes(app, {
      ...s.deps, config: loadGitSyncConfig({ MEMORY_GIT_SYNC_MODE: 'enabled' }),outcomeKind:'fixture',
      scopeMode: async () => mode, targets: { resolve: async () => ({ provider: 'github', providerRepositoryId: '123', branch: 'main', credentialRef: 'private-secret' }) },
      guard: { guardMcp: async ({ requiredService }: { requiredService: string }) => { required.push(requiredService); return { ...actor, version: 'v2', installationId: s.f.installationId, services: [requiredService], callerType: 'web' } } } as never,
      policy: createCorsHostPolicy({ allowedOrigins: ['https://web.example'], allowedHosts: ['localhost'], isProduction: false }),
      webhookRegistration: async () => ({ installationId: s.f.installationId, provider: 'github', providerRepositoryId: '123', targetBranch: 'main', secret: 'synthetic-secret', eventType: 'pull_request' }),
    })
    await app.ready()
    return { ...s, app, required, setActor: (next: typeof actor) => { actor = next }, setMode: (next: typeof mode) => { mode = next } }
  }
  test('reader gets all three current lifecycle-checked versions without server-only metadata', async () => {
    const s = await setup()
    try {
      const { proposals: [p] } = await s.plan()
      const reader = await s.f.skill.actor(['reader'], ['read']); s.setActor(reader.grant)
      const res = await s.app.inject({ url: `/api/v1/memory/git/proposals/${p.proposalId}` })
      expect(res.statusCode, res.body).toBe(200)
      expect(res.json()).toMatchObject({ proposal_id: p.proposalId, revision: '1', capabilities: { can_review: false, can_apply: false }, versions: { base: { revision: '1' }, memory: { revision: '1' }, git: { editable: { statement: 'Governed Git edit' } } } })
      expect(res.body).not.toMatch(/serverOnly|private-branch|privatePath|credential|grant_facts/)
      expect(s.required).toEqual(['memory.search'])
    } finally { await s.app.close() }
  })
  test('bounded proposal and cleanup pages remain reachable with terminal first page and pending outside the page',async()=>{
    const s=await setup()
    try {
      const {proposals:[p]}=await s.plan()
      for(let n=1;n<=21;n++)await pool.query(`INSERT INTO memory_git_import_proposals(proposal_id,installation_id,connection_id,export_id,generation,state,base_revision,base_hash,local_hash,proposed_hash,policy_hash,proposed_document,membership_id,membership_revision,authorization_epoch,head_commit)
        SELECT $2,installation_id,connection_id,export_id,generation,$3,base_revision,base_hash,local_hash,proposed_hash,policy_hash,proposed_document,membership_id,membership_revision,authorization_epoch,$4 FROM memory_git_import_proposals WHERE proposal_id=$1`,[p.proposalId,`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,n<=20?'applied':'awaiting_review',n.toString(16).padStart(40,'0')])
      for(let n=1;n<=51;n++)await pool.query(`INSERT INTO memory_git_remote_cleanup(installation_id,connection_id,export_id,old_run_id,generation,provider,provider_repository_id,target_branch,remote_branch,cleanup_pending)
        VALUES($1,$2,$3,$4,1,'github','123','main','synthetic-cleanup',$5)`,[s.f.installationId,s.f.connectionId,`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,randomUUID(),n===51])
      const list=(await s.app.inject({url:'/api/v1/memory/git/connections'})).json().items[0]
      expect(list).toMatchObject({proposal_total:22,cleanup_total:51,cleanup_pending_count:1,cleanup_pending:true})
      expect(list.proposals).toHaveLength(20);expect(list.cleanup).toHaveLength(50)
      expect(list.cleanup.every((entry:any)=>!entry.cleanup_pending)).toBe(true)
      const base=`/api/v1/memory/git/connections/${s.f.connectionId}`
      const next=await s.app.inject({url:`${base}/proposals?cursor=${list.proposals_next_cursor}&limit=20`})
      expect(next.statusCode,next.body).toBe(200);expect(next.json()).toMatchObject({total:22,next_cursor:null})
      expect(next.json().items).toHaveLength(2);expect(next.json().items.some((entry:any)=>entry.state==='awaiting_review')).toBe(true)
      const cleanup=await s.app.inject({url:`${base}/cleanup?cursor=${list.cleanup_next_cursor}&limit=50`})
      expect(cleanup.statusCode,cleanup.body).toBe(200);expect(cleanup.json()).toMatchObject({total:51,pending_count:1,cleanup_pending:true,next_cursor:null,items:[{cleanup_pending:true}]})
      const handlers=new Map<string,(args:any)=>Promise<any>>()
      registerMemoryTools({registerTool:(name:string,_definition:unknown,handler:any)=>handlers.set(name,handler)} as never,{pool,gitOnly:true,
        grant:()=>({...s.f.grant,version:'v2',installationId:s.f.installationId,services:['memory.mcp'],callerType:'web'}) as never,
        gitReads:createGitReadService({...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),scopeMode:async()=> 'shadow',targets:{resolve:async()=>null}}),sharedScopesEnabled:true,recallEmbeddingTimeoutMs:10,cursorSigningKey:'fixture'})
      const mcp=await handlers.get('memory_git_status')!({connection_id:s.f.connectionId,list:'cleanup',cursor:list.cleanup_next_cursor,limit:50})
      expect(mcp.isError).not.toBe(true);expect(JSON.parse(mcp.content[0].text).items).toHaveLength(1)
      const denied=await handlers.get('memory_git_status')!({installation_id:randomUUID(),connection_id:s.f.connectionId,list:'proposals'})
      expect(denied.isError).toBe(true);expect(JSON.parse(denied.content[0].text).error.code).toBe('forbidden')
      const foreign=await gitImportFixture(pool);s.setActor(foreign.f.grant)
      expect((await s.app.inject({url:`${base}/proposals`})).statusCode).toBe(403)
      expect((await s.app.inject({url:`${base}/cleanup`})).statusCode).toBe(403)
    }finally{await s.app.close()}
  })
  test('preview replay caches IDs only and cannot return purged bodies or borrow another actor', async () => {
    const s = await setup()
    try {
      const req = { method: 'POST' as const, url: `/api/v1/memory/git/connections/${s.f.connectionId}/previews`, headers: { 'idempotency-key': 'preview-once' }, payload: { expected_generation: '1', assets: [{ kind: 'rule', id: s.f.rule.claimId }], reason_code: 'manual_preview' } }
      const first = await s.app.inject(req)
      expect(first.statusCode, first.body).toBe(200)
      expect((await s.app.inject(req)).json()).toEqual(first.json())
      const stored = (await pool.query('SELECT response_metadata FROM memory_idempotency_keys')).rows[0].response_metadata
      expect(Object.keys(stored).sort()).toEqual(['connectionId', 'exportId', 'generation'])
      const other = await s.f.skill.actor(['contributor'], ['read', 'contribute']); s.setActor(other.grant)
      expect((await s.app.inject(req)).statusCode).toBe(409)
      s.setActor(s.f.grant)
      await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1', [s.f.rule.versionId])
      const gone = await s.app.inject(req)
      expect([404,409]).toContain(gone.statusCode)
      expect(gone.body).not.toContain('Synthetic statement')
    } finally { await s.app.close() }
  })
  test('concurrent identical previews commit exactly one bounded receipt and one export',async()=>{
    const s=await setup()
    try {
      const request={method:'POST' as const,url:`/api/v1/memory/git/connections/${s.f.connectionId}/previews`,headers:{'idempotency-key':'concurrent'},payload:{expected_generation:'1',assets:[s.f.keys[1]],reason_code:'manual_preview'}}
      const results=await Promise.all([s.app.inject(request),s.app.inject(request)])
      expect(results.map(r=>r.statusCode)).toEqual([200,200]);expect(results[0].json()).toEqual(results[1].json())
      expect((await pool.query('SELECT count(*)::int n FROM memory_idempotency_keys')).rows[0].n).toBe(1)
      expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='snapshot'")).rows[0].n).toBe(1)
      s.setMode('off');expect((await s.app.inject(request)).statusCode).toBe(503)
    }finally{await s.app.close()}
  })
  test('a committed preview whose response was lost is confirmed by the same key without another export',async()=>{
    const s=await setup()
    try {
      const request={method:'POST' as const,url:`/api/v1/memory/git/connections/${s.f.connectionId}/previews`,headers:{'idempotency-key':'lost-preview-response'},payload:{expected_generation:'1',assets:[s.f.keys[1]],reason_code:'manual_preview'}}
      await s.app.inject(request) // client discards the successful response
      const replay=await s.app.inject(request)
      expect(replay.statusCode,replay.body).toBe(200)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots WHERE export_id=$1',[replay.json().export_id])).rows[0].n).toBe(1)
      expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE action='snapshot'")).rows[0].n).toBe(1)
      expect((await pool.query('SELECT count(*)::int n FROM memory_idempotency_keys')).rows[0].n).toBe(1)
    }finally{await s.app.close()}
  })
  test('strict schema, opaque cross-scope errors, current denial audit and disabled external writes',async()=>{
    const s=await setup()
    try {
      expect((await s.app.inject({url:'/api/v1/memory/git/connections?limit=51'})).statusCode).toBe(400)
      expect((await s.app.inject({method:'POST',url:'/api/v1/memory/git/connections',headers:{'idempotency-key':'create'},payload:{repository_id:s.f.repositoryId,target_id:'registered',sync_mode:'shadow',write_mode:'off',credential_ref:'inject'}})).statusCode).toBe(400)
      const res=await s.app.inject({method:'POST',url:`/api/v1/memory/git/exports/${s.bundle.exportId}/pull-request`,headers:{'idempotency-key':'external'},payload:{expected_generation:'1'}})
      expect(res.statusCode).toBe(503);expect(res.json().error.code).toBe('external_write_disabled')
      const other=await gitImportFixture(pool);s.setActor(other.f.grant)
      const forbidden=await s.app.inject({method:'POST',url:`/api/v1/memory/git/connections/${s.f.connectionId}/previews`,headers:{'idempotency-key':'denied'},payload:{expected_generation:'1',assets:s.f.keys,reason_code:'manual_preview'}})
      expect(forbidden.statusCode).toBe(403);expect(forbidden.body).not.toMatch(/secret|Synthetic|serverOnly/)
      expect((await pool.query("SELECT count(*)::int n FROM memory_git_audit_events WHERE installation_id=$1 AND outcome='denied'",[s.f.installationId])).rows[0].n).toBe(3)
    }finally{await s.app.close()}
  })
  const expected=(detail:any)=>({expected_generation:detail.generation,expected_revision:detail.revision,expected_policy_hash:detail.policy_hash,expected_proposed_hash:detail.proposed_hash,expected_asset_revision:detail.expected_asset_revision})
  test('standalone reviewer uses exact policy/hash/revision and unknown identity denial survives outer rollback',async()=>{
    const s=await setup()
    try {
      const {proposals:[p]}=await s.plan(undefined,null)
      const detail=(await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})).json()
      s.setActor(s.f.skill.reviewer.grant)
      const path=`/api/v1/memory/git/proposals/${p.proposalId}/reviews`
      const bad=await s.app.inject({method:'POST',url:path,headers:{'idempotency-key':'policy'},payload:{...expected(detail),expected_policy_hash:'0'.repeat(64),decision:'approve'}})
      expect(bad.statusCode,bad.body).toBe(409);expect(bad.json().error.code).toBe('policy_changed')
      const denied=await s.app.inject({method:'POST',url:path,headers:{'idempotency-key':'identity'},payload:{...expected(detail),decision:'approve'}})
      expect(denied.statusCode,denied.body).toBe(409)
      expect((await pool.query('SELECT state FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].state).toBe('awaiting_identity')
      expect((await pool.query("SELECT reason_code FROM memory_git_audit_events WHERE action='review' AND outcome='denied' ORDER BY created_at")).rows.map(r=>r.reason_code)).toEqual(['policy_changed','identity_unknown'])
      expect((await pool.query('SELECT count(*)::int n FROM memory_idempotency_keys')).rows[0].n).toBe(0)
    }finally{await s.app.close()}
  })
  test('review/apply uses separate current permissions; replay is denied after mode downgrade',async()=>{
    const s=await setup()
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const {proposals:[p]}=await s.plan(),detail=(await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})).json()
      s.setActor(s.f.skill.reviewer.grant)
      const review=await s.app.inject({method:'POST',url:`/api/v1/memory/git/proposals/${p.proposalId}/reviews`,headers:{'idempotency-key':'approve'},payload:{...expected(detail),decision:'approve'}})
      expect(review.statusCode,review.body).toBe(200)
      s.setActor(s.f.skill.publisher.grant)
      const req={method:'POST' as const,url:`/api/v1/memory/git/proposals/${p.proposalId}/apply`,headers:{'idempotency-key':'apply'},payload:expected(detail)}
      const applied=await s.app.inject(req);expect(applied.statusCode,applied.body).toBe(200);expect(applied.json().outcome).toBe('published')
      expect((await s.app.inject(req)).json()).toEqual(applied.json())
      s.setMode('shadow');expect((await s.app.inject(req)).statusCode).toBe(503)
    }finally{await s.app.close()}
  })
  test('source-dependent Claim HTTP apply returns committed metadata and retained retry requires current generation',async()=>{
    const s=await setup(['claim','skill'])
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const {proposals}=await s.plan(s.edit(s.bundle.files,v=>{if(v.key?.kind==='claim')v.editable.statement='HTTP revised Skill source'}))
      const p=proposals.find(p=>p.key.kind==='claim')!,detail=(await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})).json()
      s.setActor(s.f.skill.reviewer.grant)
      const review=await s.app.inject({method:'POST',url:`/api/v1/memory/git/proposals/${p.proposalId}/reviews`,headers:{'idempotency-key':'dependent-review'},payload:{...expected(detail),decision:'approve'}})
      expect(review.statusCode,review.body).toBe(200)
      s.setActor(s.f.skill.publisher.grant)
      const request={method:'POST' as const,url:`/api/v1/memory/git/proposals/${p.proposalId}/apply`,headers:{'idempotency-key':'dependent-apply'},payload:expected(detail)}
      const applied=await s.app.inject(request)
      expect(applied.statusCode,applied.body).toBe(200);expect(applied.json().outcome).toBe('published')
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
      expect((await s.app.inject(request)).statusCode).toBe(409)
      const retry=await s.app.inject({...request,headers:{'idempotency-key':'dependent-current-retry'},payload:{...request.payload,expected_generation:'2'}})
      expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual(applied.json())
      expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[p.key.id])).rows[0].n).toBe(2)
      expect((await pool.query('SELECT count(*)::int n FROM memory_skill_publication_heads WHERE skill_id=$1',[s.f.skill.reviewed.skillId])).rows[0].n).toBe(0)
    }finally{await s.app.close()}
  })
  test('eligibility reads do not mint author/revision/evidence or approval and track current reviewer quorum',async()=>{
    const s=await setup()
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const {proposals:[p]}=await s.plan(),url=`/api/v1/memory/git/proposals/${p.proposalId}`
      const independent=await s.f.skill.actor(['reviewer'],['read','review'])
      s.setActor(s.f.skill.publisher.grant)
      const auditsBefore=(await pool.query('SELECT count(*)::int n FROM memory_git_audit_events')).rows[0].n
      const before=(await s.app.inject({url})).json()
      expect(before.capabilities.can_apply).toBe(false);expect(before.gate_reasons).toContain('quorum_required')
      const handlers=new Map<string,(args:any)=>Promise<any>>()
      registerMemoryTools({registerTool:(name:string,_definition:unknown,handler:any)=>handlers.set(name,handler)} as never,{pool,gitOnly:true,
        grant:()=>({...s.f.skill.publisher.grant,version:'v2',installationId:s.f.installationId,services:['memory.mcp'],callerType:'web'}) as never,
        gitReads:createGitReadService({...s.deps,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),scopeMode:async()=> 'enabled',targets:{resolve:async()=>null}}),sharedScopesEnabled:true,recallEmbeddingTimeoutMs:10,cursorSigningKey:'fixture'})
      const mcp=await handlers.get('memory_git_diff')!({proposal_id:p.proposalId})
      expect(mcp.isError).not.toBe(true);expect(JSON.parse(mcp.content[0].text).capabilities.can_apply).toBe(false)
      for(const table of ['memory_git_original_authors','memory_git_governed_revisions','memory_git_revision_evidence'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_audit_events')).rows[0].n).toBe(auditsBefore)
      s.setActor(independent.grant)
      expect((await s.app.inject({method:'POST',url:url+'/reviews',headers:{'idempotency-key':'quorum'},payload:{...expected(before),decision:'approve'}})).statusCode).toBe(200)
      s.setActor(s.f.skill.publisher.grant)
      expect((await s.app.inject({url})).json().capabilities.can_apply).toBe(true)
      await createGitExportService(s.deps).withReadBase(s.f.skill.publisher.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId,exportId:s.bundle.exportId,expectedGeneration:'1'},async context=>{
        const row=await lockImportProposal(context,{installationId:s.f.installationId,connectionId:s.f.connectionId,exportId:s.bundle.exportId,proposalId:p.proposalId,expectedGeneration:'1',expectedRevision:'1'})
        const g=await prepareGovernedImport(context,row,true,'read')
        await requireImportQuorum(context,g,false)
        await expect(assertImportApproval(context.client,g,s.f.skill.publisher.membershipId)).rejects.toThrow('git_governance_required')
      })
      s.setActor(s.originalAuthor.grant)
      expect((await s.app.inject({url})).json().capabilities.can_review).toBe(false)
      await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[independent.membershipId])
      s.setActor(s.f.skill.publisher.grant)
      const expiredResponse=await s.app.inject({url});expect(expiredResponse.statusCode,expiredResponse.body).toBe(404)
      expect(expiredResponse.json()).toEqual({error:{code:'not_found',message:'not_found'}})
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].n).toBe(0)
    }finally{await s.app.close()}
  })
  test('natural expiry of an independent Git-only reviewer removes quorum without invalidating source bodies',async()=>{
    const s=await setup()
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const membershipId=randomUUID()
      const until=(await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,valid_until)
        VALUES($1,$2,ARRAY['reviewer'],clock_timestamp()+interval '3 seconds') RETURNING valid_until`,[s.f.installationId,membershipId])).rows[0].valid_until as Date
      const grant={...s.f.grant,scopeBindings:s.f.grant.scopeBindings.map(b=>({...b,membership_id:membershipId,permissions:['read','review']}))}
      const {proposals:[p]}=await s.plan(),url=`/api/v1/memory/git/proposals/${p.proposalId}`
      s.setActor(grant)
      const detail=(await s.app.inject({url})).json()
      const vote=await s.app.inject({method:'POST',url:url+'/reviews',headers:{'idempotency-key':'temporary-reviewer'},payload:{...expected(detail),decision:'approve'}})
      expect(vote.statusCode,vote.body).toBe(200)
      s.setActor(s.f.skill.publisher.grant)
      expect((await s.app.inject({url})).json().capabilities.can_apply).toBe(true)
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,until.getTime()-Date.now()+50)))
      const expired=await s.app.inject({url})
      expect(expired.statusCode,expired.body).toBe(200)
      expect(expired.json()).toMatchObject({gate_reasons:['quorum_required'],capabilities:{can_apply:false},versions:{git:{editable:{statement:'Governed Git edit'}}}})
    }finally{await s.app.close()}
  })
  test('expired proposal policy closes read capabilities without creating review facts',async()=>{
    const s=await setup()
    try {
      const {proposals:[p]}=await s.plan()
      await pool.query("UPDATE memory_git_import_proposals SET created_at=clock_timestamp()-interval '400 days' WHERE proposal_id=$1",[p.proposalId])
      const response=await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})
      expect(response.statusCode,response.body).toBe(200)
      expect(response.json()).toMatchObject({gate_reasons:['policy_changed'],capabilities:{can_review:false,can_apply:false}})
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_governed_revisions')).rows[0].n).toBe(0)
    }finally{await s.app.close()}
  })
  test('metadata-only linked proposals need no invented author and current Memory changes block stale resolution',async()=>{
    const s=await setup()
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const {proposals:[p]}=await s.plan(s.bundle.files,null)
      s.setActor(s.f.skill.publisher.grant)
      const response=await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})
      expect(response.statusCode,response.body).toBe(200);expect(response.json().capabilities.can_apply).toBe(true)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_original_authors')).rows[0].n).toBe(0)
    }finally{await s.app.close()}
    const second=await setup()
    try {
      const {proposals:[p]}=await second.plan(),d=(await second.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})).json()
      await second.advanceRule()
      const result=await second.app.inject({method:'PUT',url:`/api/v1/memory/git/proposals/${p.proposalId}/resolution`,headers:{'idempotency-key':'stale-memory'},payload:{...expected(d),expected_inputs:d.expected_inputs,resolution:{path:d.versions.memory.path,deleted:false,editable:d.versions.memory.editable}}})
      expect(result.statusCode,result.body).toBe(409)
      expect((await pool.query('SELECT revision::text FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].revision).toBe('1')
    }finally{await second.app.close()}
  })
  test('stored G resolution preserves original raw whitespace digest and clears on purge',async()=>{
    const s=await setup()
    try {
      const files=s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.statement='Git whitespace source'})
        .map(f=>f.path.endsWith('.yaml')&&!f.path.endsWith('/manifest.yaml')?{...f,bytes:Buffer.from(JSON.stringify(JSON.parse(Buffer.from(f.bytes).toString()),null,4)+'\n')}:f)
      const {proposals:[p]}=await s.plan(files),detail=(await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})).json()
      const original=(await pool.query('SELECT proposed_document FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].proposed_document.gitTreeDigest
      const req={method:'PUT' as const,url:`/api/v1/memory/git/proposals/${p.proposalId}/resolution`,headers:{'idempotency-key':'resolve'},payload:{...expected(detail),expected_inputs:detail.expected_inputs,resolution:{path:detail.versions.memory.path,deleted:false,editable:{...detail.versions.memory.editable,statement:'Human resolution'}}}}
      const response=await s.app.inject(req);expect(response.statusCode,response.body).toBe(200)
      expect(response.json()).toMatchObject({revision:'2',review_reset:true})
      expect((await pool.query('SELECT proposed_document FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].proposed_document.gitTreeDigest).toBe(original)
      expect((await s.app.inject(req)).statusCode).toBe(200)
      await pool.query('DELETE FROM knowledge_evidence WHERE version_id=$1',[s.f.rule.versionId])
      const gone=await s.app.inject(req);expect([404,409]).toContain(gone.statusCode);expect(gone.body).not.toContain('Human resolution')
    }finally{await s.app.close()}
  })
  test.each(['memory','custom'])('review exposes actual %s resolution and applies exactly that preview',async choice=>{
    const s=await setup()
    try {
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId]);s.setMode('enabled')
      const {proposals:[p]}=await s.plan(),url=`/api/v1/memory/git/proposals/${p.proposalId}`
      const before=(await s.app.inject({url})).json()
      const statement=choice==='memory'?'Synthetic statement':'Reviewed result distinct from B M and G'
      const resolution={path:before.versions.memory.path,deleted:false,editable:{...before.versions.memory.editable,statement}}
      const resolved=await s.app.inject({method:'PUT',url:url+'/resolution',headers:{'idempotency-key':'visible-result'},payload:{...expected(before),expected_inputs:before.expected_inputs,resolution}})
      expect(resolved.statusCode,resolved.body).toBe(200)
      const preview=resolved.json()
      expect(preview.proposed_result).toMatchObject({path:resolution.path,deleted:false,editable:{statement}})
      expect(preview.versions.git.editable.statement).toBe('Governed Git edit')
      expect(resolved.body).not.toMatch(/serverOnly|credential|grant_facts/)
      const saved=(await pool.query('SELECT proposed_hash,proposed_document FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0]
      expect(preview.proposed_hash).toBe(saved.proposed_hash)
      expect(preview.proposed_result.content_hash).toBe(saved.proposed_document.result.asset.contentHash)
      s.setActor(s.f.skill.reviewer.grant)
      expect((await s.app.inject({method:'POST',url:url+'/reviews',headers:{'idempotency-key':'review-visible-result'},payload:{...expected(preview),decision:'approve'}})).statusCode).toBe(200)
      s.setActor(s.f.skill.publisher.grant)
      const applied=await s.app.inject({method:'POST',url:url+'/apply',headers:{'idempotency-key':'apply-visible-result'},payload:expected(preview)})
      expect(applied.statusCode,applied.body).toBe(200)
      expect((await pool.query('SELECT statement,structured_content FROM knowledge_versions WHERE version_id=$1',[applied.json().versionId])).rows[0]).toEqual({statement,structured_content:preview.proposed_result.editable.structuredContent})
    }finally{await s.app.close()}
  })
  test('automatic merge exposes result distinct from all inputs without replacing original G',async()=>{
    const s=await setup()
    try {
      await s.advanceRule()
      const {proposals:[p]}=await s.plan(),response=await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})
      expect(response.statusCode,response.body).toBe(200)
      expect(response.json().proposed_result).toMatchObject({deleted:false,editable:{statement:'Governed Git edit',structuredContent:{retries:9}}})
      expect(response.json().versions.git.editable.structuredContent.retries).toBe(7)
      expect(response.json().versions.memory.editable.statement).toBe('Synthetic statement')
    }finally{await s.app.close()}
  })
  test('unresolved conflict exposes no invented result to approve',async()=>{
    const s=await setup()
    try {
      await s.advanceRule()
      const files=s.edit(s.bundle.files,v=>{if(v.key?.kind==='rule')v.editable.structuredContent.retries=8})
      const {proposals:[p]}=await s.plan(files),response=await s.app.inject({url:`/api/v1/memory/git/proposals/${p.proposalId}`})
      expect(response.statusCode,response.body).toBe(200)
      expect(response.json()).toMatchObject({proposed_result:null,capabilities:{can_review:false,can_apply:false}})
      expect(response.json().conflicts.length).toBeGreaterThan(0)
    }finally{await s.app.close()}
  })
  test.each(['actor','head'])('stored G cannot resolve or expose a changed canonical run %s',async field=>{
    const s=await setup()
    try {
      const {proposals:[p],runId}=await s.plan(),url=`/api/v1/memory/git/proposals/${p.proposalId}`
      const detail=(await s.app.inject({url})).json()
      if(field==='actor')await pool.query("UPDATE memory_git_runs SET provider_actor_id='different-actor' WHERE run_id=$1",[runId])
      else await pool.query('UPDATE memory_git_runs SET merge_commit=$2 WHERE run_id=$1',[runId,'d'.repeat(40)])
      const response=await s.app.inject({method:'PUT',url:url+'/resolution',headers:{'idempotency-key':'changed-run'},payload:{...expected(detail),expected_inputs:detail.expected_inputs,resolution:{path:detail.versions.memory.path,deleted:false,editable:detail.versions.memory.editable}}})
      expect(response.statusCode,response.body).toBe(409)
      expect((await pool.query('SELECT revision::text FROM memory_git_import_proposals WHERE proposal_id=$1',[p.proposalId])).rows[0].revision).toBe('1')
      const read=await s.app.inject({url});expect(read.statusCode,read.body).toBe(409)
      expect(read.json()).toEqual({error:{code:'source_invalid',message:'source_invalid'}})
    }finally{await s.app.close()}
  })
  test('webhook verifies original bytes and current server-enrolled export before ACK',async()=>{
    const s=await setup()
    try {
      const sync=await s.app.inject({method:'POST',url:`/api/v1/memory/git/connections/${s.f.connectionId}/sync`,headers:{'idempotency-key':'enroll'},payload:{expected_generation:'1',export_id:s.bundle.exportId,action:'enroll'}})
      expect(sync.statusCode,sync.body).toBe(200)
      const payload=JSON.stringify({repository:{id:123},pull_request:{number:42,base:{ref:'main',repo:{id:123}},head:{ref:`pocketctl/export/${s.bundle.exportId}`}}},null,2)
      const req={method:'POST' as const,url:`/api/v1/memory/git/connections/${s.f.connectionId}/webhook`,headers:{'content-type':'application/json','x-github-event':'pull_request','x-github-delivery':'event-1','x-hub-signature-256':'sha256='+createHmac('sha256','synthetic-secret').update(payload).digest('hex')},payload}
      const accepted=await s.app.inject(req);expect(accepted.statusCode,accepted.body).toBe(202)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_inbox')).rows[0].n).toBe(1)
      expect((await s.app.inject({...req,payload:JSON.stringify(JSON.parse(payload))})).statusCode).toBe(400)
      await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[s.f.membershipId])
      expect((await s.app.inject({...req,headers:{...req.headers,'x-github-delivery':'event-2'}})).statusCode).toBe(400)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_run_receipts')).rows[0].n).toBe(1)
    }finally{await s.app.close()}
  })
  test('runtime webhook registration resolves fixed target and secret independently from read consent',async()=>{
    const s=await gitImportFixture(pool),paths:string[]=[]
    const target={installationId:s.f.installationId,repositoryId:s.f.repositoryId,targetId:'fixture-target',credentialRef:'server-only-secret-ref',credentialFile:'/fixture/token',webhookSecretFile:'/fixture/webhook',provider:'github',providerRepositoryId:'123',owner:'fixture',repository:'knowledge',branch:'main',private:true,scopeMode:'shadow'}
    const runtime=await createGitRuntime({pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'shadow'}),globalMode:'enabled',sharedMode:'shadow',env:{MEMORY_GIT_TARGET_REGISTRY_PATH:'/fixture/registry'},readFile:async path=>{paths.push(path);return Buffer.from(path==='/fixture/registry'?JSON.stringify({targets:[target]}):'synthetic-webhook-secret')}})
    expect(runtime.webhookRegistration).toBeTypeOf('function')
    expect(await runtime.webhookRegistration(s.f.connectionId)).toMatchObject({installationId:s.f.installationId,provider:'github',providerRepositoryId:'123',targetBranch:'main',secret:'synthetic-webhook-secret'})
    expect(paths).not.toContain('/fixture/token')
    expect(await runtime.reads!.resolve(await createGitReadServiceForTest(s))).toBeNull()
    await pool.query("UPDATE memory_git_connections SET target_id='different' WHERE connection_id=$1",[s.f.connectionId])
    expect(await runtime.webhookRegistration(s.f.connectionId)).toBeNull()
  })
  async function createGitReadServiceForTest(s:Awaited<ReturnType<typeof gitImportFixture>>) {
    const {createGitRepository}=await import('../git-sync/repository.js')
    return (await createGitRepository({pool,targets:{resolve:async()=>null}}).getConnection(s.f.grant,{installationId:s.f.installationId,connectionId:s.f.connectionId}))!
  }
})
