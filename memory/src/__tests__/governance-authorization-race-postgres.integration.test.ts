import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {createTransferService} from '../governance/transfer-service.js'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { governanceFixture } from '../testing/governance-fixture.js'
import { createPublicationService } from '../governance/publication-service.js'
import { createPromotionService } from '../governance/promotion-service.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const suite = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('governance commit-point authorization', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 6 }); await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool) }, 60000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations CASCADE') })
  test('transfer rejects a revoked secondary Organization administrator',async()=>{
    const f=await governanceFixture(pool),org=randomUUID(),member=randomUUID()
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
    await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
    await pool.query("UPDATE memory_owner_scopes SET state='dissolving',parent_organization_id=$2 WHERE installation_id=$1",[f.team,org])
    await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'revoked',2)",[org,member])
    const grant=f.grant(f.publisher,['read','scope_admin'])
    grant.scopeBindings.push({installation_id:org,owner_scope_kind:'organization',owner_scope_id:org,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','scope_admin']})
    await expect(createTransferService(pool).startTeamTransfer({grant,sourceInstallationId:f.team,targetInstallationId:org,expectedAuthorizationEpoch:1})).rejects.toMatchObject({code:'forbidden'})
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_transfer_runs')).rows[0].n).toBe(0)
  })
  test('an expired verified grant cannot publish even when mirror membership is active', async () => {
    const f = await governanceFixture(pool), proposal = await f.approved()
    const grant = Object.assign(f.grant(f.publisher, ['read', 'review', 'publish']), { expiresAt: 1 })
    await expect(createPublicationService(pool).publish({ grant, targetInstallationId: f.team,
      candidateId: proposal.candidate.candidate_id, expectedCandidateRevision: 1, resolution: 'new' })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
  })
  test('a revoked proposer cannot create a proposal using the previously validated grant', async () => {
    const f = await governanceFixture(pool)
    await pool.query("UPDATE memory_scope_memberships SET state='revoked',membership_revision=membership_revision+1 WHERE membership_id=$1", [f.proposer])
    await expect(createPromotionService(pool).propose(f.proposeInput)).rejects.toMatchObject({ code: 'forbidden_direction' })
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidates')).rows[0].n).toBe(0)
  })
  test('revoked source installation cannot be copied into a new shared proposal', async () => {
    const f = await governanceFixture(pool)
    await pool.query("UPDATE memory_installations SET relay_status='revoking' WHERE installation_id=$1", [f.personal])
    await expect(createPromotionService(pool).propose(f.proposeInput)).rejects.toMatchObject({ code: 'not_found' })
  })
  test('expiry while blocked on candidate rolls back the eventual publication', async () => {
    const f = await governanceFixture(pool), proposal = await f.approved()
    const locker = await pool.connect()
    let started!: () => void
    const queryStarted = new Promise<void>(resolve => { started = resolve })
    const hookedPool = { connect: async () => {
      const client = await pool.connect()
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('FROM memory_promotion_candidates') && args[0].includes('FOR UPDATE')) started()
          return Reflect.apply(target.query, target, args)
        }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as unknown as pg.Pool
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT candidate_id FROM memory_promotion_candidates WHERE candidate_id=$1 FOR UPDATE', [proposal.candidate.candidate_id])
      const expiresAt = Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now) + 1
      const grant = Object.assign(f.grant(f.publisher, ['read', 'review', 'publish']), { expiresAt })
      pending = createPublicationService(hookedPool).publish({ grant, targetInstallationId: f.team,
        candidateId: proposal.candidate.candidate_id, expectedCandidateRevision: 1, resolution: 'new' })
      // Attach rejection handling immediately; the barrier determines the interleave.
      const outcome = pending.then(value => ({ value }), error => ({ error }))
      await queryStarted
      await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)', [expiresAt + 0.01])
      await locker.query('COMMIT')
      expect(await outcome).toMatchObject({ error: { code: 'forbidden' } })
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending?.catch(() => undefined) }
  })
})

import Fastify from 'fastify'
import { registerGovernanceRoutes } from '../api/governance-routes.js'
import { createReviewPolicyRepository, DEFAULT_TEAM_REVIEW_POLICY } from '../governance/review-policy.js'

