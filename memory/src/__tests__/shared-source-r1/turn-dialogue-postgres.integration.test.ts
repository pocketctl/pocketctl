import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { directLaunchFixture, type DirectLaunchFixture } from './direct-launch-fixture.js'
import { createSharedSourceScheduler } from '../../sources/shared-scheduler.js'
import {
  guardRetainedEvidence,
  assertRetainedSourceGuards,
  detachRetainedSourceGuards,
} from '../../sources/retained-authority.js'
import { createJobWorker } from '../../jobs/worker.js'
import { createJobRepository } from '../../jobs/repository.js'
import { createEpisodeRepository } from '../../episodes/repository.js'
import { createCurationExecutor } from '../../curation/executor.js'
import { createCurationWorker, curationTransaction } from '../../curation/worker.js'
import { loadCurrentLifecycleSources } from '../../curation/task-repository.js'
import { loadLifecycleHealth } from '../../reporting/lifecycle-health.js'
import { compileDialogue } from '../../episodes/compile-dialogue.js'
import { SharedSourceReader } from '@pocketctl/session-source'
import { withSourceJobExecution } from '../../sources/source-execution.js'
import { JobDeferredError } from '../../jobs/types.js'
import { checkDialogueRef } from '../../episodes/turn-dialogue.js'

