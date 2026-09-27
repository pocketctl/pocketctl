import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { createClaimRepository } from '../claims/repository.js'
import { createEpisodeRepository } from '../episodes/repository.js'
import { createCandidateDeduper } from '../extraction/deduper.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createPurgeRepository } from '../purge/repository.js'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = enabled ? describe : describe.skip

const PERSONAL = '51515151-5151-4515-8515-515151515151'
const TEAM = '52525252-5252-4525-8525-525252525252'
const SOURCE_SESSION = 'team_1234567890abcdef1234567890abcdef'
const TURN = 'team-call:ccl_1'

function sourceData(role: 'goal' | 'reply' | 'outcome') {
  const event = {
    goal: { ids: ['cev_goal'], seqs: [10], at: '2026-09-26T01:00:00.000Z' },
    reply: { ids: ['cev_reply_1', 'cev_reply_2'], seqs: [11, 12], at: '2026-09-26T01:00:02.000Z' },
    outcome: { ids: ['cev_done'], seqs: [13], at: '2026-09-26T01:00:03.000Z' },
  }[role]
  return {
    team_source_version: 1,
    team_id: 'ctm_1',
    team_session_id: 'css_1',
    team_call_id: 'ccl_1',
    source_role: role,
    context_version: 3,
    turn_id: TURN,
    team_event_ids: event.ids,
    team_event_seqs: event.seqs,
    occurred_at: event.at,
    actor_scope: role === 'reply' ? 'root' : role === 'goal' ? 'user' : 'system',
    flow_scope: 'main',
    content_class: 'dialogue',
    ...(role === 'goal' ? { text: 'Find the stale revision', author_user_id: 7 } : {}),
    ...(role === 'reply' ? {
      text: 'The root cause is a stale collaboration revision.',
      final: true,
      author_offer_id: 'cao_1',
    } : {}),
    ...(role === 'outcome' ? { status: 'completed', turn_status: 'completed' } : {}),
    read_scope: {
      kind: 'team_session',
      team_id: 'ctm_1',
      team_session_id: 'css_1',
      team_memory_binding_id: 'cmbd_1',
      team_memory_binding_revision: 4,
      target_installation_id: TEAM,
      target_owner_scope_kind: 'team',
      target_owner_scope_id: '53535353-5353-4535-8535-535353535353',
      participant_user_id: 7,
      participant_revision: 2,
    },
  }
}

async function insertSourceInbox(pool: pg.Pool, feedId: number, role: 'goal' | 'reply' | 'outcome') {
  const data = sourceData(role)
  await pool.query(`
    INSERT INTO memory_feed_inbox
      (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
       session_id, turn_id, event_type, recorded_at, classification, data, payload_hash)
    VALUES ($1, $2, 1, 'session.event.v1', 'team_collaboration_event', $3,
            $4, $5, 'team_source', $6, '{}'::jsonb, $7::jsonb,
            sha256(convert_to($7::text, 'utf8')))
  `, [
    PERSONAL, feedId, `team:ccl_1:${role}:u7:b4:v1`, SOURCE_SESSION, TURN,
    data.occurred_at, JSON.stringify(data),
  ])
}