suite('HTTP governance authorization and idempotent replay', () => {
  let pool: pg.Pool
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url, max: 6 }); await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool) }, 60000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations CASCADE') })
  function appFor(grant: ReturnType<Awaited<ReturnType<typeof governanceFixture>>['grant']>, dbPool = pool) {
    const app = Fastify()
    registerGovernanceRoutes(app, { pool: dbPool, guard: { guardV2: async () => ({...grant,version:'v2',installationId:grant.primaryInstallationId,services:['memory.search'],callerType:'web'}),guardV2Disposition:async()=>({...grant,version:'v2',installationId:grant.primaryInstallationId,services:['memory.manage'],callerType:'web'}) } as never,
      sharedScopesEnabled: true, cursorSigningKey: 'transaction-fixture-key' })
    return app
  }
  test('proposal replay uses the owned connection in a single-connection pool', async () => {
    const f=await governanceFixture(pool), single=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:500}), app=appFor(f.proposeInput.grant,single)
    const request={method:'POST' as const,url:'/api/v1/memory/governance/proposals',headers:{'idempotency-key':'single-replay'},
      payload:{target_installation_id:f.team,expected_revision:1,source_installation_id:f.personal,source_claim_id:f.claim,evidence_ids:[f.evidence]}}
    try {
      const first=await app.inject(request); expect(first.statusCode).toBe(201)
      const replay=await app.inject(request); expect(replay.statusCode).toBe(201)
      expect(replay.json().candidate_revision.candidate_revision_id).toBe(first.json().candidate_revision.candidate_revision_id)
    } finally {await app.close();await single.end()}
  })
  test('proposal retry returns its original immutable revision after an edit',async()=>{
    const f=await governanceFixture(pool),app=appFor(f.proposeInput.grant)
    const request={method:'POST' as const,url:'/api/v1/memory/governance/proposals',headers:{'idempotency-key':'exact-revision'},
      payload:{target_installation_id:f.team,expected_revision:1,source_installation_id:f.personal,source_claim_id:f.claim,evidence_ids:[f.evidence]}}
    try{
      const original=(await app.inject(request)).json()
      const edited=await app.inject({method:'POST',url:`/api/v1/memory/governance/proposals/${original.candidate.candidate_id}/revise`,headers:{'idempotency-key':'exact-revision-edit'},
        payload:{target_installation_id:f.team,expected_revision:1,statement:'The newer revision body',structured_content:{changed:true},evidence_selection:{retained_ordinals:[1],removed_ordinals:[],new_evidence_ids:[]}}})
      expect(edited.statusCode).toBe(200)
      const replay=await app.inject(request)
      expect(replay.statusCode).toBe(201)
      expect(replay.json().candidate_revision.candidate_revision_id).toBe(original.candidate_revision.candidate_revision_id)
      expect(replay.json().candidate_revision.statement).toBe('Transactional fixture invariant')
    }finally{await app.close()}
  })
  test('a transfer replay cannot target a dissolving primary Organization',async()=>{
    const f=await governanceFixture(pool),org=randomUUID(),member=randomUUID()
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
    await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
    await pool.query("UPDATE memory_owner_scopes SET state='dissolving',parent_organization_id=$2 WHERE installation_id=$1",[f.team,org])
    await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'active',1)",[org,member])
    const grant=f.grant(f.publisher,['read','scope_admin']);grant.primaryInstallationId=org
    grant.scopeBindings.push({installation_id:org,owner_scope_kind:'organization',owner_scope_id:org,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','scope_admin']})
    const app=appFor(grant),request={method:'POST' as const,url:'/api/v1/memory/governance/transfers',headers:{'idempotency-key':'transfer-replay'},payload:{source_installation_id:f.team,target_installation_id:org,expected_revision:1}}
    try{
      expect((await app.inject(request)).statusCode).toBe(200)
      await pool.query("UPDATE memory_owner_scopes SET state='dissolving' WHERE installation_id=$1",[org])
      expect((await app.inject(request)).statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_transfer_runs')).rows[0].n).toBe(1)
    }finally{await app.close()}
  })
  test('revoked contribution cannot replay a previous proposal body', async () => {
    const f = await governanceFixture(pool), app = appFor(f.proposeInput.grant)
    const request = { method:'POST' as const,url:'/api/v1/memory/governance/proposals',headers:{authorization:'Bearer signed-before-revoke','idempotency-key':'proposal-replay'},
      payload:{target_installation_id:f.team,expected_revision:1,source_installation_id:f.personal,source_claim_id:f.claim,evidence_ids:[f.evidence]} }
    try {
      expect((await app.inject(request)).statusCode).toBe(201)
      await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1", [f.proposer])
      const response = await app.inject(request)
      expect(response.statusCode).toBe(403)
      expect(response.body).not.toContain('Transactional fixture invariant')
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidates')).rows[0].n).toBe(1)
    } finally { await app.close() }
  })
  test('disappeared target cannot turn an authorization denial into a failed audit response',async()=>{
    const f=await governanceFixture(pool),proposal=await f.proposed(),app=appFor(f.grant(f.publisher,['read','review','publish']))
    try{
      await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[f.team])
      const response=await app.inject({method:'POST',url:`/api/v1/memory/governance/proposals/${proposal.candidate.candidate_id}/publish`,headers:{'idempotency-key':'removed-target'},payload:{target_installation_id:f.team,expected_revision:1,resolution:'new'}})
      expect(response.statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
    }finally{await app.close()}
  })
  test('stale policy administrator cannot append a policy version', async () => {
    const f = await governanceFixture(pool); await f.proposed()
    const grant = f.grant(f.publisher,['read','review','publish','policy_admin','scope_admin'])
    const app = appFor(grant), head = await createReviewPolicyRepository(pool).getHead(f.team)
    try {
      await pool.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1", [f.publisher])
      const response=await app.inject({method:'PATCH',url:'/api/v1/memory/governance/review-policy',headers:{authorization:'Bearer signed-before-revoke','idempotency-key':'policy-stale'},
        payload:{target_installation_id:f.team,expected_revision:head!.revision,document:DEFAULT_TEAM_REVIEW_POLICY}})
      expect(response.statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_review_policy_versions')).rows[0].n).toBe(1)
    } finally { await app.close() }
  })
  test('stale proposal author cannot edit after losing contribution authority', async () => {
    const f=await governanceFixture(pool), proposal=await f.proposed(), app=appFor(f.proposeInput.grant)
    try {
      await pool.query("UPDATE memory_scope_memberships SET roles=ARRAY['reader'],membership_revision=membership_revision+1 WHERE membership_id=$1",[f.proposer])
      const response=await app.inject({method:'POST',url:`/api/v1/memory/governance/proposals/${proposal.candidate.candidate_id}/revise`,headers:{authorization:'Bearer signed-before-revoke','idempotency-key':'revise-stale'},
        payload:{target_installation_id:f.team,expected_revision:1,statement:'Unauthorized edited statement',structured_content:{},evidence_selection:{retained_ordinals:[1],removed_ordinals:[],new_evidence_ids:[]}}})
      expect(response.statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
    } finally { await app.close() }
  })
})

import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
suite('personal management commit-point authority', () => {
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
  afterAll(async()=>{await pool?.end()})
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  function appFor(installationId:string,expiresAt?:number,dbPool=pool) {
    const app=Fastify()
    registerManageRoutes(app,{pool:dbPool,guard:{guard:async()=>({installationId,configVersion:'1',expiresAt})} as never,
      policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[]})
    return app
  }
  test.each(['correct','accept'])('%s waits for session before taking installation, allowing the worker to finish',async(operation)=>{
    const f=await governanceFixture(pool)
    const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
    let candidateId:string|undefined
    if(operation==='accept'){
      await pool.query("UPDATE work_episodes SET source_digest='x'::bytea,document=$2::jsonb,evidence_manifest=$3::jsonb WHERE episode_id=$1",[episode,JSON.stringify({final_outcome:{text:'Acceptable invariant',evidence_handle:'h0-aaaaaaaa'}}),JSON.stringify({'h0-aaaaaaaa':{kind:'episode'}})])
      const run=(await pool.query(`INSERT INTO memory_extraction_runs(run_id,installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,input_digest,mode,state,provider,model)
        VALUES(gen_random_uuid(),$1,$2,'x'::bytea,'test','test','x'::bytea,'x'::bytea,'enabled','succeeded','fixture','fixture') RETURNING run_id`,[f.personal,episode])).rows[0].run_id
      candidateId=(await pool.query(`INSERT INTO memory_candidates(candidate_id,installation_id,run_id,episode_id,ordinal,claim_type,statement,structured_content,normalized_key,scope_kind,scope_key,confidence,freshness_at,evidence_handles,status)
        VALUES(gen_random_uuid(),$1,$2,$3,0,'test_invariant','Acceptable invariant','{}'::jsonb,'acceptable','installation','global',0.9,NOW(),'["h0-aaaaaaaa"]'::jsonb,'validated') RETURNING candidate_id`,[f.personal,run,episode])).rows[0].candidate_id
    }
    let signal!:()=>void;const started=new Promise<void>(resolve=>{signal=resolve})
    const hooked={connect:async()=>{
      const client=await pool.connect()
      return new Proxy(client,{get(target,key){if(key==='query')return (...args:unknown[])=>{
        const pending=Reflect.apply(target.query,target,args)
        if(typeof args[0]==='string'&&args[0].includes('pg_advisory_xact_lock')){
          if(args[0].includes('purge:session:'))signal()
          else void Promise.resolve(pending).then(()=>signal())
        }
        return pending
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
    }} as unknown as pg.Pool
    const app=appFor(f.personal,undefined,hooked),locker=await pool.connect()
    let pending:Promise<{statusCode:number}>|undefined
    try{
      await locker.query('BEGIN')
      await locker.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':transaction-fixture',0))",[f.personal])
      pending=app.inject({method:'POST',url:operation==='accept'?`/api/v1/memory/candidates/${candidateId}/accept`:`/api/v1/memory/claims/${f.claim}/correct`,headers:{'idempotency-key':'lock-order'},payload:operation==='accept'?{expected_revision:1}:{expected_revision:1,statement:'Corrected invariant',evidence:[{evidence_kind:'episode',episode_id:episode,excerpt:'Corrected invariant is supported',occurred_at:new Date().toISOString()}]}})
      await started
      const worker=(await locker.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS acquired",[f.personal])).rows[0]
      expect(worker.acquired).toBe(true)
      await locker.query('COMMIT')
      expect((await pending!).statusCode).toBe(200)
    }finally{await locker.query('ROLLBACK');locker.release();await pending;await app.close()}
  })
  test.each(['revoking','revoked'])('rejects a cached management grant for %s installation',async(status)=>{
    const f=await governanceFixture(pool),app=appFor(f.personal)
    try {
      await pool.query('UPDATE memory_installations SET relay_status=$2 WHERE installation_id=$1',[f.personal,status])
      const res=await app.inject({method:'POST',url:'/api/v1/memory/feedback',headers:{'idempotency-key':'revoked-feedback'},payload:{action:'recall_used'}})
      expect(res.statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_feedback')).rows[0].n).toBe(0)
    }finally{await app.close()}
  })
  test('rejects expired management grant on fresh mutation and replay',async()=>{
    const f=await governanceFixture(pool),valid=appFor(f.personal),expired=appFor(f.personal,1)
    const request={method:'POST' as const,url:'/api/v1/memory/feedback',headers:{'idempotency-key':'feedback-clock'},payload:{action:'recall_used'}}
    try {
      expect((await valid.inject(request)).statusCode).toBe(200)
      expect((await expired.inject(request)).statusCode).toBe(403)
      expect((await expired.inject({...request,headers:{'idempotency-key':'feedback-expired'}})).statusCode).toBe(403)
      expect((await pool.query('SELECT count(*)::int AS n FROM memory_feedback')).rows[0].n).toBe(1)
    }finally{await valid.close();await expired.close()}
  })
})
