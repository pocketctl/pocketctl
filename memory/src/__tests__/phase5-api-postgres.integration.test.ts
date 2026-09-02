import { randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import pg from 'pg'
import { beforeAll,beforeEach,afterAll,describe,test,expect } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { loadSkillConfig } from '../skills/config.js'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import { createSkillWorker } from '../skills/worker.js'
import { createSkillGenerator } from '../skills/generator.js'
import { createJobRepository } from '../jobs/repository.js'
import { skillFixtureDocument } from '../testing/skill-fixture.js'
import { createSkillGovernanceFixture } from '../testing/skill-fixture.js'
import { createSkillReviewService } from '../skills/review-service.js'
import { createSkillReadService } from '../skills/read-service.js'
import { registerSkillRoutes } from '../api/skill-routes.js'
import { createFileSkillCaseRegistry } from '../skills/case-registry.js'
import { replayTextHash } from '../skills/replay-runner.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
suite('Phase5 authenticated HTTP reads and governance',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>pool?.end())
  const fixture=(kind:'personal'|'team'='personal')=>createSkillGovernanceFixture(pool,context,kind)
  async function appFor(actor:{installationId:string;grant:any},mode:'off'|'shadow'='shadow',registry?:ReturnType<typeof createFileSkillCaseRegistry>,globalMode:'enabled'|'shadow'='enabled') {
    const app=Fastify()
    const grant={...actor.grant,version:'v2',installationId:actor.installationId,services:['memory.search','memory.manage'],callerType:'web'}
    registerSkillRoutes(app,{pool,guard:{guardMcp:async()=>grant} as never,policy:createCorsHostPolicy({allowedOrigins:['https://web.example'],allowedHosts:['localhost'],isProduction:false}),context:{...context,globalMode,config:{...context.config,mode}},cursorSigningKey:'test-cursor-key',cases:registry})
    await app.ready();return app
  }
  const draft=async(f:Awaited<ReturnType<typeof fixture>>)=>createSkillReviewService({pool,context}).execute(f.author,{action:'draft',candidateId:f.candidateId,expectedRevision:0})
  test.each(['enabled','shadow'] as const)('browser policy save succeeds with global mode %s',async globalMode=>{
    const f=await fixture(),admin=await f.actor([],['read','policy_admin']),app=await appFor(admin,'shadow',undefined,globalMode)
    try {
      const origin='https://web.example',url='/api/v1/memory/skills/policy'
      const preflight=await app.inject({method:'OPTIONS',url,headers:{origin,'access-control-request-method':'PUT','access-control-request-headers':'authorization, content-type'}})
      expect(preflight.statusCode).toBe(200)
      expect(preflight.headers['access-control-allow-methods']?.split(/,\s*/)).toContain('PUT')
      const response=await app.inject({method:'PUT',url,headers:{origin,authorization:'Bearer fixture'},payload:{expected_revision:0,policy:{minimum_independent_successes:3,auto_mode:'off',canary_mode:'off'}}})
      expect(response.statusCode,response.body).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe(origin)
      expect(response.json()).toMatchObject({revision:1,policy:{minimum_independent_successes:3}})
      expect((await app.inject({url,headers:{origin,authorization:'Bearer fixture'}})).json()).toMatchObject({revision:1,policy:{minimum_independent_successes:3}})
    } finally {await app.close()}
  })
  test('candidate list, strict draft/review/edit, immutable diff and safe detail',async()=>{
    const f=await fixture(),app=await appFor(f.author)
    try {
      const candidates=await app.inject({url:'/api/v1/memory/skills/candidates'})
      expect(candidates.statusCode).toBe(200);expect(candidates.json().items[0]).toMatchObject({candidate_id:f.candidateId,can_draft:true,expected_revision:0})
      const injected=await app.inject({method:'POST',url:`/api/v1/memory/skills/candidates/${f.candidateId}/draft`,payload:{expected_revision:0,actor_id:randomUUID()}})
      expect(injected.statusCode).toBe(400)
      const created=await app.inject({method:'POST',url:`/api/v1/memory/skills/candidates/${f.candidateId}/draft`,payload:{expected_revision:0}})
      expect(created.statusCode).toBe(200);const d=created.json()
      const detail=await app.inject({url:`/api/v1/memory/skills/${d.skill_id}`})
      expect(detail.statusCode,detail.body).toBe(200);expect(detail.json().permissions.can_publish).toBe(false);expect(detail.body).not.toContain('scope_bindings')
      const invalidOutcome=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skill_id}/review`,payload:{expected_revision:1,decision:'reject',review_outcome:'light_edit'}})
      expect(invalidOutcome.statusCode).toBe(400)
      const reviewed=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skill_id}/review`,payload:{expected_revision:1,decision:'approve',review_outcome:'light_edit'}})
      expect(reviewed.statusCode,reviewed.body).toBe(200)
      expect((await pool.query(`SELECT review_outcome FROM memory_skill_review_decisions WHERE skill_id=$1`,[d.skill_id])).rows).toEqual([{review_outcome:'light_edit'}])
      const document={...detail.json().document,title:'Updated method'}
      const edited=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skill_id}/edit`,payload:{expected_revision:2,document}})
      expect(edited.statusCode,edited.body).toBe(200)
      const diff=await app.inject({url:`/api/v1/memory/skills/${d.skill_id}/diff?from_version_id=${d.version_id}&to_version_id=${edited.json().version_id}`})
      expect(diff.json().changes).toEqual([{field:'title',before:'Find the failing test',after:'Updated method'}])
      const stale=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skill_id}/review`,payload:{expected_revision:1,decision:'approve'}})
      expect(stale.statusCode).toBe(409)
    } finally {await app.close()}
  })
  test('reader sees detail but mutations fail, revoked membership blocks reads',async()=>{
    const f=await fixture('team'),d=await draft(f),reader=await f.actor(['reader'],['read']),app=await appFor(reader)
    try {
      const response=await app.inject({url:`/api/v1/memory/skills/${d.skillId}`});expect(response.statusCode,response.body).toBe(200)
      expect(response.json().permissions.can_edit).toBe(false)
      expect((await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skillId}/review`,payload:{expected_revision:1,decision:'approve'}})).statusCode).toBe(403)
      await pool.query(`UPDATE memory_scope_memberships SET state='revoked',membership_revision=membership_revision+1 WHERE membership_id=$1`,[reader.membershipId])
      expect((await app.inject({url:`/api/v1/memory/skills/${d.skillId}`})).statusCode).toBe(403)
    } finally {await app.close()}
  })
  test('bounded signed cursor binds tenant/filter and foreign IDs are 404',async()=>{
    const f=await fixture(),d=await draft(f),other=await fixture(),app=await appFor(f.author),foreign=await appFor(other.author)
    try {
      const second=await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:'second-method',source:{kind:'episode',episodeId:f.episodeId}})
      const job=(await createJobRepository(pool).claimJobs({workerId:'api-fixture',limit:1,leaseMs:30000}))[0]!
      const generator=createSkillGenerator({provider:{generateJson:async()=>({ok:true,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}})} as never,timeoutMs:100})
      await createSkillWorker({pool,context,generator}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'api-fixture',claimEpoch:job.claim_epoch}})
      const candidate=(await pool.query('SELECT candidate_id FROM memory_skill_candidates WHERE task_id=$1',[second.taskId])).rows[0].candidate_id
      await createSkillReviewService({pool,context}).execute(f.author,{action:'draft',candidateId:candidate,expectedRevision:0})
      const page=(await app.inject({url:'/api/v1/memory/skills?limit=1'})).json()
      expect(page.items).toHaveLength(1);expect(page.next_cursor).toBeTypeOf('string')
      const cursor=encodeURIComponent(page.next_cursor)
      expect((await app.inject({url:`/api/v1/memory/skills?limit=1&cursor=${cursor}`})).json().items).toHaveLength(1)
      expect((await foreign.inject({url:`/api/v1/memory/skills?limit=1&cursor=${cursor}`})).statusCode).toBe(400)
      expect((await app.inject({url:`/api/v1/memory/skills?state=draft&cursor=${cursor}`})).statusCode).toBe(400)
      const reads=createSkillReadService({pool,context,cursorSigningKey:'test-cursor-key'})
      expect((await app.inject({url:'/api/v1/memory/skills?limit=51'})).statusCode).toBe(400)
      expect((await app.inject({url:'/api/v1/memory/skills?cursor=forged'})).statusCode).toBe(400)
      expect((await foreign.inject({url:`/api/v1/memory/skills/${d.skillId}`})).statusCode).toBe(404)
      expect((await reads.list(f.author,{})).items).toHaveLength(2)
      expect((await app.inject({url:'/api/v1/memory/skills/not-a-uuid'})).statusCode).toBe(400)
    } finally {await app.close();await foreign.close()}
  })
  test('resolve preview requires reviewed head and leaves ledger unchanged',async()=>{
    const f=await fixture(),d=await draft(f),reads=createSkillReadService({pool,context,cursorSigningKey:'key'})
    await expect(reads.resolve(f.author,d.skillId)).rejects.toMatchObject({code:'not_found'})
    await createSkillReviewService({pool,context}).execute(f.author,{action:'approve',skillId:d.skillId,expectedRevision:1})
    const before=await pool.query('SELECT count(*) FROM memory_skill_audit_events')
    expect(await reads.resolve(f.author,d.skillId)).toMatchObject({state:'reviewed',eligible:false,execution_allowed:false})
    expect((await pool.query('SELECT count(*) FROM memory_skill_audit_events')).rows).toEqual(before.rows)
    expect(Number((await pool.query('SELECT count(*) FROM memory_skill_executions')).rows[0].count)).toBe(0)
  })
  test.each(['list','candidates','diff'] as const)('%s locks all source Sessions before repositories during concurrent reads',async operation=>{
    const f=await fixture(),first=await draft(f)
    const sessionB=randomUUID(),episodeB=randomUUID()
    await pool.query(`INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at)VALUES($1,$2,NOW(),NOW())`,[f.installationId,sessionB])
    await pool.query(`INSERT INTO work_episodes SELECT (jsonb_populate_record(NULL::work_episodes,to_jsonb(e)||jsonb_build_object('episode_id',$2::text,'session_id',$3::text,'turn_id',$2::text))).* FROM work_episodes e WHERE e.episode_id=$1`,[f.episodeId,episodeB,sessionB])
    async function add(sourceEpisode:string,key:string,expectedRevision=0) {
      const task=await createSkillAdmissionService({pool,context}).schedule({...f.author,candidateKey:key,source:{kind:'episode',episodeId:sourceEpisode}})
      const job=(await createJobRepository(pool).claimJobs({workerId:'lock-order-fixture',limit:1,leaseMs:30000}))[0]!
      const generator=createSkillGenerator({provider:{generateJson:async()=>({ok:true,value:skillFixtureDocument(),usage:{inputTokens:1,outputTokens:1,model:'fixture'}})} as never,timeoutMs:100})
      await createSkillWorker({pool,context,generator}).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'lock-order-fixture',claimEpoch:job.claim_epoch}})
      const candidateId=(await pool.query('SELECT candidate_id FROM memory_skill_candidates WHERE task_id=$1 AND generation=$2',[task.taskId,task.generation])).rows[0].candidate_id as string
      return {...await createSkillReviewService({pool,context}).execute(f.author,{action:'draft',candidateId,expectedRevision}),candidateId}
    }
    const second=await add(operation==='diff'?f.episodeId:episodeB,'second-method')
    const latest=operation==='diff'?await add(episodeB,'method',first.revision):first
    const sorted=operation==='candidates'
      ?[{skillId:first.skillId,id:f.candidateId},{skillId:second.skillId,id:second.candidateId}].sort((a,b)=>a.id.localeCompare(b.id))
      :[{skillId:first.skillId,id:first.skillId},{skillId:second.skillId,id:second.skillId}].sort((a,b)=>a.id.localeCompare(b.id))
    const probeSkill=operation==='diff'?second.skillId:sorted[1]!.skillId
    let reached!:()=>void,resume!:()=>void,probeConnected!:(pid:number)=>void
    const reachedRepo=new Promise<void>(resolve=>{reached=resolve}),releaseRepo=new Promise<void>(resolve=>{resume=resolve})
    const probePid=new Promise<number>(resolve=>{probeConnected=resolve})
    function observedPool(pause:boolean):pg.Pool {return {query:pool.query.bind(pool),connect:async()=>{
      const client=await pool.connect(),pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      if(!pause)probeConnected(pid)
      let paused=false
      return new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{
        const result=await (target.query as any)(...args)
        if(pause&&!paused&&String(args[0]).includes('purge:repository:')){paused=true;reached();await releaseRepo}
        return result
      };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
    }} as unknown as pg.Pool}
    const batch=createSkillReadService({pool:observedPool(true),context,cursorSigningKey:'locks'})
    const probe=createSkillReadService({pool:observedPool(false),context,cursorSigningKey:'locks'})
    const firstRead=(operation==='diff'?batch.diff(f.author,first.skillId,first.versionId,latest.versionId):batch.list(f.author,{},operation==='candidates'))
      .then(value=>({ok:true,value}),error=>({ok:false,error}))
    await reachedRepo
    const otherRead=probe.get(f.author,probeSkill).then(value=>({ok:true,value}),error=>({ok:false,error}))
    try {
      const pid=await probePid
      // Old order: probe owns Session B and waits for repo; fixed order: it waits for prelocked Session B.
      // Both schedules are established by PostgreSQL itself, not by a timing sleep.
      await expect.poll(async()=>Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`,[pid])).rowCount),{timeout:3000,interval:10}).toBe(true)
    } finally {resume()}
    const outcomes=await Promise.all([firstRead,otherRead])
    expect(outcomes.map(result=>result.ok),JSON.stringify(outcomes)).toEqual([true,true])
  },15000)
  test('off mode rejects all access without returning an empty success',async()=>{
    const f=await fixture(),app=await appFor(f.author,'off')
    try{const response=await app.inject({url:'/api/v1/memory/skills'});expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe('feature_disabled')}finally{await app.close()}
  })
  test('current source digest invalidation hides skill documents',async()=>{
    const f=await fixture(),d=await draft(f),app=await appFor(f.author)
    try{await pool.query(`UPDATE work_episodes SET source_digest=decode($2,'hex') WHERE episode_id=$1`,[f.episodeId,'b'.repeat(64)])
      expect((await app.inject({url:`/api/v1/memory/skills/${d.skillId}`})).statusCode).toBe(404)
      expect((await app.inject({url:'/api/v1/memory/skills'})).json().items).toEqual([])
    }finally{await app.close()}
  })
  test('offline replay selects trusted file cases; HTTP cannot submit responses or open publication gate',async()=>{
    const f=await fixture(),d=await draft(f),reads=createSkillReadService({pool,context,cursorSigningKey:'key'}),detail=await reads.get(f.author,d.skillId)
    const dir=await mkdtemp(join(tmpdir(),'skill-registry-')),path=join(dir,'recordings.json')
    const recorded=(kind:'historical_session'|'golden_task')=>({schema_version:'skill-replay-case.v1',case_id:kind,kind,provenance:'fixture',installation_id:f.installationId,repository_id:f.repositoryId,repo_snapshot_id:f.snapshotId,version_id:d.versionId,policy_hash:detail.policy_hash,document_hash:detail.document_hash,reference_id:kind==='historical_session'?f.sessionId:'golden-method',
      steps:detail.document.steps.map((s,i)=>({step_index:i,tool:s.tool,operation:s.operation,instruction_hash:replayTextHash(s.instruction),response:{ok:true}})),
      assertions:detail.document.validation.map((v,i)=>({assertion_id:`a${i}`,validation_index:i,validation_hash:replayTextHash(v),step_index:0,path:['ok'],operator:'equals',expected:true}))})
    await writeFile(path,JSON.stringify({schema_version:'skill-replay-registry.v1',cases:[recorded('historical_session'),recorded('golden_task')]}),{mode:0o600})
    const app=await appFor(f.author,'shadow',createFileSkillCaseRegistry(path))
    try {
      expect((await app.inject({url:`/api/v1/memory/skills/${d.skillId}/replay-cases`})).json().items).toHaveLength(2)
      const payload={version_id:d.versionId,expected_revision:1,case_ids:['historical_session','golden_task'],idempotency_key:'api-replay'}
      expect((await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skillId}/replay`,payload:{...payload,responses:[]}})).statusCode).toBe(400)
      const result=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skillId}/replay`,payload})
      expect(result.statusCode,result.body).toBe(200);expect(result.json()).toMatchObject({state:'passed',natural_execution_count:0,eligible:true})
      const forged=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skillId}/publish`,payload:{version_id:d.versionId,expected_revision:1,expected_publication_revision:0,mode:'manual',fixture_publication:true}})
      expect(forged.statusCode).toBe(400)
      const current=await app.inject({url:`/api/v1/memory/skills/${d.skillId}/replay`});expect(current.json().eligible).toBe(true)
      await writeFile(path,JSON.stringify({schema_version:'skill-replay-registry.v1',cases:[]}),{mode:0o600})
      const withdrawn=await app.inject({url:`/api/v1/memory/skills/${d.skillId}/replay`});expect(withdrawn.json()).toMatchObject({eligible:false,error_code:'evidence_stale'})
      const blocked=await app.inject({method:'POST',url:`/api/v1/memory/skills/${d.skillId}/executions`,payload:{version_id:d.versionId,expected_publication_revision:1,session_id:f.sessionId,idempotency_key:'must-not-run'}})
      expect(blocked.json().error.code).toBe('product_gate_closed')
      const count=await pool.query('SELECT count(*) FROM memory_skill_executions');expect(Number(count.rows[0].count)).toBe(0)
    }finally{await app.close();await rm(dir,{recursive:true,force:true})}
  })
})
