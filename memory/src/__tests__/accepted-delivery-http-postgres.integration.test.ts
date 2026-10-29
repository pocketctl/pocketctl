import { createDeliveryWithdrawalClient } from '../relay/delivery-withdrawal-client.js'
import { createDeliveryWithdrawalConsumer } from '../inbox/delivery-withdrawal-consumer.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase, memoryTestDatabaseConfig } from '../testing/test-db.js'
import { createRelayHttpClient } from '../relay/http-client.js'
import { createProviderTokenClient } from '../relay/token-client.js'
import { createFeedClient } from '../relay/feed-client.js'
import { createFeedConsumer } from '../inbox/feed-worker.js'
import { createSourceProjector } from '../projection/source-projector.js'
import { createPurgeRepository } from '../purge/repository.js'
import { createEpisodeRepository } from '../episodes/repository.js'
import { createCandidateExtractor } from '../extraction/extractor.js'
import { createExtractionRepository } from '../extraction/repository.js'
import { createCandidateDeduper } from '../extraction/deduper.js'
import { createClaimRepository } from '../claims/repository.js'
import { createPromotionService } from '../governance/promotion-service.js'
import { createPublicationService } from '../governance/publication-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import { createClaimIndexer } from '../retrieval/indexer.js'
import { createSearchService } from '../retrieval/search-service.js'
import { originContextFixture } from './helpers/origin-context-fixture.js'

const memoryUrl = process.env.MEMORY_TEST_DATABASE_URL, relayUrl = process.env.TEAM_DELIVERY_RELAY_TEST_DATABASE_URL
const suite = memoryUrl && relayUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip
// Cross-repository imports exist only in this integration test, never Memory runtime.
const relayModule = (path: string) => import(new URL(`../../../relay/src/${path}`, import.meta.url).href)
const statement = 'Transactional fixture invariant: replay preserves the accepted immutable revision.'

