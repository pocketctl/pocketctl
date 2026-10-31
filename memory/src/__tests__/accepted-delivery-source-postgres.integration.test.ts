import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deliverySourceStatus } from '../claims/delivery-source-status.js'
import { createReviewService } from '../claims/review-service.js'
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
const suite = databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
const PERSONAL = '77777777-7777-4777-8777-777777777777'
type SourceRecord = {
  sourceKind: string; sourceId: string; sessionId: string; eventType: string
  occurredAt: Date; payload: Record<string, any>
}

suite('accepted delivery Memory projection (isolated PostgreSQL)', () => {
  let pool: pg.Pool, records: SourceRecord[], feedId: number
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
    const producer = await import(new URL('../../../relay/src/team/accepted-delivery-memory-source.ts', import.meta.url).href)
    const fixture = await import(new URL('../../../relay/src/__tests__/fixtures/accepted-delivery-memory.ts', import.meta.url).href)
    const input = fixture.acceptedDeliveryFixture()
    input.readers = [input.readers[0]]
    records = producer.buildAcceptedDeliveryMemorySourceRecords(input)
    input.submission.id = '55555555-5555-4555-8555-555555555555'
    input.decision.id = '66666666-6666-4666-8666-666666666666'
    records.push(...producer.buildAcceptedDeliveryMemorySourceRecords(input))
  }, 60_000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE memory_team_delivery_withdrawals, memory_session_tombstones, memory_purge_receipts, memory_installations CASCADE')
    await pool.query(`INSERT INTO memory_installations
      (installation_id,provider_id,relay_status,local_status,config_version)
      VALUES($1,'pocketctl-memory','active','ready',1)`, [PERSONAL])
    await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)", [PERSONAL])
    await pool.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')", [PERSONAL])
    feedId = 0
  })
  async function enqueue(packet: SourceRecord[]) {
    for (const record of packet) await pool.query(`INSERT INTO memory_feed_inbox
      (installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,turn_id,event_type,recorded_at,classification,data,payload_hash)
      VALUES($1,$2,1,'session.event.v1',$3,$4,$5,$6,$7,$8,'{}',$9::jsonb,sha256(convert_to($9::text,'utf8')))`,
    [PERSONAL, ++feedId, record.sourceKind, record.sourceId, record.sessionId, record.payload.turn_id,
      record.eventType, record.occurredAt, JSON.stringify(record.payload)])
  }
  async function enqueueRevocation(sessionId: string) {
    await pool.query(`INSERT INTO memory_feed_inbox
      (installation_id,feed_id,envelope_version,topic,source_kind,source_id,session_id,event_type,recorded_at,classification,data,payload_hash)
      VALUES($1,$2,1,'session.access.revoked.v1','session_access_revoked',$3,$4,'session_access_revoked',NOW(),'{}','{}',sha256(convert_to('{}','utf8')))`,
    [PERSONAL, ++feedId, `revoke:${sessionId}`, sessionId])
  }
  function projector() {
    return createSourceProjector(pool, { stabilizationMs: 0, purge: createPurgeRepository(pool, { hmacKey: 'accepted-delivery-test-only' }) })
  }
  async function extract(packet: SourceRecord[]) {
    const turnId = packet[0].payload.turn_id
    await createEpisodeRepository(pool, { stabilizationMs: 0, extractionDebounceMs: 0 }).compileTurn(PERSONAL, turnId)
    const episode = (await pool.query('SELECT summary,evidence_manifest FROM work_episodes WHERE installation_id=$1 AND turn_id=$2', [PERSONAL, turnId])).rows[0]
    expect(episode.summary.references.source.accepted_delivery).toEqual(packet[0].payload.accepted_delivery)
    const handle = Object.entries(episode.evidence_manifest as Record<string, any>)
      .find(([, evidence]) => evidence.source_provenance?.author_offer_id === 'cao_delivery')?.[0]
    expect(handle).toBeTruthy()
    const extractor = createCandidateExtractor({
      store: createExtractionRepository(pool), deduper: createCandidateDeduper(pool),
      provider: 'fixture', model: 'accepted-delivery-contract', timeoutMs: 5000,
      textGenerator: { generateJson: (async () => ({ ok: true, value: { candidates: [{
        claim_type: 'test_invariant', statement: 'Request replay must preserve the accepted immutable revision.',
        confidence: 0.9, scope_kind: 'installation', scope_key: 'global', evidence_handles: [handle],
      }] }, usage: { inputTokens: 1, outputTokens: 1, model: 'accepted-delivery-contract' } })) as never },
    })
    expect(await extractor.extract({ installationId: PERSONAL, turnId, signal: new AbortController().signal }))
      .toMatchObject({ kind: 'succeeded', candidateCount: 1 })
  }

  test('projects replay once, extracts a candidate without publishing, and preserves exact identity after explicit personal acceptance', async () => {
    const packet = records.slice(0, 3)
    await enqueue(packet); await enqueue(packet)
    expect(await projector().projectOnce(PERSONAL)).toEqual({ projected: 6 })
    expect((await pool.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1', [PERSONAL])).rows[0].n).toBe(3)
    expect((await pool.query('SELECT event_count::int AS n FROM source_turns WHERE installation_id=$1', [PERSONAL])).rows[0].n).toBe(3)
    await extract(packet)
    const candidates = (await pool.query("SELECT candidate_id,revision::int FROM memory_candidates WHERE installation_id=$1 AND status='validated'", [PERSONAL])).rows
    expect(candidates).toHaveLength(1)
    expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims')).rows[0].n).toBe(0)
    expect(await createClaimRepository(pool).acceptCandidate({ installationId: PERSONAL,
      candidateId: candidates[0].candidate_id, expectedRevision: candidates[0].revision })).toMatchObject({ ok: true })
    const evidence = (await pool.query('SELECT locator FROM knowledge_evidence WHERE installation_id=$1', [PERSONAL])).rows
    expect(evidence).toHaveLength(1)
    expect(evidence[0].locator.source_provenance.accepted_delivery).toEqual(packet[0].payload.accepted_delivery)
    expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims WHERE installation_id<>$1', [PERSONAL])).rows[0].n).toBe(0)
  })

  test('review metadata is installation-scoped and reflects a withdrawal without leaking reader grants', async () => {
    const packet = records.slice(0, 3)
    await enqueue(packet); await projector().projectOnce(PERSONAL); await extract(packet)
    const review = createReviewService(pool, createClaimRepository(pool))
    const queue = await review.reviewQueue({ installationId: PERSONAL })
    expect(queue).toHaveLength(1)
    const identity = packet[0].payload.accepted_delivery
    expect(await review.reviewQueue({ installationId: PERSONAL, submissionId: identity.submission_id, decisionId: identity.decision_id })).toHaveLength(1)
    expect(await review.reviewQueue({ installationId: PERSONAL, submissionId: identity.submission_id,
      decisionId: '99999999-9999-4999-8999-999999999999' })).toHaveLength(0)
    expect(queue[0].delivery_source).toEqual({
      task_id: identity.task_id, spec_revision: identity.spec_revision,
      submission_id: identity.submission_id, submission_version: identity.submission_version,
      decision_id: identity.decision_id, accepted_at: identity.accepted_at, state: 'available',
    })
    expect(JSON.stringify(queue)).not.toContain('read_scope')
    expect(JSON.stringify(queue)).not.toContain('reviewer_user_id')
    expect(await review.reviewQueue({ installationId: '99999999-9999-4999-8999-999999999999' })).toEqual([])
    await pool.query(`INSERT INTO memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id)
      VALUES($1,$2,$3,$4)`, [packet[0].payload.team_id,packet[0].payload.team_session_id,identity.submission_id,identity.decision_id])
    const withdrawn = await review.reviewQueue({ installationId: PERSONAL })
    expect(withdrawn[0].delivery_source?.state).toBe('withdrawn')
    expect(withdrawn[0].content_hash).toBe(queue[0].content_hash)
    expect(await review.rejectCandidate({ installationId: PERSONAL, candidateId: queue[0].candidate_id,
      expectedRevision: Number(queue[0].revision), expectedHash: queue[0].content_hash })).toMatchObject({ ok: true })
  })

  test('personal source status distinguishes received, pending, accepted and withdrawn without cross-installation disclosure', async () => {
    const packet = records.slice(0, 3), identity = packet[0].payload.accepted_delivery
    const input = { installationId: PERSONAL, submissionId: identity.submission_id, decisionId: identity.decision_id }
    expect(await deliverySourceStatus(pool, input)).toEqual({ source: null })
    await enqueue(packet); await projector().projectOnce(PERSONAL)
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ source: { state: 'available' },
      candidates: { pending: 0 }, personal_claims: { confirmed: 0 }, extraction_state: null })
    await extract(packet)
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { pending: 1, stale: 0 }, extraction_state: 'succeeded' })
    const review = createReviewService(pool, createClaimRepository(pool))
    const candidate = (await review.reviewQueue({ installationId: PERSONAL }))[0]
    expect(await review.acceptCandidate({ installationId: PERSONAL, candidateId: candidate.candidate_id,
      expectedRevision: Number(candidate.revision) })).toMatchObject({ ok: true })
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { pending: 0 }, personal_claims: { confirmed: 1, current: 1 } })
    // Ordinary access revocation removes the episode, but retained accepted evidence still proves personal ownership.
    await enqueueRevocation(packet[0].sessionId); await projector().projectOnce(PERSONAL)
    expect((await pool.query('SELECT 1 FROM work_episodes WHERE installation_id=$1', [PERSONAL])).rowCount).toBe(0)
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ personal_claims: { confirmed: 1, current: 1 } })
    await pool.query(`INSERT INTO memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id)
      VALUES($1,$2,$3,$4)`, [packet[0].payload.team_id,packet[0].payload.team_session_id,identity.submission_id,identity.decision_id])
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ source: { state: 'withdrawn' }, personal_claims: { confirmed: 1, current: 0 } })
    expect(await deliverySourceStatus(pool, { ...input, installationId: '99999999-9999-4999-8999-999999999999' })).toEqual({ source: null })
    expect(await deliverySourceStatus(pool, { ...input, decisionId: '99999999-9999-4999-8999-999999999999' })).toEqual({ source: null })
  })

  test('source status stops counting expired candidates before the expiry worker runs', async () => {
    const packet = records.slice(0, 3), identity = packet[0].payload.accepted_delivery
    const input = { installationId: PERSONAL, submissionId: identity.submission_id, decisionId: identity.decision_id }
    await enqueue(packet); await projector().projectOnce(PERSONAL); await extract(packet)
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { pending: 1 } })
    await pool.query("UPDATE memory_candidates SET created_at=clock_timestamp()-INTERVAL '336 hours' WHERE installation_id=$1", [PERSONAL])
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { pending: 0, stale: 0, rejected: 0 } })
    expect((await pool.query('SELECT status FROM memory_candidates WHERE installation_id=$1', [PERSONAL])).rows[0].status).toBe('validated')
  })

  test('source status does not label stale candidates or outdated extraction as reviewable', async () => {
    const packet = records.slice(0, 3), identity = packet[0].payload.accepted_delivery
    const input = { installationId: PERSONAL, submissionId: identity.submission_id, decisionId: identity.decision_id }
    await enqueue(packet); await projector().projectOnce(PERSONAL); await extract(packet)
    await pool.query("UPDATE work_episodes SET source_digest='new'::bytea WHERE installation_id=$1", [PERSONAL])
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { pending: 0, stale: 1 }, extraction_state: null })
    await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1", [PERSONAL])
    expect(await deliverySourceStatus(pool, input)).toEqual({ source: null })
  })

  test('source status reports rejected candidates and current failed extraction without inventing confirmation', async () => {
    const packet = records.slice(0, 3), identity = packet[0].payload.accepted_delivery
    const input = { installationId: PERSONAL, submissionId: identity.submission_id, decisionId: identity.decision_id }
    await enqueue(packet); await projector().projectOnce(PERSONAL); await extract(packet)
    const review = createReviewService(pool, createClaimRepository(pool))
    const candidate = (await review.reviewQueue({ installationId: PERSONAL }))[0]
    expect(await review.rejectCandidate({ installationId: PERSONAL, candidateId: candidate.candidate_id,
      expectedRevision: Number(candidate.revision) })).toMatchObject({ ok: true })
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ candidates: { rejected: 1, pending: 0 }, personal_claims: { confirmed: 0 } })
    await pool.query("UPDATE memory_extraction_runs SET state='failed' WHERE installation_id=$1", [PERSONAL])
    expect(await deliverySourceStatus(pool, input)).toMatchObject({ extraction_state: 'failed', personal_claims: { confirmed: 0 } })
  })

  test('revocation deletes pending candidates and replay cannot restore that submission or erase a different delivery', async () => {
    await enqueue(records)
    expect(await projector().projectOnce(PERSONAL)).toEqual({ projected: 6 })
    await extract(records.slice(0, 3))
    await enqueueRevocation(records[0].sessionId)
    expect(await projector().projectOnce(PERSONAL)).toEqual({ projected: 1 })
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_candidates')).rows[0].n).toBe(0)
    await enqueue(records.slice(0, 3))
    expect(await projector().projectOnce(PERSONAL)).toEqual({ projected: 3 })
    expect((await pool.query('SELECT DISTINCT session_id FROM source_events WHERE installation_id=$1', [PERSONAL])).rows)
      .toEqual([{ session_id: records[3].sessionId }])
    expect((await pool.query('SELECT data,projection_state FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id>7', [PERSONAL])).rows)
      .toEqual(Array.from({ length: 3 }, () => ({ data: {}, projection_state: 'purged' })))
  })

  test('a withdrawal observed by another reader prevents personal acceptance of an already extracted candidate', async () => {
    const packet = records.slice(0, 3)
    await enqueue(packet); await projector().projectOnce(PERSONAL); await extract(packet)
    const candidate = (await pool.query("SELECT candidate_id,revision::int FROM memory_candidates WHERE installation_id=$1 AND status='validated'", [PERSONAL])).rows[0]
    const source = packet[0].payload
    // Another reader's projector commits the global fence without purging this
    // installation. The existing local candidate must still fail acceptance.
    await pool.query(`INSERT INTO memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id)
      VALUES($1,$2,$3,$4)`, [source.team_id, source.team_session_id, source.accepted_delivery.submission_id, source.accepted_delivery.decision_id])
    const result = await createClaimRepository(pool).acceptCandidate({ installationId: PERSONAL,
      candidateId: candidate.candidate_id, expectedRevision: candidate.revision })
    expect(result.ok).toBe(false)
    expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims')).rows[0].n).toBe(0)
  })

  test('a revoke arriving before its source prevents subsequent compilation and candidate generation', async () => {
    await enqueueRevocation(records[0].sessionId)
    await enqueue(records.slice(0, 3))
    expect(await projector().projectOnce(PERSONAL)).toEqual({ projected: 4 })
    for (const table of ['source_events', 'source_turns', 'work_episodes', 'memory_candidates']) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0)
    }
  })

  test('malformed v2 packet fails closed without partial projection', async () => {
    const packet = structuredClone(records.slice(0, 3))
    packet[2].payload.accepted_delivery.decision = 'changes_requested'
    await enqueue(packet)
    await expect(projector().projectOnce(PERSONAL)).rejects.toThrow(/invalid accepted delivery/)
    expect((await pool.query('SELECT count(*)::int AS n FROM source_events')).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int AS n FROM memory_feed_inbox WHERE projection_state='pending'")).rows[0].n).toBe(3)
  })
})
