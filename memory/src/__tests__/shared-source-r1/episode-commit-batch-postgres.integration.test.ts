import {afterAll, beforeAll, describe, expect, test} from 'vitest'
import {setTimeout as delay} from 'node:timers/promises'
import type pg from 'pg'
import {randomUUID} from 'node:crypto'
import {archiveObjectKey, encodeArchiveChunk, MemoryArchiveStorage} from '@pocketctl/session-source'
import {bindSourcePool, sourcePoolContext} from '../../sources/pool-context.js'
import {directLaunchFixture, type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createSharedSourceScheduler} from '../../sources/shared-scheduler.js'
import {createJobRepository} from '../../jobs/repository.js'
import {createJobWorker} from '../../jobs/worker.js'
import {createCanonicalProjectionHandler} from '../../sources/canonical-projection-worker.js'
import {createEpisodeRepository} from '../../episodes/repository.js'

async function archiveFirstEvent(f: DirectLaunchFixture, source: {session:string;owner:number}, id:string) {
  const manifestId = randomUUID()
  const payload=(await f.pool.query('SELECT payload FROM public.events WHERE id=$1',[id])).rows[0].payload
  const epoch=(await f.pool.query('SELECT activity_epoch::text AS epoch FROM public.sessions WHERE session_id=$1',[source.session])).rows[0].epoch
  const limits={maxRawBytes:1048576,maxCompressedBytes:1048576,maxRecords:100}
  const encoded=await encodeArchiveChunk({userId:source.owner,sessionId:source.session,activityEpoch:epoch,manifestId,ordinal:0},[{id,eventType:'agent_text',payload}],limits)
  const key=archiveObjectKey(manifestId,0),m=encoded.manifest,storage=new MemoryArchiveStorage()
  await storage.put(key,encoded.bytes)
  await f.pool.query(`INSERT INTO public.session_archive_manifests
   (manifest_id,user_id,session_id,activity_epoch,schema_version,codec,state,event_high_water,published_at,storage_namespace)
   VALUES($1,$2,$3,$4,1,'gzip','published',$5,NOW(),'history-cold-test')`,[manifestId,source.owner,source.session,epoch,id])
  await f.pool.query(`INSERT INTO public.session_archive_chunks(manifest_id,ordinal,object_key,first_event_id,last_event_id,event_count,raw_bytes,compressed_bytes,raw_sha256,compressed_sha256)
   VALUES($1,0,$2,$3,$3,1,$4,$5,$6,$7)`,[manifestId,key,id,m.rawBytes,m.compressedBytes,m.rawSha256,m.compressedSha256])
  await f.pool.query('ALTER TABLE public.events ALTER COLUMN payload DROP NOT NULL')
  await f.pool.query(`UPDATE public.events SET body_storage='cold',payload=NULL,body_session_id=$1,body_manifest_id=$2,body_chunk_ordinal=0,
   body_owner_user_id=$3,body_activity_epoch=$4 WHERE id=$5`,[source.session,manifestId,source.owner,epoch,id])
  bindSourcePool(f.runtime,{...sourcePoolContext(f.runtime),archive:{limits,storage:{namespace:'history-cold-test',read:key=>storage.read(key)}}})
}

