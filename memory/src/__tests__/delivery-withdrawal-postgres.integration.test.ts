import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { governanceFixture } from '../testing/governance-fixture.js'
import { adaptTeamSource } from '../episodes/team-source-adapter.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createPublicationService } from '../governance/publication-service.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createMemoryReadService } from '../retrieval/read-service.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createClaimIndexer } from '../retrieval/indexer.js'
import { contextClaimFacts, eligibleContextFacts } from '../context/consumption.js'
import { createAdmissionService } from '../context/admission-service.js'
import { originContextFixture } from './helpers/origin-context-fixture.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const suite = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
suite('accepted delivery withdrawal fences retained and shared knowledge', () => {
  let pool: pg.Pool, feedId = 0
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 })
    await assertMemoryTestDatabase(pool, url!); await applyMemorySchema(pool)
  }, 60_000)
  beforeEach(async () => {
    await pool.query('TRUNCATE memory_team_delivery_withdrawals,memory_session_tombstones,memory_installations CASCADE')
    feedId = 0
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const f = await governanceFixture(pool)
    const producer = await import(new URL('../../../relay/src/team/accepted-delivery-memory-source.ts', import.meta.url).href)
    const fixtures = await import(new URL('../../../relay/src/__tests__/fixtures/accepted-delivery-memory.ts', import.meta.url).href)
    const input = fixtures.acceptedDeliveryFixture()
    input.submission.id = randomUUID(); input.decision.id = randomUUID()
    input.binding.installationId = f.team; input.binding.ownerScopeId = f.team
    const record = producer.buildAcceptedDeliveryMemorySourceRecords(input)[1]
    const adapted = adaptTeamSource({ source_kind: record.sourceKind, source_id: record.sourceId,
      session_id: record.sessionId, turn_id: record.payload.turn_id, event_type: record.eventType,
      recorded_at: record.occurredAt, classification: {}, data: record.payload })!
    const capsule = randomUUID()
    await pool.query(`INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash)
      VALUES($1,$2,$3,'user_accepted',sha256('accepted-delivery'::bytea))`, [capsule, f.personal, f.version])
    await pool.query("UPDATE knowledge_evidence SET capsule_id=$2,episode_id=NULL,evidence_kind='accepted_excerpt',locator=$3::jsonb WHERE evidence_id=$1",
      [f.evidence, capsule, JSON.stringify({ source_provenance: adapted.provenance })])
    const control = {
      reason: 'artifact_revoked', team_delivery_source_revoked: true,
      team_id: input.teamId, team_session_id: input.teamSessionId,
      submission_id: input.submission.id, decision_id: input.decision.id,
      team_memory_binding_id: input.binding.id, team_memory_binding_revision: input.binding.revision,
      participant_user_id: 7, participant_revision: 1,
    }
    return { ...f, input, record, control, producer }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  async function control(f: Fixture, accessOnly = false) {
    await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,
      session_id,event_type,recorded_at,classification,data,payload_hash)
      VALUES($1,$2,1,'session.access.revoked.v1','session_access_revoked',$3,$4,'session_access_revoked',NOW(),'{}',$5::jsonb,sha256(convert_to($5::text,'utf8')))`,
    [f.personal, ++feedId, `team-delivery-${accessOnly ? 'revoke' : 'withdraw'}:${f.record.sessionId}`,
      f.record.sessionId, JSON.stringify({ ...f.control, ...(accessOnly ? { reason: 'participant_removed' } : {}) })])
    return createSourceProjector(pool, { purge: createPurgeRepository(pool, { hmacKey: 'delivery-withdrawal-test' }) }).projectOnce(f.personal)
  }
  async function published(f: Fixture) {
    const proposal = await f.approved()
    return createPublicationService(pool).publish({ grant: f.grant(f.publisher, ['read', 'publish']),
      targetInstallationId: f.team, candidateId: proposal.candidate.candidate_id,
      expectedCandidateRevision: proposal.candidate.revision, resolution: 'new' })
  }
  const frame = { repositoryId: null, repoSnapshotId: null, branch: null, taskScopeKey: null }
  const facts = async (installation: string, version: string) => eligibleContextFacts((await contextClaimFacts(pool, installation, [version])).get(version)!, frame)

  test('access revoke retains an accepted capsule; later delivery withdrawal denies personal and reviewed shared copies and an admitted Context', async () => {
    const f = await fixture(), shared = await published(f), unaffected = await fixture()
    const read = createMemoryReadService(pool, 'delivery-withdrawal-test')
    expect(await read.getEvidence(f.personal, f.evidence)).not.toBeNull()
    const indexer = createClaimIndexer({ pool })
    await indexer.indexVersion(f.team, shared.versionId, new AbortController().signal)
    const search = createSearchService({ pool, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'delivery-withdrawal-test' })
    expect((await search.search({ installationId: f.team, query: 'Transactional fixture' })).hits).toHaveLength(1)
    const context = await originContextFixture(pool, f.team), pack = await context.compile()
    expect(pack.kind).toBe('ready'); if (pack.kind !== 'ready') throw new Error('Context fixture unavailable')
    const ticket = await context.admit(pack.packId)
    expect(ticket.ok).toBe(true); if (!ticket.ok || !('nonce' in ticket)) throw new Error('Context fixture not admitted')
    await control(f, true)
    expect(await read.getEvidence(f.personal, f.evidence)).not.toBeNull()
    expect(await facts(f.team, shared.versionId)).toBe(true)
    await control(f)
    expect(await read.getEvidence(f.personal, f.evidence)).toBeNull()
    expect(await facts(f.personal, f.version)).toBe(false)
    expect(await facts(f.team, shared.versionId)).toBe(false)
    expect(await facts(unaffected.personal, unaffected.version)).toBe(true)
    expect((await search.search({ installationId: f.team, query: 'Transactional fixture' })).hits).toEqual([])
    expect((await search.search({ installationId: f.team, query: 'Transactional fixture', asOf: new Date() })).hits).toEqual([])
    expect(await context.consume(pack.packId, ticket.injectionId, ticket.nonce)).toEqual({ ok: false, error: 'expired' })
    // Same request must not reuse the ready pack compiled before withdrawal.
    expect((await context.compile()).kind).toBe('empty')
    await indexer.indexVersion(f.team, shared.versionId, new AbortController().signal)
    expect((await search.search({ installationId: f.team, query: 'Transactional fixture' })).hits).toEqual([])
    // Original acceptance/reviewed Version bodies remain truthful audit history.
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1', [shared.versionId])).rows[0].statement).toBe('Transactional fixture invariant')
    await control(f)
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_team_delivery_withdrawals')).rows[0].n).toBe(1)
  })

  test('reviewed delivery produces actual Context text, but its withdrawal survives personal installation purge', async () => {
    const f = await fixture(), shared = await published(f)
    const context = await originContextFixture(pool, f.team), pack = await context.compile()
    if (pack.kind !== 'ready') throw new Error('Context fixture unavailable')
    const ticket = await context.admit(pack.packId)
    if (!ticket.ok || !('nonce' in ticket)) throw new Error('Context fixture not admitted')
    const consumed = await context.consume(pack.packId, ticket.injectionId, ticket.nonce)
    expect(consumed.ok).toBe(true)
    if (!consumed.ok) throw new Error('Context fixture text unavailable')
    expect(consumed.pack.stableText + consumed.pack.dynamicText).toContain('Transactional fixture invariant')
    await control(f)
    await createPurgeRepository(pool, { hmacKey: 'delivery-withdrawal-test' }).purgeInstallation({
      installationId: f.personal, requestId: randomUUID(), reason: 'test_personal_installation_removed',
    })
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_team_delivery_withdrawals')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1', [shared.versionId])).rows[0].statement).toBe('Transactional fixture invariant')
    expect(await facts(f.team, shared.versionId)).toBe(false)
    expect((await context.compile()).kind).toBe('empty')
  })

  test.each(['propose', 'review', 'publish'])('withdrawn evidence cannot pass the %s boundary', async boundary => {
    const f = await fixture()
    const proposal = boundary === 'publish' ? await f.approved() : boundary === 'review' ? await f.proposed() : null
    await control(f)
    if (boundary === 'propose') await expect(createPromotionService(pool).propose(f.proposeInput)).rejects.toMatchObject({ code: 'source_not_active' })
    if (boundary === 'review') await expect(createPublicationService(pool).decide({ grant: f.grant(f.reviewer, ['read', 'review']),
      targetInstallationId: f.team, candidateId: proposal!.candidate.candidate_id, expectedCandidateRevision: proposal!.candidate.revision, decision: 'approve' })).rejects.toMatchObject({ code: 'evidence_missing' })
    if (boundary === 'publish') await expect(createPublicationService(pool).publish({ grant: f.grant(f.publisher, ['read', 'publish']),
      targetInstallationId: f.team, candidateId: proposal!.candidate.candidate_id, expectedCandidateRevision: proposal!.candidate.revision, resolution: 'new' })).rejects.toMatchObject({ code: 'evidence_missing' })
    expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1', [f.team])).rowCount).toBe(0)
  })

  test('a delayed reader packet cannot resurrect withdrawn source content under a different projection session', async () => {
    const f = await fixture(); await control(f)
    const packet = f.producer.buildAcceptedDeliveryMemorySourceRecords({ ...f.input, readers: [{ userId: 8, participantRevision: 3 }] })
    for (const record of packet) await pool.query(`INSERT INTO memory_feed_inbox(installation_id,feed_id,envelope_version,topic,source_kind,source_id,
      session_id,turn_id,event_type,recorded_at,classification,data,payload_hash)
      VALUES($1,$2,1,'session.event.v1',$3,$4,$5,$6,$7,$8,'{}',$9::jsonb,sha256(convert_to($9::text,'utf8')))`,
    [f.personal, ++feedId, record.sourceKind, record.sourceId, record.sessionId, record.payload.turn_id, record.eventType, record.occurredAt, JSON.stringify(record.payload)])
    expect(await createSourceProjector(pool, { purge: createPurgeRepository(pool, { hmacKey: 'delivery-withdrawal-test' }) }).projectOnce(f.personal)).toEqual({ projected: 3 })
    expect((await pool.query('SELECT 1 FROM source_events WHERE installation_id=$1', [f.personal])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1 AND feed_id>1', [f.personal])).rowCount).toBe(0)
    expect((await pool.query('SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2', [f.personal, packet[0].sessionId])).rowCount).toBe(1)
  })

  test('withdrawal between Context precheck and the final nonce transition cannot return frozen text', async () => {
    const f = await fixture(); await published(f)
    const context = await originContextFixture(pool, f.team), pack = await context.compile()
    if (pack.kind !== 'ready') throw new Error('Context fixture unavailable')
    const ticket = await context.admit(pack.packId)
    if (!ticket.ok || !('nonce' in ticket)) throw new Error('Context fixture not admitted')
    let intercepted = false
    const hooked = { ...pool, connect: async () => {
      const client = await pool.connect()
      return new Proxy(client, { get(target, key) {
        if (key === 'query') return async (...args: unknown[]) => {
          if (!intercepted && typeof args[0] === 'string' && /UPDATE memory_context_injections j\s+SET state = 'prepared'/.test(args[0])) {
            intercepted = true; await control(f)
          }
          return Reflect.apply(target.query, target, args)
        }
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as unknown as pg.Pool
    const result = await createAdmissionService({ pool: hooked, nonceHmacKey: Buffer.alloc(32, 7) }).consume({
      installationId: f.team, sessionId: 'origin-context-session', packId: pack.packId, injectionId: ticket.injectionId, nonce: ticket.nonce })
    expect(intercepted).toBe(true)
    expect(result).toEqual({ ok: false, error: 'expired' })
  })
})