const url = process.env.TURN_DIALOGUE_TEST_DATABASE_URL
;(url ? describe : describe.skip)('terminal dialogue with real Relay and Memory roles', () => {
  let f: DirectLaunchFixture
  beforeAll(async () => {
    f = await directLaunchFixture(url!,{captureRelayControls:true})
  }, 120_000)
  afterAll(async () => {
    await f?.close()
  })
  test('keeps independently verified archives and their individual reclamation state without a projection relation', async () => {
    const {canonicalPayloadHash,createPostgresSharedSourceReader}=await import('@pocketctl/session-source')
    const {prepareSourceAuthorities,prepareSourceReferences}=await import('../../sources/prepared-sources.js')
    const source=await f.source(),{inst}=await f.install(source,'retained_history'), install=inst.installation_id
    const session='archive-only-'+randomUUID(),first=randomUUID(),second=randomUUID()
    const payload={text:'independent archive',turn_id:'archive-turn'}, hash=canonicalPayloadHash(payload)
    for(const id of [first,second]){
      await f.pool.query(`INSERT INTO memory.source_events(source_event_id,installation_id,origin,origin_position,
       session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_kind,canonical_key,canonical_session_key,
       source_version,content_hash,hash_version,mapping_state,adapter_version,legacy_owner_user_id,legacy_manifest_hash)
       VALUES($1::uuid,$2,'feed',$1::text,$3,'archive-turn','user_text',now(),$4,$5,'legacy_archive',$1::text,$3,
        '{"content":"1","authorization":"1","storage":"0"}',$5,'canonical-json-sha256-v1','verified','legacy-archive-v1',$6,$7)`,
       [id,install,session,payload,hash,source.owner,'a'.repeat(64)])
    }
    await f.pool.query('UPDATE memory.source_events SET body_reclaimed_at=now() WHERE source_event_id=$1',[second])
    expect((await f.pool.query('SELECT payload IS NULL AS empty FROM shared.memory_archive_records WHERE source_event_id=$1',[second])).rows[0].empty).toBe(true)
    // Force the ordinary shared-active branch in the same installation.
    await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[install])
    await f.pool.query('ALTER TABLE memory.source_events RENAME TO retired_archive_fixture')
    try {
      const binding=(await f.runtime.query('SELECT context FROM shared.memory_source_ref_context($1,$2)',[install,[first]])).rows[0].context
      const reader=createPostgresSharedSourceReader(f.runtime)
      await expect(reader.getHeads(binding.scope,binding.root,[second])).rejects.toMatchObject({code:'source_body_reclaimed'})
      const refs=await f.runtime.query('SELECT * FROM shared.memory_native_evidence_handle($1,$2,NULL)',[install,first])
      expect(refs.rows).toMatchObject([{source_event_id:first,session_id:session,source_kind:'legacy_archive',retention_denied:false}])
      const prepared=await prepareSourceReferences(f.runtime,install,[first])
      expect(prepared.events[0].payload).toEqual(payload)
      const retained=await prepareSourceAuthorities(f.runtime,install,[first])
      const c=await f.runtime.connect()
      try {
        await c.query('BEGIN')
        await prepared.assertCurrent(c,{forCommit:true})
        await retained.assertCurrent(c,{forCommit:true})
        await c.query('COMMIT')
      }finally{await c.query('ROLLBACK');c.release()}
      await f.runtime.query("INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'deleted',now())",[install,session])
      expect((await f.pool.query('SELECT 1 FROM shared.memory_archive_records WHERE installation_id=$1',[install])).rowCount).toBe(0)
      await expect(reader.getHeads(binding.scope,binding.root,[first])).rejects.toMatchObject({code:'deleted'})
    }finally{await f.pool.query('ALTER TABLE memory.retired_archive_fixture RENAME TO source_events')}
  })
  test('bounds gap inspection across worker restarts and reopens only changed input', async () => {
    const source = await f.source()
    const { inst } = await f.install(source, 'retained_history')
    const install = inst.installation_id
    await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')", [install])
    await f.pool.query('INSERT INTO shared.memory_dialogue_installations VALUES($1,now()) ON CONFLICT DO NOTHING', [install])
    // Include already settled turns inside the installation's enrolled window.
    await f.pool.query("UPDATE shared.memory_dialogue_installations SET enabled_at=now()-interval '5 minutes' WHERE installation_id=$1",[install])
    const { createPostgresExtensionJournalSink } = await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)
    const journal = createPostgresExtensionJournalSink({ sharedHeaders: true })
    let turn = randomUUID()
    let settled = false
    async function emit(type: string, fields: Record<string, unknown>) {
      const id = randomUUID()
      const payload = { type, event_id: id, turn_id: turn, actor_scope: 'root', ...fields }
      const row = (await f.publisher.query(`INSERT INTO public.events(session_id,user_id,event_type,payload,event_hash,effect_status,created_at)
        VALUES($1,$2,$3,$4,$5,'completed',now()-$6::interval) RETURNING id::text`,
      [source.session,source.owner,type,payload,id.replaceAll('-',''),settled ? '1 minute' : '0 seconds'])).rows[0]
      await journal.appendCanonicalEvent(f.publisher, {sourceEventId:row.id,ownerUserId:source.owner,
        sessionId:source.session,eventType:type,occurredAt:null,payload})
    }
    const jobs = createJobRepository(f.runtime, {nativeSourcesOnly:true})
    async function runClaim() {
      const worker = randomUUID()
      const [job] = await jobs.claimJobs({workerId:worker,limit:1,leaseMs:30000})
      expect(job?.payload.turn).toBe(turn)
      const fence = {jobId:job.job_id,claimedBy:worker,claimEpoch:job.claim_epoch}
      try {
        await withSourceJobExecution(f.runtime,fence,() => createEpisodeRepository(f.runtime)
          .handleCompileEpisode(job,new AbortController().signal,{fence}))
      } catch (error) {
        if (!(error instanceof JobDeferredError)) throw error
        expect(await jobs.deferJob({...fence,reason:error.reason,availableAt:error.availableAt})).toBe(true)
        return 'deferred'
      }
      expect(await jobs.completeJob(fence)).toBe(true)
      return 'completed'
    }
    const dispatch = () => f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    const gap = async () => (await f.runtime.query(
      'SELECT reason FROM memory_dialogue_gaps WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3',
      [install,source.session,turn])).rows
    const episode = async () => (await f.runtime.query(
      'SELECT document FROM work_episodes WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3',
      [install,source.session,turn])).rows
    const reads = vi.spyOn(SharedSourceReader.prototype, 'resolveBodies')
    try {
      const question = '为什么？'.repeat(8192)
      for (const scenario of ['late','permanent','operation','missing-chunk'] as const) {
        turn = randomUUID()
        await emit('user_text',{text:scenario === 'operation' ? '查询进度' : question})
        if (scenario === 'missing-chunk') {
          await emit('agent_text',{part_id:'stream',stream_id:'s',chunk_seq:1,byte_offset:6,text:'',
            total_bytes:6,content_hash:createHash('sha256').update('答复').digest('hex'),final:true,message_phase:'final_answer'})
        }
        await emit('turn_status',{turn_status:'completed'})
        await dispatch()
        reads.mockClear()
        expect(await runClaim()).toBe('deferred')
        expect(reads).not.toHaveBeenCalled()
        expect(await gap()).toEqual([])
        if (scenario === 'late') {
          await emit('agent_text',{message_phase:'final_answer',text:'结论'})
          await dispatch()
        } else if (scenario === 'missing-chunk') {
          await emit('agent_text',{part_id:'stream',stream_id:'s',chunk_seq:0,byte_offset:0,text:'答复'})
          await dispatch()
        } else {
          // Advance only the owned test job's due time; no new source event wakes it.
          await f.runtime.query("UPDATE memory_jobs SET available_at=now() WHERE installation_id=$1 AND payload->>'turn'=$2", [install,turn])
        }
        expect(await runClaim()).toBe('completed')
        const repaired = scenario === 'late' || scenario === 'missing-chunk'
        expect(reads).toHaveBeenCalledTimes(repaired ? 2 : 1)
        if (repaired) {
          const answerText = scenario === 'late' ? '结论' : '答复'
          expect(await episode()).toMatchObject([{document:{messages:[{text:question},{text:answerText}]}}])
        } else {
          expect(await episode()).toEqual([])
        }
        if (scenario !== 'permanent') {
          expect(await gap()).toEqual([])
          continue
        }
        expect(await gap()).toEqual([{reason:'final_message_unconfirmed'}])
        // Re-delivery of an unchanged inventory reuses the fenced gap digest.
        await f.runtime.query("UPDATE memory_jobs SET state='pending',available_at=now() WHERE installation_id=$1 AND payload->>'turn'=$2",[install,turn])
        reads.mockClear()
        expect(await runClaim()).toBe('completed')
        expect(reads).not.toHaveBeenCalled()
        await emit('agent_text',{message_phase:'final_answer',text:'补到'})
        await dispatch()
        expect(await runClaim()).toBe('completed')
        expect(reads).toHaveBeenCalledTimes(2)
        expect(await gap()).toEqual([])
      }
      turn = randomUUID()
      settled = true
      await emit('user_text',{text:question})
      await emit('turn_status',{turn_status:'completed'})
      await dispatch()
      reads.mockClear()
      expect(await runClaim()).toBe('completed')
      expect(reads).toHaveBeenCalledTimes(1)
      expect(await gap()).toEqual([{reason:'final_message_unconfirmed'}])
    } finally {
      reads.mockRestore()
    }
  }, 60000)
  test('coalesces the closed turn, reads only selected text and rechecks raw evidence', async () => {
    const s = await f.source(),
      { inst } = await f.install(s, 'retained_history'),
      install = inst.installation_id
    let turn = 'turn-' + randomUUID()
    await f.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')", [install])
    await f.pool.query('INSERT INTO shared.memory_dialogue_installations(installation_id) VALUES($1) ON CONFLICT DO NOTHING', [
      install,
    ])
    const journal = (
      await import(pathToFileURL(resolve('../relay/dist/extensions/journal.js')).href)
    ).createPostgresExtensionJournalSink({ sharedHeaders: true })
    let seq = 0
    const emit = async (kind: string, fields: Record<string, unknown>, skillState = 'non_skill', proofFields: Record<string,unknown> = {}) => {
      const id = randomUUID(),
        payload = {
          type: kind,
          event_id: id,
          part_id: id,
          turn_id: turn,
          actor_scope: 'root',
          ...fields,
          memory_source: {
            version: 1,
            producer: 'codex',
            session_id: s.session,
            turn_id: turn,
            event_id: id,
            sequence: String(++seq),
            invocation_id: id,
            source_role: kind === 'user_text' ? 'user' : 'assistant',
            skill_state: skillState,
            lineage_complete: true,
            derived_from_event_ids: [],
            ...proofFields,
          },
        }
      const row = (
        await f.publisher.query(
          `INSERT INTO public.events(session_id,user_id,event_type,payload,event_hash,effect_status)
    VALUES($1,$2,$3,$4,$5,'completed') RETURNING id::text`,
          [s.session, s.owner, kind, payload, id.replaceAll('-', '')],
        )
      ).rows[0]
      await journal.appendCanonicalEvent(f.publisher, {
        sourceEventId: row.id,
        ownerUserId: s.owner,
        sessionId: s.session,
        eventType: kind,
        occurredAt: null,
        payload,
      })
      return row.id
    }
    const hash = (value:string) => createHash('sha256').update(value).digest('hex')
    const rootId = 'input:' + hash(randomUUID()), invocation = 'dialogue:' + hash('native-user')
    const promptText = 'I prefer rail for personal travel.'
    const prompt = await emit('user_text', {text:promptText},'non_skill',{event_id:rootId,invocation_id:rootId})
    await emit('user_text', {text:promptText,part_id:'native-user'},'unknown',{lineage_complete:false})
    await emit('tool_result', { text: 'tool output' })
    await emit('agent_text', { message_phase: 'commentary', text: '正在检查' })
    await emit('tool_call', { actor_scope: 'subagent', tool: 'mcp__test__lookup' })
    const longAnswer = '说明。'.repeat(2200) + '已选择五分钟。'
    const answer = await emit('agent_text', {part_id:'native-answer', message_phase:'final_answer',text:longAnswer},'unknown',{lineage_complete:false})
    const jobs = () =>
      f.runtime.query("SELECT * FROM memory_jobs WHERE installation_id=$1 AND payload->>'turn'=$2", [
        install,
        turn,
      ])
    expect((await jobs()).rows).toHaveLength(0)
    const witness = hash([s.session,turn,rootId,invocation,hash(promptText),hash('native-answer'),hash(longAnswer)].join('\0'))
    await emit('turn_status',{turn_status:'completed'},'non_skill',{source_role:'system',event_id:'codex-dialogue-v1:'+witness,
      parent_invocation_id:rootId,invocation_id:invocation,derived_from_event_ids:[rootId]})
    await f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    expect((await jobs()).rows).toHaveLength(1)
    const errors: unknown[] = []
    const queue = createJobWorker({
      pool: f.runtime,
      jobs: createJobRepository(f.runtime,{nativeSourcesOnly:true}),
      workerId: 'turn-dialogue-test',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    queue.register('compile_episode', createEpisodeRepository(f.runtime).handleCompileEpisode)
    queue.start()
    try {
      await expect
        .poll(async () => ({ state: (await jobs()).rows[0]?.state, errors }), { timeout: 10000 })
        .toEqual({ state: 'completed', errors: [] })
    } finally {
      await queue.stop()
    }
    const scheduler = createSharedSourceScheduler({
      pool: f.runtime,
      workerId: 'dialogue-cutover-test',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    scheduler.start()
    try {
      await expect
        .poll(
          async () =>
            (
              await f.pool.query(
                'SELECT processed_revision>=revision AS caught_up FROM shared.memory_source_work WHERE root_key=$1',
                [f.root(s)],
              )
            ).rows[0]?.caught_up,
          { timeout: 10000 },
        )
        .toBe(true)
      expect(
        (
          await f.runtime.query(
            "SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='project_shared_source'",
            [install],
          )
        ).rowCount,
      ).toBe(0)
    } finally {
      await scheduler.stop()
    }
    // Exercise exactly the SQL transaction shipped to operators. A foreign
    // dependent must roll back the transport DDL as well as the core DDL.
    const script=await readFile(resolve('../scripts/retire-memory-projection-storage.sql'),'utf8')
    const cutover=script.slice(script.indexOf('DO $check$'),script.indexOf('\\if :apply'))
    const admin=await f.pool.connect()
    try {
      for(const blocked of [true,false]){
        await admin.query('BEGIN')
        try {
          await admin.query("SELECT set_config('pocketctl.expected_database',current_database(),true)")
          if(blocked){
            await admin.query('CREATE VIEW public.retirement_dependency_fixture AS SELECT source_event_id FROM memory.source_events')
            await expect(admin.query(cutover)).rejects.toMatchObject({code:'2BP01'})
            await admin.query('ROLLBACK')
            expect((await admin.query("SELECT to_regclass('memory.memory_feed_inbox') IS NOT NULL AS present")).rows[0].present).toBe(true)
          }else{
            await admin.query(cutover)
            await admin.query('COMMIT')
          }
        } catch(error){await admin.query('ROLLBACK');throw error}
      }
    }finally{admin.release()}
    const {applyMemorySchema}=await import('../../schema.js')
    const {applySharedSourceContract}=await import('../../migrations/shared-db/contract.js')
    const {provisionSharedDatabase}=await import('../../migrations/shared-db/namespace.js')
    const {verifyMemoryStartup}=await import('../../startup-schema.js')
    await applyMemorySchema(f.pool,{namespace:'memory'})
    await applySharedSourceContract(f.pool)
    await provisionSharedDatabase(f.pool,{memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'})
    await verifyMemoryStartup(f.runtime)
    const {createWorkerGaugeCollector} = await import('../../worker-gauges.js')
    const {createMemoryMetrics} = await import('../../metrics.js')
    const metrics = createMemoryMetrics()
    await createWorkerGaugeCollector(f.runtime,metrics,true,'enabled')()
    expect((await metrics.jobs.get()).values.some(row=>row.labels.type==='consolidate_task')).toBe(true)
    {
      await compileDialogue(f.runtime, install, s.session, turn, 'off')
      const availability=await f.runtime.query('SELECT memory_session_available($1,$2,TRUE) AS allowed,memory_session_first_recorded_at($1,$2) AS started',[install,s.session])
      expect(availability.rows[0]).toMatchObject({allowed:true,started:expect.any(Date)})
      const {previewSourceRetention}=await import('../../retention/source.js')
      expect((await previewSourceRetention(f.runtime,14,1,{installationId:install})).eligible).toEqual([])
      expect((await loadLifecycleHealth(f.runtime,'enabled')).some(r=>r.installation_id===install)).toBe(true)
      const health = await f.runtime.query('SELECT * FROM shared.memory_source_pipeline_health($1)', [install])
      expect(health.rows[0]).toEqual({failed_jobs:'0',stalled_roots:'0'})
      const {rows:[{context}]} = await f.runtime.query('SELECT shared.memory_dialogue_context($1,$2) AS context', [install,s.session])
      const read = (otherTurn:string) => f.runtime.query(
        'SELECT * FROM shared.read_memory_dialogue_sources($1,$2,$3,$4)', [context.scope,context.root,otherTurn,[prompt,answer]])
      expect((await read(turn)).rowCount).toBe(2)
      expect((await read('unrelated-turn')).rowCount).toBe(0)
    }
    const rows = (
      await f.runtime.query(
        'SELECT summary,document,evidence_manifest FROM work_episodes WHERE installation_id=$1',
        [install],
      )
    ).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].summary.messages.map((m: any) => [m.text, m.reference.event])).toEqual([
      ['I prefer rail for personal travel.', prompt],
      [longAnswer.slice(0, 4000), answer],
    ])
    expect(rows[0].document.messages[1].text).toBe(longAnswer)
    expect((await f.runtime.query("SELECT to_regclass('memory.source_events') AS rel")).rows[0].rel).toBeNull()
    await checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false)
    await f.runtime.query(
      "INSERT INTO memory_curation_policies(installation_id,mode) VALUES($1,'enabled') ON CONFLICT(installation_id) DO UPDATE SET mode='enabled'",
      [install],
    )
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    const bundle = (
      await f.runtime.query('SELECT * FROM memory_task_bundles WHERE installation_id=$1', [install])
    ).rows[0]
    expect(bundle.dialogue_members).toHaveLength(2)
    const admitted = await curationTransaction(f.runtime, install, bundle.bundle_id, async (c, b) => {
      const source = await loadCurrentLifecycleSources(c, install, b)
      return source.admitted.map((e) => e.payload.text)
    })
    expect(admitted).toEqual(['I prefer rail for personal travel.', longAnswer])
    expect(
      (
        await f.runtime.query(
          "SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='consolidate_task'",
          [install],
        )
      ).rowCount,
    ).toBe(1)
    const scene = randomUUID()
    await f.runtime.query(
      "INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$2) ON CONFLICT DO NOTHING",
      [
        install,
        (
          await f.pool.query(
            'SELECT owner_scope_id FROM public.extension_installations WHERE installation_id=$1',
            [install],
          )
        ).rows[0].owner_scope_id,
      ],
    )
    await f.runtime.query(
      "INSERT INTO memory_spaces(installation_id,space_id,domain,name,destinations) VALUES($1,$2,'life','Personal travel',ARRAY['personal'])",
      [install, scene],
    )
    const healthForTurn = async () => (await loadLifecycleHealth(f.runtime,'enabled')).find(row=>row.installation_id===install)
    expect(await healthForTurn()).toMatchObject({turns:1,trusted_input_turns:1,receipt_turns:0,complete_turns:0})
    const id = bundle.dialogue_members[0].id
    const agent = bundle.dialogue_members[1].id
    const curator = createCurationWorker({
      pool: f.runtime,
      mode: 'enabled',
      modelFingerprint: 'turn-dialogue-test',
      textGenerator: {
        async generateJson<T>() {
          return {
            ok: true,
            value: {
              tasks: [
                {
                  space_id: scene,
                  task_id: null,
                  spans: [
                    { event_id: id, quote: 'I prefer rail for personal travel.' },
                    { event_id: agent, quote: '已选择五分钟。' },
                  ],
                  conclusions: [
                    {
                      kind: 'preference',
                      assertion_mode: 'user_asserted',
                      subject: 'self',
                      predicate: 'travel.transport',
                      value: 'rail',
                      conditions: {},
                      fact_at: null,
                      valid_until: null,
                      statement: 'I prefer rail for personal travel.',
                      confirmed: true,
                      evidence: { subject: [id], predicate: [id], value: [id] },
                    },
                  ],
                },
              ],
            } as T,
            usage: { inputTokens: 1, outputTokens: 1, model: 'local-fixture' },
          }
        },
      },
    })
    const executor = createCurationExecutor({ pool: f.runtime, mode: 'enabled', tombstoneKeys: [] })
    const pipeline = createJobWorker({
      pool: f.runtime,
      jobs: createJobRepository(f.runtime,{nativeSourcesOnly:true}),
      workerId: 'dialogue-curation',
      signal: new AbortController().signal,
      onError: (e) => errors.push(e),
    })
    pipeline.register('consolidate_task', (j, s, c) => curator.consolidate(j, s, c?.fence))
    pipeline.register('curate_conclusions', async (j, s, c) => {
      await executor.curate(j, s, c?.fence)
    })
    pipeline.start()
    try {
      await expect
        .poll(
          async () =>
            (
              await f.runtime.query('SELECT locator FROM knowledge_evidence WHERE installation_id=$1', [
                install,
              ])
            ).rows.map((r) => r.locator.dialogue?.event),
          { timeout: 12000 },
        )
        .toContain(prompt)
    } finally {
      await pipeline.stop()
    }
    const proof = (
      await f.runtime.query('SELECT locator FROM knowledge_evidence WHERE installation_id=$1', [install])
    ).rows[0].locator.dialogue
    await f.publisher.query("UPDATE public.sessions SET status='exited' WHERE session_id=$1", [s.session])
    expect((await f.runtime.query('SELECT shared.reclaim_turn_dialogues() AS n')).rows[0].n).toBe(1)
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1', [install]))
        .rowCount,
    ).toBe(0)
    expect(await healthForTurn()).toMatchObject({turns:1,trusted_input_turns:1,receipt_turns:1,complete_turns:1})
    await checkDialogueRef(f.runtime, install, proof, false)
    const client = await f.runtime.connect()
    try {
      await client.query('BEGIN')
      const ev = (
        await client.query(
          'SELECT evidence_id,version_id,evidence_kind,source_event_id,artifact_id FROM knowledge_evidence WHERE installation_id=$1',
          [install],
        )
      ).rows
      await guardRetainedEvidence(client, install, ev)
      await assertRetainedSourceGuards(client)
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      detachRetainedSourceGuards(client)
      client.release()
    }
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE installation_id=$1', [install]))
        .rowCount,
    ).toBe(0)
    await checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false)
    const priorTurn = turn
    turn = 'late-' + randomUUID()
    await emit('user_text', { text: '另一个问题' })
    await emit('turn_status', {turn_status:'completed'}, 'unknown', {source_role:'system', lineage_complete:false,
      source_path:'managed_dispatch',source_gap_reason:'codex_inventory_incomplete'})
    await compileDialogue(f.runtime, install, s.session, turn, 'off')
    expect(
      (
        await f.runtime.query(
          'SELECT reason FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2',
          [install, turn],
        )
      ).rows,
    ).toEqual([{ reason: 'final_message_unconfirmed' }])
    await emit('agent_text', {part_id:'answer', message_phase:'final_answer', text:'迟到的结论'}, 'unknown',
      {lineage_complete:false,source_path:'managed_dispatch',source_gap_reason:'codex_final_unconfirmed'})
    await compileDialogue(f.runtime, install, s.session, turn, 'off')
    expect(
      (
        await f.runtime.query('SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2', [
          install,
          turn,
        ])
      ).rowCount,
    ).toBe(0)
    // A late native call withdraws an already compiled turn even when the
    // prompt never mentioned MCP. Its leased/queued curation job becomes a no-op.
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    const lateBundle = (
      await f.runtime.query(
        'SELECT bundle_id FROM memory_task_bundles WHERE installation_id=$1 AND task_key=$2',
        [install, 'dialogue:' + turn],
      )
    ).rows[0]
    const admission = (await f.runtime.query(`SELECT evidence_manifest->'lifecycle_admission' AS admission
      FROM work_episodes WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3`,[install,s.session,turn])).rows[0].admission
    expect(admission).toMatchObject({provenance:'unknown',allowed_count:1,excluded_count:1,
      diagnostics:{codex_final_unconfirmed:1},terminal_gap:{source_path:'managed_dispatch',source_gap_reason:'codex_inventory_incomplete'}})
    expect(await healthForTurn()).toMatchObject({turns:2,trusted_input_turns:1,unknown_input_turns:1,
      with_trusted_input_turns:2,partially_trusted_turns:1,complete_turns:1})
    expect(lateBundle).toBeDefined()
    await f.runtime.query('SELECT shared.dispatch_turn_dialogues()')
    const call = await emit('tool_call', {
      tool: 'lookup',
      call_meta: { tool_kind: 'mcp' },
      input: { secret: 'synthetic argument' },
    })
    const header = (await f.publisher.query('SELECT body_header FROM public.events WHERE id=$1', [call]))
      .rows[0].body_header
    expect(header.dialogue_operation).toBe('mcp')
    expect(header).not.toHaveProperty('input')
    expect((await f.runtime.query('SELECT shared.dispatch_turn_dialogues() AS n')).rows[0].n).toBe(1)
    expect(
      await curationTransaction(f.runtime, install, lateBundle.bundle_id, async () => {
        throw Error('excluded content reached curation')
      }),
    ).toBeNull()
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (
        await f.runtime.query(
          'SELECT state,document FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',
          [install, turn],
        )
      ).rows,
    ).toEqual([{ state: 'invalidated', document: {} }])
    expect(
      (await f.runtime.query('SELECT 1 FROM memory_task_bundles WHERE bundle_id=$1', [lateBundle.bundle_id]))
        .rowCount,
    ).toBe(0)

    for (const [promptText, tool] of [
      ['查询进度', null],
      ['请合并代码', null],
      ['继续', { tool: 'Skill', input: { skill: 'synthetic' } }],
      ['继续', { tool: 'commandExecution', input: { command: 'git add -A && git commit -m test' } }],
      ['继续', { tool: 'Bash', input: { command: 'git merge feature/turn' } }],
    ] as const) {
      turn = randomUUID()
      await emit('user_text', { text: promptText })
      if (tool) await emit('tool_call', tool)
      await emit('turn_status', { turn_status: 'completed' })
      // Missing final reply must not turn a policy skip into a gap.
      await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
      expect(
        (
          await f.runtime.query(
            `SELECT 1 FROM work_episodes WHERE installation_id=$1 AND turn_id=$2
        UNION ALL SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2
        UNION ALL SELECT 1 FROM memory_task_bundles WHERE installation_id=$1 AND task_key='dialogue:'||$2`,
            [install, turn],
          )
        ).rows,
      ).toEqual([])
    }
    turn = randomUUID()
    await emit('user_text', { text: '继续' })
    await emit('agent_text', { text: '技能返回' }, 'skill')
    await emit('turn_status', { turn_status: 'completed' })
    await compileDialogue(f.runtime, install, s.session, turn, 'enabled')
    expect(
      (
        await f.runtime.query('SELECT 1 FROM memory_dialogue_gaps WHERE installation_id=$1 AND turn_id=$2', [
          install,
          turn,
        ])
      ).rows,
    ).toEqual([])
    turn = priorTurn
    await f.pool.query("UPDATE public.extension_installations SET status='paused' WHERE installation_id=$1", [
      install,
    ])
    await expect(
      checkDialogueRef(f.runtime, install, rows[0].evidence_manifest.dialogue, false),
    ).rejects.toThrow()
    const {createPurgeRepository}=await import('../../purge/repository.js')
    const purge=createPurgeRepository(f.runtime,{hmacKey:'synthetic-only'})
    await purge.purgeSession({installationId:install,sessionId:s.session,sourceFeedId:null,reason:'user_requested'})
    expect((await f.runtime.query('SELECT 1 FROM work_episodes WHERE installation_id=$1 AND session_id=$2',[install,s.session])).rowCount).toBe(0)
    await purge.purgeInstallation({installationId:install,requestId:randomUUID(),reason:'user_requested'})
    expect((await f.runtime.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[install])).rows[0].local_status).toBe('purged')
    const next=await f.source()
    const {ExtensionInstallationRepository}=await import(pathToFileURL(resolve('../relay/dist/extensions/installation-repository.js')).href)
    const created=await new ExtensionInstallationRepository(f.publisher).createInstallation({providerId:'pocketctl-memory',ownerUserId:next.owner,
      grantedScopes:['session:events:read','session:snapshot:read'],subscriptions:['session.event.v1'],enabledServices:['memory.manage'],eventFilter:{},startPolicy:'retained_history'})
    await f.pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[created.installation_id])
    const {createNativeInstallationDiscovery}=await import('../../installations/native-discovery.js')
    const discovery=createNativeInstallationDiscovery({pool:f.runtime,signal:new AbortController().signal})
    try{
      await discovery.discoverOnce()
      expect((await f.runtime.query('SELECT shared.uses_turn_dialogue($1) AS enrolled',[created.installation_id])).rows[0].enrolled).toBe(true)
      const mode=(await f.pool.query('SELECT generation FROM shared.memory_source_modes WHERE installation_id=$1',[created.installation_id])).rows[0]
      await f.pool.query("SELECT shared.transition_memory_source_mode($1,$2,'paused')",[created.installation_id,mode.generation])
      await discovery.discoverOnce()
      expect((await f.runtime.query('SELECT shared.uses_turn_dialogue($1) AS enrolled',[created.installation_id])).rows[0].enrolled).toBe(false)
    }finally{await discovery.stop()}

  }, 60000)
})