const url = process.env.TASK21_DATABASE_URL
const suite = url ? describe : describe.skip
suite('selected episode commit cost', () => {
  let fixture: DirectLaunchFixture
  let originalTracking: string | null
  beforeAll(async () => {
    fixture = await directLaunchFixture(url!)
    originalTracking = (await fixture.pool.query(`SELECT split_part(setting,'=',2) AS value FROM pg_db_role_setting
      CROSS JOIN LATERAL unnest(setconfig) AS setting WHERE setrole=0 AND setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND setting LIKE 'track_functions=%'`)).rows[0]?.value ?? null
    await fixture.pool.query("ALTER DATABASE shared_direct_launch_memory_test SET track_functions='all'")
    await fixture.pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  }, 60000)
  afterAll(async () => {
    if (!fixture) return
    try {
      if (originalTracking === null) await fixture.pool.query('ALTER DATABASE shared_direct_launch_memory_test RESET track_functions')
      else if (['all','pl','none'].includes(originalTracking)) await fixture.pool.query(
        "ALTER DATABASE shared_direct_launch_memory_test SET track_functions='" + originalTracking + "'")
    } finally { await fixture.close() }
  })

  test.each([
    {size:1, revoke:false}, {size:16, revoke:false}, {size:64, revoke:false},
    {size:16, revoke:false, alias:true}, {size:16, revoke:false, cold:true},
    {size:256, revoke:false}, {size:64, revoke:true},
    {size:16, revoke:true, deleted:true},
  ])('rechecks $size events (alias=$alias, cold=$cold, revoke=$revoke, tombstone=$deleted)', async ({size, revoke, alias, cold, deleted}) => {
    const f = fixture
    const source = await f.source()
    const ids: string[] = []
    if (alias) {
      const newSessionId = source.session + '-renamed'
      await f.renameSession(f.pool,{oldSessionId:source.session,newSessionId,daemonId:source.daemon,userId:source.owner})
      source.session = newSessionId
    }
    for (let i = 1; i < size; i++) ids.push(await f.event(source))
    ids.push(await f.event(source,true))
    if (cold) await archiveFirstEvent(f,source,ids[0])
    const installation = (await f.install(source, 'retained_history')).inst.installation_id
    await f.pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')", [installation])
    const checked = new Set<string>()
    const nativeDefinition = (await f.pool.query("SELECT pg_get_functiondef('public.native_event_authority(bigint,integer)'::regprocedure) AS def")).rows[0].def as string
    let changed = false

    // Counters are transaction-local, so other workers and preparation reads cannot
    // contaminate this measurement. Enable tracking only in this isolated cluster.
    const counts: number[] = []
    const durations: number[] = []
    const originalQueries = new Map<pg.PoolClient, pg.PoolClient['query']>()
    const instrument = (client: pg.PoolClient) => {
      if (originalQueries.has(client)) return
      const query = client.query.bind(client)
      originalQueries.set(client, client.query)
      const calls = async () => Number((await query("SELECT pg_stat_get_xact_function_calls('public.native_session_authority(text,integer,text)'::regprocedure) AS n")).rows[0].n)
      client.query = function (...args: any[]) {
        const [sql, params] = args
        const run = () => Reflect.apply(query, client, args)
        if (typeof sql !== 'string' || !sql.includes('shared.lock_memory_personal_source_commit(') ||
            typeof params?.[3] !== 'string' || JSON.parse(params[3])?.purpose !== 'episode') return run()
        return (async () => {
          const rows = JSON.parse(params[3]).rows as {id: string}[]
          // Small turns fit in one envelope at every boundary. Large turns may
          // span pages, so their full ID set is also checked after compilation.
          if (size <= 64) expect(rows.map(row => row.id)).toEqual(ids)
          for (const row of rows) checked.add(row.id)
          // A newer Relay policy denies an event after the reader prepared a valid proof.
          if (deleted && !changed) {
            await f.pool.query('INSERT INTO public.deleted_sessions(session_id) VALUES($1)',[source.session])
            changed = true
          } else if (revoke && !changed) {
            const needle = 'SELECT id,user_id,session_id,logical_source_session_id,owner_retired'
            expect(nativeDefinition).toContain(needle)
            const deny = "IF p_id=" + ids[0] + " THEN RETURN jsonb_build_object('state','revoked'); END IF; "
            await f.pool.query(nativeDefinition.replace(needle, deny + needle))
            changed = true
          }
          expect((await query("SHOW track_functions")).rows[0].track_functions).toBe('all')
          const before = await calls()
          const start = performance.now()
          const result = await run()
          durations.push(performance.now() - start)
          counts.push(await calls() - before)
          return result
        })()
      } as pg.PoolClient['query']
    }
    f.runtime.on('acquire', instrument)
    const signal = new AbortController().signal
    const errors: unknown[] = []
    const scheduler = createSharedSourceScheduler({pool:f.runtime,workerId:'batch-scheduler',signal,onError:e=>errors.push(e)})
    const queue = createJobWorker({pool:f.runtime,jobs:createJobRepository(f.runtime),workerId:'batch-worker',signal,
      onError:(error,claim)=>{ if(!claim || claim.installation_id===installation) errors.push(error) }})
    queue.register('project_shared_source',createCanonicalProjectionHandler(f.runtime,{stabilizationMs:0}),{branch:'canonical'})
    queue.register('compile_episode',createEpisodeRepository(f.runtime,{stabilizationMs:0}).handleCompileEpisode)
    try {
      let completed = false
      for (let i = 0; i < 100 && !completed; i++) {
        await scheduler.runOnce()
        await queue.tick()
        completed = (await f.runtime.query("SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode' AND state='completed'",[installation])).rowCount === 1
        if (revoke && changed && errors.length) break
        expect(errors.map(String)).toEqual([])
        if (!completed) await delay(20)
      }
      if (revoke) {
        expect(changed).toBe(true)
        expect(errors.map(String)).toEqual([expect.stringContaining('source_reference_changed')])
        expect(completed).toBe(false)
        expect((await f.runtime.query('SELECT 1 FROM work_episodes WHERE installation_id=$1',[installation])).rowCount).toBe(0)
        return
      }
      expect(checked).toEqual(new Set(ids))
      expect(completed).toBe(true)
      expect((await f.runtime.query('SELECT 1 FROM work_episodes WHERE installation_id=$1',[installation])).rowCount).toBe(1)
      expect(counts.length).toBeGreaterThanOrEqual(3)
      if (process.env.EPISODE_COST_REPORT) console.info('episode commit samples', {counts, durations})
      // Includes the pre/post lock root observations and the separate root authority check.
      for (const count of counts) { expect(count).toBeGreaterThan(0); expect(count).toBeLessThan(10) }
    } finally {
      if (changed && !deleted) await f.pool.query(nativeDefinition)
      await scheduler.stop()
      await queue.stop()
      f.runtime.off('acquire', instrument)
      for (const [client, original] of originalQueries) client.query = original
    }
  }, 60000)
})
