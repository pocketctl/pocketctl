import {dialogueAlreadyProcessed,recordDialogueResult,markDialogueStage,type DialogueGeneration} from './dialogue-generation.js'
import {markConfirmedDialogueLock} from '../sources/processing-pins.js'
import type pg from 'pg'
import { assertJobFence } from '../generation/fence.js'
import { JobDeferredError, type JobFence } from '../jobs/types.js'
import { guardSourceExecutionCommit } from '../sources/source-execution.js'
import { lockCurationAuthority, readCurationPolicy } from '../curation/policy.js'
import type { CurationMode } from '../curation/contracts.js'
import { prepareLifecycleTurn } from '../curation/prepare-lifecycle-turn.js'
import { stagePreparedLifecycleTurn } from '../curation/task-repository.js'
import { DialogueExcluded, DialogueInputGap, type DialogueGapProbe, prepareDialogue } from './turn-dialogue.js'
import { parseMemorySourceProvenance } from './skill-provenance.js'
import { LIFECYCLE_SOURCE_POLICY } from './source-admission.js'
import { sanitizeText } from './content-policy.js'

export async function compileDialogue(
  pool: pg.Pool,
  install: string,
  session: string,
  turn: string,
  mode: CurationMode,
  fence?: JobFence,
  gapProbe?: DialogueGapProbe, generation?:DialogueGeneration,
) {
  if(generation && await dialogueAlreadyProcessed(pool,generation))return
  const observedGeneration=generation?.generation ?? (await pool.query(`SELECT requested_generation FROM memory_dialogue_turns
    WHERE (installation_id,session_id,turn_id)=($1,$2,$3)`,[install,session,turn])).rows[0]?.requested_generation
  let input: Awaited<ReturnType<typeof prepareDialogue>>
  try {
    input = await prepareDialogue(pool, install, session, turn, fence ? gapProbe : undefined,generation)
  } catch (error) {
    markDialogueStage(error,'prepare')
    if (!(error instanceof DialogueInputGap || error instanceof DialogueExcluded)) throw error
    const probe = error instanceof DialogueInputGap ? error.probeResult : undefined
    const inspectAt = error instanceof DialogueInputGap ? error.inspectAt : undefined
    const db = await pool.connect()
    try {
      await db.query('BEGIN')
      if(generation)await db.query("SET LOCAL lock_timeout='250ms'")
      if (fence) await assertJobFence(db, fence)
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))", [
        install,
        session,
      ])
      if (error instanceof DialogueExcluded) {
        await db.query(
          'DELETE FROM memory_dialogue_gaps WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3',
          [install, session, turn],
        )
        await db.query(
          "DELETE FROM memory_task_bundles WHERE installation_id=$1 AND session_id=$2 AND task_key=$3 AND bundle_kind='intake'",
          [install, session, 'dialogue:' + turn],
        )
      } else if (!inspectAt) {
        await db.query(
          `INSERT INTO memory_dialogue_gaps(installation_id,session_id,turn_id,reason) SELECT $1::uuid,$2,$3,$4 WHERE shared.memory_dialogue_context($1,$2) IS NOT NULL
    ON CONFLICT(installation_id,session_id,turn_id) DO UPDATE SET reason=excluded.reason
    WHERE memory_dialogue_gaps.reason IS DISTINCT FROM excluded.reason`,
          [install, session, turn, error.reason],
        )
      }
      if (error.assertCurrent) {
        await error.assertCurrent(db)
        await db.query(
          `UPDATE work_episodes SET state='invalidated',summary='{}',document='{}',evidence_manifest='{}',dialogue_completion=NULL,dialogue_generation=NULL
     WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3 AND compiler_version='relay-turn-v1' AND state<>'invalidated'`,
          [install, session, turn],
        )
      }
      if (fence && probe) {
        await db.query(`UPDATE memory_jobs SET payload=jsonb_set(payload,'{dialogue_gap_probe_v1}',to_jsonb($2::text))
          WHERE job_id=$1`, [fence.jobId, probe])
      }
      if (fence && gapProbe?.previous !== undefined && error instanceof DialogueExcluded)
        await db.query("UPDATE memory_jobs SET payload=payload-'dialogue_gap_probe_v1' WHERE job_id=$1", [fence.jobId])
      if(generation&&!inspectAt){
        if(!error.assertCurrent)throw Error('source_reference_unavailable')
        await recordDialogueResult(db,generation,error instanceof DialogueExcluded?'not_admitted':'input_gap',error.reason,error.inputDigest??null)
      }
      await guardSourceExecutionCommit(db)
      await db.query('COMMIT')
    } catch (err) {
      markDialogueStage(err,'publish')
      await db.query('ROLLBACK')
      if(err instanceof Error&&(err as {code?:string}).code==='55P03')markConfirmedDialogueLock(err)
      throw err
    } finally {
      db.release()
    }
    // A crash between commit and defer is safe: lease recovery sees the
    // durable inspect marker. A late answer takes the normal path immediately.
    if (inspectAt) throw Object.assign(new JobDeferredError('source_not_ready', inspectAt),{dialogueInspection:true})
    return
  }
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    if(generation)await c.query("SET LOCAL lock_timeout='250ms'")
    await lockCurationAuthority(c, install)
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)),pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",
      [install, session],
    )
    if (fence) await assertJobFence(c, fence)
    const policy = await readCurationPolicy(c, install, mode)
    if (policy === 'source_denied') throw Error('source_reference_unavailable')
    const messages = input.events.map((e) => ({
      role: e.event_type === 'user_text' ? 'user' : 'assistant',
      text: sanitizeText(String(e.payload.text), Infinity).text,
      reference: e.source_provenance.dialogue,
    }))
    const summary = messages.map(({ text, ...message }) => ({
      ...message,
      text: text.slice(0, 4000),
      length: text.length,
      truncated: text.length > 4000,
    }))
    const lifecycle = policy && prepareLifecycleTurn({
      installationId: install, sessionId: session, turnId: turn, events: input.events,
    })
    // The terminal is outside the admitted message set. Its diagnostics describe
    // the producer's observation without granting lineage to a message.
    const terminal = parseMemorySourceProvenance(input.terminal.proof)
    const terminalGap = terminal?.source_gap_reason && terminal.session_id === session
      && terminal.turn_id === turn && terminal.source_role === 'system'
      ? {source_path: terminal.source_path, source_gap_reason: terminal.source_gap_reason}
      : undefined
    // Bind the Relay inventory and the lifecycle digest under the source fence.
    const admission = lifecycle && {
      episode_digest: input.ref.members,
      digest: lifecycle.digest.toString('hex'),
      source_policy: LIFECYCLE_SOURCE_POLICY,
      provenance: lifecycle.unknown ? 'unknown' : lifecycle.members.length ? 'trusted' : 'skipped_policy',
      allowed_count: lifecycle.members.length,
      excluded_count: lifecycle.excluded,
      diagnostics: lifecycle.diagnostics,
      ...(terminalGap && {terminal_gap: terminalGap}),
    }
    const manifest = {dialogue: input.ref, ...(admission && {lifecycle_admission: admission})}
    await c.query(
      `INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,terminal_at,
   ready_at,event_count,summary,compiler_version,evidence_manifest,compiled_at,source_digest,document_compiler_version,document)
   VALUES($1,gen_random_uuid(),$2,$3,'ready',$4,$5,now(),$6,$7,'relay-turn-v1',$8,now(),decode($9,'hex'),'relay-turn-v1',$10)
   ON CONFLICT(installation_id,session_id,turn_id) DO UPDATE SET outcome=excluded.outcome,state='ready',terminal_at=excluded.terminal_at,
    ready_at=now(),event_count=excluded.event_count,summary=excluded.summary,compiler_version=excluded.compiler_version,
    dialogue_completion=CASE WHEN work_episodes.evidence_manifest->'dialogue'=excluded.evidence_manifest->'dialogue'
      AND work_episodes.dialogue_completion->>'digest'=excluded.evidence_manifest#>>'{lifecycle_admission,digest}'
      THEN work_episodes.dialogue_completion END,
    document=excluded.document,compiled_at=excluded.compiled_at,source_digest=excluded.source_digest,document_compiler_version=excluded.document_compiler_version,
    evidence_manifest=excluded.evidence_manifest WHERE work_episodes.session_id=excluded.session_id
    AND (work_episodes.evidence_manifest->'dialogue' IS DISTINCT FROM excluded.evidence_manifest->'dialogue'
      OR (excluded.evidence_manifest ? 'lifecycle_admission' AND work_episodes.evidence_manifest->'lifecycle_admission'
       IS DISTINCT FROM excluded.evidence_manifest->'lifecycle_admission'))`,
      [
        install,
        session,
        turn,
        input.terminal.header.turn_status,
        input.terminal.at,
        summary.length,
        JSON.stringify({ messages: summary }),
        manifest,
        input.ref.members,
        JSON.stringify({ messages }),
      ],
    )
    if (policy && lifecycle) await stagePreparedLifecycleTurn(c, lifecycle, policy, true)
    await input.assertCurrent(c, { forCommit: true })
    // The source fence and turn lock cover this inventory until commit. Direct
    // historical callers can also bind their verified episode to its generation.
    const currentGeneration=(await c.query(`SELECT requested_generation FROM memory_dialogue_turns
      WHERE (installation_id,session_id,turn_id)=($1,$2,$3)`,[install,session,turn])).rows[0]?.requested_generation
    if(currentGeneration!==observedGeneration)throw Error('source_reference_changed')
    await c.query(`UPDATE work_episodes SET dialogue_generation=$4 WHERE (installation_id,session_id,turn_id)=($1,$2,$3)
      AND dialogue_generation IS DISTINCT FROM $4`,[install,session,turn,currentGeneration??null])
    await c.query(
      'DELETE FROM memory_dialogue_gaps WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3',
      [install, session, turn],
    )
    if (fence && gapProbe?.previous !== undefined)
      await c.query("UPDATE memory_jobs SET payload=payload-'dialogue_gap_probe_v1' WHERE job_id=$1", [fence.jobId])
    if(generation)await recordDialogueResult(c,generation,lifecycle&&!lifecycle.members.length?'not_admitted':'published',
      lifecycle&&!lifecycle.members.length?(lifecycle.unknown?'provenance_unknown':'skipped_policy'):null,input.ref.members)
    await guardSourceExecutionCommit(c)
    await c.query('COMMIT')
  } catch (error) {
    markDialogueStage(error,'publish')
    await c.query('ROLLBACK')
    if(error instanceof Error&&(error as {code?:string}).code==='55P03')markConfirmedDialogueLock(error)
    throw error
  } finally {
    c.release()
  }
}