suite('accepted delivery across authenticated HTTP Feed/ACK and Memory (two isolated databases)', () => {
  let memory: pg.Pool, relay: pg.Pool, app: FastifyInstance | undefined
  beforeAll(async () => {
    memoryTestDatabaseConfig(memoryUrl!)
    const target = new URL(relayUrl!)
    if (target.hostname !== '127.0.0.1' || target.username !== 'pocketctl_delivery_relay_test'
      || target.pathname !== '/pocketctl_delivery_relay_test' || target.search) throw new Error('dedicated Relay delivery test database required')
    memory = new pg.Pool({ connectionString: memoryUrl, max: 8 })
    relay = new pg.Pool({ connectionString: relayUrl, max: 8 })
    await assertMemoryTestDatabase(memory, memoryUrl!)
    await assertMemoryTestDatabase(relay, relayUrl!)
    if ((await memory.query('SELECT current_database() AS db')).rows[0].db === 'pocketctl_delivery_relay_test') throw new Error('separate Memory test database required')
    await applyMemorySchema(memory)
    await (await relayModule('db.ts')).initDB(relay)
  }, 60_000)
  beforeEach(async () => {
    await relay.query('TRUNCATE team_delivery_memory_consumers,team_delivery_memory_withdrawals,extension_source_outbox,extension_feed,extension_providers,users,daemons RESTART IDENTITY CASCADE')
    await memory.query('TRUNCATE memory_delivery_withdrawal_checkpoint,memory_delivery_withdrawal_receipts,memory_team_delivery_withdrawals,memory_session_tombstones,memory_purge_receipts,memory_installations CASCADE')
  })
  afterEach(async () => { await app?.close(); app = undefined })
  afterAll(async () => { await memory?.end(); await relay?.end() })

  async function fixture() {
    const f = await (await relayModule('__tests__/fixtures/accepted-delivery-transaction.ts')).acceptedDeliveryTransactionFixture(relay)
    const credential = await (await relayModule('extensions/provider-auth.ts')).createProviderCredential(relay, { providerId: 'pocketctl-memory' })
    const deps = { pool: relay, mode: 'enabled', providerJwtSecret: 'delivery-http-test-secret-32-bytes', issuer: 'https://delivery-http.example.test' }
    app = Fastify({ logger: false })
    ;(await relayModule('extensions/provider-auth-routes.ts')).registerProviderTokenRoute(app, deps)
    ;(await relayModule('extensions/feed-routes.ts')).registerFeedRoutes(app, { ...deps, cursorSecret: 'delivery-http-cursor-test-only', leaseTtlSeconds: 3600 })
    ;(await relayModule('extensions/delivery-withdrawal-routes.ts')).registerDeliveryWithdrawalRoutes(app, { ...deps, cursorSecret: 'delivery-http-cursor-test-only', leaseTtlSeconds: 3600 })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const http = createRelayHttpClient({ baseUrl: address, timeoutMs: 5000, maxRetries: 0 })
    const tokens = createProviderTokenClient({ relayUrl: address, clientId: credential.clientId, clientSecret: credential.clientSecret, http })
    const feeds = createFeedClient({ http, tokens })
    // Scope authority is seeded as a fixture here; v2 discovery/grant issuance
    // is a separate acceptance gate. Content transport uses real HTTP auth.
    for (const [id, kind, scope] of [[f.personal[0], 'personal', f.personal[0]], [f.target, 'team', f.ownerScope]]) {
      await memory.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
        VALUES($1,'pocketctl-memory','active','ready',1)`, [id])
      await memory.query('INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$3)', [id, kind, scope])
    }
    await memory.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')", [f.personal[0]])
    const errors: unknown[] = []
    let loseAck = true
    const consumer = () => createFeedConsumer({ pool: memory, workerId: 'delivery-http', signal: new AbortController().signal,
      pullFeed: (id, limit) => feeds.pullFeed(id, limit),
      ackFeed: async input => {
        if (loseAck) { loseAck = false; throw new Error('injected disconnect before ACK') }
        return feeds.ackFeed(input)
      }, onError: error => errors.push(error) })
    const projector = createSourceProjector(memory, { stabilizationMs: 0, purge: createPurgeRepository(memory, { hmacKey: 'delivery-http-test' }) })
    const projectFeed = () => relayModule('extensions/feed-projector.ts').then(module => module.projectFeedBatch(relay, { batchSize: 100 }))
    const withdrawals = createDeliveryWithdrawalClient({ http, tokens })
    return { ...f, address, http, tokens, feeds, consumer, errors, projector, projectFeed, withdrawals, credential }
  }

  async function extractAndAccept(installationId: string, decisionId: string) {
    const source = (await memory.query('SELECT turn_id,data FROM memory_feed_inbox WHERE installation_id=$1 AND data->>\'source_role\'=\'reply\'', [installationId])).rows[0]
    expect(source.data.accepted_delivery.decision_id).toBe(decisionId)
    await createEpisodeRepository(memory, { stabilizationMs: 0, extractionDebounceMs: 0 }).compileTurn(installationId, source.turn_id)
    const episode = (await memory.query('SELECT summary,evidence_manifest FROM work_episodes WHERE installation_id=$1 AND turn_id=$2', [installationId, source.turn_id])).rows[0]
    expect(episode.summary.references.source.accepted_delivery.decision_id).toBe(decisionId)
    const handle = Object.entries(episode.evidence_manifest as Record<string, any>).find(([, e]) => e.source_provenance?.author_offer_id)?.[0]
    expect(handle).toBeTruthy()
    const extraction = createCandidateExtractor({ store: createExtractionRepository(memory), deduper: createCandidateDeduper(memory),
      provider: 'fixture', model: 'delivery-http-fixture', timeoutMs: 5000,
      textGenerator: { generateJson: (async () => ({ ok: true, value: { candidates: [{ claim_type: 'test_invariant', statement,
        confidence: 0.9, scope_kind: 'installation', scope_key: 'global', evidence_handles: [handle] }] },
        usage: { inputTokens: 1, outputTokens: 1, model: 'delivery-http-fixture' } })) as never } })
    expect(await extraction.extract({ installationId, turnId: source.turn_id, signal: new AbortController().signal })).toMatchObject({ kind: 'succeeded', candidateCount: 1 })
    expect((await memory.query('SELECT 1 FROM knowledge_claims')).rowCount).toBe(0)
    const candidate = (await memory.query("SELECT candidate_id,revision::int FROM memory_candidates WHERE installation_id=$1 AND status='validated'", [installationId])).rows[0]
    const accepted = await createClaimRepository(memory).acceptCandidate({ installationId, candidateId: candidate.candidate_id, expectedRevision: candidate.revision })
    if (!accepted.ok) throw new Error('candidate acceptance failed')
    const evidence = (await memory.query('SELECT evidence_id,locator FROM knowledge_evidence WHERE installation_id=$1 AND version_id=$2', [installationId, accepted.versionId])).rows[0]
    expect(evidence.locator.source_provenance.accepted_delivery.decision_id).toBe(decisionId)
    return { ...accepted, evidenceId: evidence.evidence_id }
  }

  test.each(['personal-feed', 'all-personal-installations-removed'])('acceptance → HTTP/ACK → explicit review → Context → withdrawal via %s', async mode => {
    const f = await fixture(), personal = f.personal[0] as string
    expect((await fetch(`${f.address}/api/extensions/v1/feed?installation_id=${personal}`)).status).toBe(401)
    const decision = await f.delivery.decide(f.taskId, f.users[1], f.decision)
    expect(await f.projectFeed()).toMatchObject({ projected: 6, skipped: false })
    // First pass persists the real HTTP batch but loses ACK. A fresh consumer
    // retries from Relay's checkpoint, deduplicating rather than dropping it.
    await f.consumer().runOnce()
    expect(f.errors).toHaveLength(1)
    expect((await relay.query('SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id=$1', [personal])).rows[0].ack_feed_id).toBe('0')
    expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1', [personal])).rowCount).toBe(3)
    f.errors.length = 0; f.tokens.invalidate()
    await f.consumer().runOnce()
    expect(f.errors).toEqual([])
    const checkpoint = (await relay.query('SELECT ack_feed_id::text FROM extension_checkpoints WHERE installation_id=$1', [personal])).rows[0].ack_feed_id
    expect(Number(checkpoint)).toBeGreaterThan(0)
    expect((await memory.query('SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1', [personal])).rowCount).toBe(3)
    expect((await f.feeds.pullFeed(personal, 100)).items).toEqual([])
    expect(await f.projector.projectOnce(personal)).toEqual({ projected: 3 })
    const claim = await extractAndAccept(personal, decision.decision_id)
    const proposer = randomUUID(), reviewer = randomUUID(), publisher = randomUUID()
    for (const [id, role] of [[proposer, 'contributor'], [reviewer, 'reviewer'], [publisher, 'scope_administrator']]) {
      await memory.query('INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,$3)', [f.target, id, [role]])
    }
    const grant = (member: string, permissions: string[]): ValidatedV2Grant => ({ primaryInstallationId: f.target, configVersion: '1', scopeBindings: [
      { installation_id: personal, owner_scope_kind: 'personal', owner_scope_id: personal, membership_id: null, membership_revision: '0', authorization_epoch: '1', permissions: ['read'] },
      { installation_id: f.target, owner_scope_kind: 'team', owner_scope_id: f.ownerScope, membership_id: member, membership_revision: '1', authorization_epoch: '1', permissions },
    ] })
    const proposal = await createPromotionService(memory).propose({ grant: grant(proposer, ['read', 'contribute']),
      sourceInstallationId: personal, sourceClaimId: claim.claimId, evidenceIds: [claim.evidenceId], idempotencyDigest: randomUUID() })
    expect((await memory.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1', [f.target])).rowCount).toBe(0)
    const publication = createPublicationService(memory)
    await publication.decide({ grant: grant(reviewer, ['read', 'review']), targetInstallationId: f.target, candidateId: proposal.candidate.candidate_id,
      expectedCandidateRevision: proposal.candidate.revision, decision: 'approve' })
    const shared = await publication.publish({ grant: grant(publisher, ['read', 'publish']), targetInstallationId: f.target,
      candidateId: proposal.candidate.candidate_id, expectedCandidateRevision: proposal.candidate.revision, resolution: 'new' })
    await createClaimIndexer({ pool: memory }).indexVersion(f.target, shared.versionId, new AbortController().signal)
    const search = createSearchService({ pool: memory, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'delivery-http-test' })
    expect((await search.search({ installationId: f.target, query: 'Transactional fixture' })).hits).toHaveLength(1)
    const ctx = await originContextFixture(memory, f.target), pack = await ctx.compile()
    if (pack.kind !== 'ready') throw new Error('Context not ready')
    const ticket = await ctx.admit(pack.packId)
    if (!ticket.ok || !('nonce' in ticket)) throw new Error('Context not admitted')
    const text = await ctx.consume(pack.packId, ticket.injectionId, ticket.nonce)
    if (!text.ok) throw new Error('Context not consumed')
    expect(text.pack.stableText + text.pack.dynamicText).toContain(statement)
    // Disabling subscriptions/scopes must not suppress privacy controls.
    f.setCapture(false)
    await relay.query("UPDATE extension_installations SET subscriptions='{}',granted_scopes='{}' WHERE installation_id=$1", [personal])
    if (mode === 'all-personal-installations-removed') {
      await createDeliveryWithdrawalConsumer({ pool: memory, signal: new AbortController().signal, ...f.withdrawals }).runOnce()
      const identity = (await memory.query('SELECT consumer_id FROM memory_delivery_withdrawal_checkpoint')).rows[0].consumer_id
      await relay.query("DELETE FROM extension_installations WHERE owner_scope_kind='personal'")
      await createPurgeRepository(memory, { hmacKey: 'delivery-http-test' }).purgeInstallation({ installationId: personal, requestId: randomUUID(), reason: 'test_personal_removed' })
      expect((await memory.query('SELECT consumer_id FROM memory_delivery_withdrawal_checkpoint')).rows[0].consumer_id).toBe(identity)
    }
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-http', expected_revision: 3, reason: 'invalid evidence' })
    expect(await f.projectFeed()).toMatchObject({ projected: 2, skipped: false })
    if (mode === 'personal-feed') {
      await f.consumer().runOnce(); expect(f.errors).toEqual([])
      expect((await memory.query("SELECT 1 FROM memory_feed_inbox WHERE installation_id=$1 AND topic='session.access.revoked.v1'", [personal])).rowCount).toBe(1)
      expect(await f.projector.projectOnce(personal)).toEqual({ projected: 1 })
    } else {
      const makeConsumer = (ack = f.withdrawals.ack) => createDeliveryWithdrawalConsumer({ pool: memory, signal: new AbortController().signal, pull: f.withdrawals.pull, ack })
      await expect(makeConsumer(async () => { throw new Error('lost independent ACK') }).runOnce()).rejects.toThrow('lost independent ACK')
      const persisted = (await memory.query('SELECT consumer_id,last_sequence::text,last_ack_sequence::text FROM memory_delivery_withdrawal_checkpoint')).rows[0]
      expect(BigInt(persisted.last_sequence)).toBeGreaterThan(0n); expect(persisted.last_ack_sequence).toBe('0')
      expect((await relay.query('SELECT ack_sequence::text FROM team_delivery_memory_consumers WHERE consumer_id=$1', [persisted.consumer_id])).rows[0].ack_sequence).toBe('0')
      // The shared copy is blocked before the failed ACK is retried.
      expect((await search.search({ installationId: f.target, query: 'Transactional fixture' })).hits).toEqual([])
      expect(await makeConsumer().runOnce()).toEqual({ applied: 0, skipped: false })
      expect((await memory.query('SELECT count(*)::int AS n FROM memory_delivery_withdrawal_receipts')).rows[0].n).toBe(1)
      expect((await relay.query('SELECT ack_sequence::text FROM team_delivery_memory_consumers WHERE consumer_id=$1', [persisted.consumer_id])).rows[0].ack_sequence).toBe(persisted.last_sequence)
      // A separate database consumer must hydrate history despite all personal
      // installations being gone and another consumer having already ACKed.
      const fresh = await f.withdrawals.pull(randomUUID(), '0')
      expect(fresh.items).toHaveLength(1)
      expect(Object.keys(fresh.items[0]).sort()).toEqual(['decision_id','recorded_at','sequence','submission_id','team_id','team_session_id'])
      // Restoring an older Memory checkpoint with the same consumer identity
      // must replay below the Relay ACK instead of silently skipping history.
      await memory.query('TRUNCATE memory_team_delivery_withdrawals,memory_delivery_withdrawal_receipts')
      await memory.query('UPDATE memory_delivery_withdrawal_checkpoint SET last_sequence=0,last_ack_sequence=0')
      expect(await makeConsumer().runOnce()).toEqual({ applied: 1, skipped: false })
    }
    expect((await memory.query('SELECT count(*)::int AS n FROM memory_team_delivery_withdrawals')).rows[0].n).toBe(1)
    expect((await search.search({ installationId: f.target, query: 'Transactional fixture' })).hits).toEqual([])
    expect((await ctx.compile()).kind).toBe('empty')
    if (mode === 'personal-feed') expect((await f.feeds.pullFeed(personal, 100)).items).toEqual([])
    expect((await memory.query('SELECT statement FROM knowledge_versions WHERE version_id=$1', [shared.versionId])).rows[0].statement).toBe(statement)
  }, 60_000)
  test.each(['tampered-cursor','wrong-consumer','wrong-lease','expired-lease','lease-takeover','legacy-cursor'])('independent ACK rejects %s without advancing the checkpoint', async fault => {
    const f = await fixture(), consumer = randomUUID()
    await f.delivery.decide(f.taskId, f.users[1], f.decision)
    await f.delivery.revokeArtifact(f.taskId, f.users[0], f.submissionId, 'proof', { request_id: 'withdraw-protocol', expected_revision: 3, reason: 'invalid evidence' })
    const batch = await f.withdrawals.pull(consumer, '0')
    expect(batch.items).toHaveLength(1)
    if (fault === 'tampered-cursor') batch.next_cursor += 'x'
    if (fault === 'wrong-consumer') batch.consumer_id = randomUUID()
    if (fault === 'wrong-lease') batch.lease_token = 'wrong-lease'
    if (fault === 'expired-lease') await relay.query("UPDATE team_delivery_memory_consumers SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE consumer_id=$1", [consumer])
    if (fault === 'lease-takeover') await f.withdrawals.pull(consumer, '0')
    if (fault === 'legacy-cursor') batch.next_cursor = (await relayModule('extensions/cursor.ts')).encodeFeedCursor({ v: 1, installation_id: consumer,
      feed_id: batch.through_sequence, lease_epoch: '1', config_version: '1', filter_hash: '', exp: Math.floor(Date.now()/1000)+60 }, 'delivery-http-cursor-test-only')
    await expect(f.withdrawals.ack(batch)).rejects.toMatchObject({ code: ['tampered-cursor','wrong-consumer','legacy-cursor'].includes(fault) ? 'cursor_expired' : 'stale_lease' })
    expect((await relay.query('SELECT ack_sequence::text FROM team_delivery_memory_consumers WHERE consumer_id=$1', [consumer])).rows[0].ack_sequence).toBe('0')
    const retry = await f.withdrawals.pull(consumer, '0')
    expect(await f.withdrawals.ack(retry)).toBe(retry.through_sequence)
    expect(await f.withdrawals.ack(retry)).toBe(retry.through_sequence)
  })

  test('independent stream rejects anonymous, foreign-provider and revoked credentials', async () => {
    const f = await fixture(), path = '/api/extensions/v1/team-delivery-withdrawals?consumer_id=' + randomUUID()
    expect((await fetch(f.address + path)).status).toBe(401)
    const foreign = (await relayModule('extensions/provider-auth.ts')).signProviderExtensionToken({ providerId: 'different-provider', credentialId: randomUUID(),
      secret: 'delivery-http-test-secret-32-bytes', issuer: 'https://delivery-http.example.test' })
    await expect(f.http.request('GET', path, { token: foreign })).rejects.toMatchObject({ status: 403 })
    const token = await f.tokens.get()
    await relay.query("UPDATE extension_provider_credentials SET status='revoked',revoked_at=NOW() WHERE credential_id=$1", [f.credential.credentialId])
    await expect(f.http.request('GET', path, { token })).rejects.toMatchObject({ status: 401 })
    expect((await relay.query('SELECT 1 FROM team_delivery_memory_consumers')).rowCount).toBe(0)
  })

  test('provider stream pages monotonically, refuses future skips, and replays below a restored checkpoint', async () => {
    const f = await fixture(), consumer = randomUUID(), token = await f.tokens.get()
    const writer = await relayModule('team/delivery-withdrawal-ledger.ts'), client = await relay.connect()
    try {
      await client.query('BEGIN')
      for (let n = 0; n < 2; n++) await writer.recordDeliveryWithdrawal(client, { team_id: f.teamId, team_session_id: f.session.id, submission_id: randomUUID(), decision_id: randomUUID() })
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    const pull = (after: string) => f.http.request('GET', `/api/extensions/v1/team-delivery-withdrawals?consumer_id=${consumer}&limit=1&after_sequence=${after}`, { token }) as Promise<any>
    const first = await pull('9223372036854775807'); expect(first.items).toHaveLength(1)
    expect(await f.withdrawals.ack(first)).toBe(first.through_sequence)
    const second = await pull(first.through_sequence); expect(second.items).toHaveLength(1)
    expect(BigInt(second.through_sequence)).toBeGreaterThan(BigInt(first.through_sequence))
    expect(await f.withdrawals.ack(second)).toBe(second.through_sequence)
    const replay = await pull('0'); expect(replay.items).toEqual(first.items)
    expect(await f.withdrawals.ack(replay)).toBe(second.through_sequence)
    expect((await pull(second.through_sequence)).items).toEqual([])
  })

})