describeWithDatabase('Team source evidence lifecycle (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 60_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_candidates, memory_extraction_runs, knowledge_evidence,
               knowledge_evidence_capsules, knowledge_versions, knowledge_claims,
               claim_search_documents, work_episodes, source_turns, source_events,
               source_sessions, memory_feed_inbox, memory_session_tombstones,
               memory_feature_settings, memory_installations
      RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version)
      VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1),
             ($2, 'pocketctl-memory', 'active', 'ready', 1)
    `, [PERSONAL, TEAM])
    await pool.query(`
      INSERT INTO memory_feature_settings (installation_id, extraction_mode)
      VALUES ($1, 'enabled')
    `, [PERSONAL])
  })

  test('deduplicates a reply, preserves Team provenance, and retains only accepted evidence after revocation', async () => {
    await insertSourceInbox(pool, 1, 'goal')
    await insertSourceInbox(pool, 2, 'reply')
    await insertSourceInbox(pool, 3, 'outcome')
    const purge = createPurgeRepository(pool, { hmacKey: 'team-source-test-key' })
    const projector = createSourceProjector(pool, { stabilizationMs: 0, purge })
    expect(await projector.projectOnce(PERSONAL)).toEqual({ projected: 3 })

    await insertSourceInbox(pool, 4, 'goal')
    await insertSourceInbox(pool, 5, 'reply')
    await insertSourceInbox(pool, 6, 'outcome')
    expect(await projector.projectOnce(PERSONAL)).toEqual({ projected: 3 })
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM source_events WHERE installation_id = $1`, [PERSONAL])).rows[0].count).toBe(3)
    expect((await pool.query(`SELECT event_count::int AS count FROM source_turns WHERE installation_id = $1 AND turn_id = $2`, [PERSONAL, TURN])).rows[0].count).toBe(3)

    await createEpisodeRepository(pool, { stabilizationMs: 0, extractionDebounceMs: 0 })
      .compileTurn(PERSONAL, TURN)
    const episode = (await pool.query<{
      evidence_manifest: Record<string, { source_provenance?: Record<string, unknown> }>
      summary: Record<string, any>
    }>(`
      SELECT evidence_manifest, summary FROM work_episodes
      WHERE installation_id = $1 AND turn_id = $2
    `, [PERSONAL, TURN])).rows[0]
    const replyHandle = Object.entries(episode.evidence_manifest)
      .find(([, evidence]) => Array.isArray(evidence.source_provenance?.team_event_ids)
        && (evidence.source_provenance!.team_event_ids as string[]).includes('cev_reply_1'))?.[0]
    expect(replyHandle).toBeTruthy()
    if (!replyHandle) throw new Error('reply evidence handle missing')
    expect(episode.summary.references.source).toMatchObject({
      source_kind: 'team_session', team_id: 'ctm_1', team_session_id: 'css_1',
      team_call_id: 'ccl_1', context_version: 3,
      read_scope: { team_memory_binding_revision: 4, participant_revision: 2 },
    })

    const extractor = createCandidateExtractor({
      store: createExtractionRepository(pool),
      deduper: createCandidateDeduper(pool),
      provider: 'test',
      model: 'team-source-test',
      timeoutMs: 5_000,
      textGenerator: {
        generateJson: (async () => ({
          ok: true as const,
          value: {
            candidates: [
              {
                claim_type: 'bug_root_cause',
                statement: 'A stale collaboration revision caused the failure.',
                confidence: 0.9,
                scope_kind: 'installation',
                scope_key: 'global',
                evidence_handles: [replyHandle],
              },
              {
                claim_type: 'test_invariant',
                statement: 'Collaboration revisions must be checked before applying updates.',
                confidence: 0.85,
                scope_kind: 'installation',
                scope_key: 'global',
                evidence_handles: [replyHandle],
              },
            ],
          },
          usage: { inputTokens: 10, outputTokens: 10, model: 'team-source-test' },
        })) as never,
      },
    })
    expect(await extractor.extract({
      installationId: PERSONAL,
      turnId: TURN,
      signal: new AbortController().signal,
    })).toMatchObject({ kind: 'succeeded', candidateCount: 2 })

    const candidates = await pool.query<{ candidate_id: string; revision: string }>(`
      SELECT candidate_id::text, revision::text FROM memory_candidates
      WHERE installation_id = $1 AND status = 'validated' ORDER BY ordinal
    `, [PERSONAL])
    expect(candidates.rows).toHaveLength(2)
    const accepted = await createClaimRepository(pool).acceptCandidate({
      installationId: PERSONAL,
      candidateId: candidates.rows[0].candidate_id,
      expectedRevision: Number(candidates.rows[0].revision),
    })
    expect(accepted.ok).toBe(true)

    await purge.purgeSession({
      installationId: PERSONAL,
      sessionId: SOURCE_SESSION,
      reason: 'access_revoked',
      sourceFeedId: null,
    })
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM source_events WHERE installation_id = $1`, [PERSONAL])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM memory_candidates WHERE installation_id = $1`, [PERSONAL])).rows[0].count).toBe(0)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims WHERE installation_id = $1 AND state = 'active'`, [PERSONAL])).rows[0].count).toBe(1)
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM knowledge_claims WHERE installation_id = $1`, [TEAM])).rows[0].count).toBe(0)
    const retained = await pool.query<{ evidence_kind: string; locator: Record<string, any> }>(`
      SELECT evidence_kind, locator FROM knowledge_evidence WHERE installation_id = $1
    `, [PERSONAL])
    expect(retained.rows[0]).toMatchObject({
      evidence_kind: 'accepted_excerpt',
      locator: {
        source_provenance: {
          team_event_ids: ['cev_reply_1', 'cev_reply_2'],
          author_offer_id: 'cao_1',
          read_scope: { team_memory_binding_revision: 4, participant_revision: 2 },
        },
      },
    })
  })
})
