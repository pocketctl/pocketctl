import type pg from 'pg'
import {expect, test, vi} from 'vitest'
import {buildEpisodePacket} from '../../episodes/packet.js'
import {assertExactSourceEpisode} from '../../migrations/shared-forward/forward-exact-source.js'
import type {CleanupDependencies} from '../../migrations/shared-forward/forward-cleanup-state.js'

const installationId = '10000000-0000-4000-8000-000000000098'
const sourceId = '20000000-0000-4000-8000-000000000098'
const dependencies: CleanupDependencies = {
  roots: [], installationIds: [installationId], broadIds: [], sourceEventIds: [sourceId],
  artifactIds: [], episodeIds: [], candidateIds: [], packIds: [], injectionIds: [], bundleIds: [],
}

function packetFixture() {
  const packet = buildEpisodePacket({
    installationId, sessionId: 'fixture-session', turnId: 'fixture-turn',
    outcome: 'completed', reason: null, artifacts: [], repository: null,
    events: [{
      source_event_id: sourceId, event_type: 'user_message',
      occurred_at: new Date('2026-11-12T00:00:00Z'), payload_hash: Buffer.alloc(32, 1),
      classification: {}, payload: {text: 'Verify the shared source watermark.'},
    }],
  })
  const manifestEntry = Object.values(packet.manifest).find(entry => entry.source_event_id === sourceId)
  if (!manifestEntry) throw Error('fixture_event_evidence_missing')
  return {
    installation_id: installationId, episode_id: '30000000-0000-4000-8000-000000000098',
    document_compiler_version: packet.compilerVersion, evidence_manifest: packet.manifest, manifestEntry,
  }
}

test('validates the actual packet digest and exact source ownership', async () => {
  const episode = packetFixture()
  expect(episode.manifestEntry.excerpt_hash).toMatch(/^[a-f0-9]{16}$/)
  const query = vi.fn(async () => ({rows: [{installation_id: installationId}]}))
  await expect(assertExactSourceEpisode({query} as unknown as pg.Client, dependencies, [], episode))
    .resolves.toBeUndefined()
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE source_event_id=$1::uuid'), [sourceId, null])
})

test('preserves full digest compatibility and rejects malformed digests', async () => {
  const episode = packetFixture()
  const query = vi.fn(async () => ({rows: [{installation_id: installationId}]}))
  const client = {query} as unknown as pg.Client
  for (const entry of Object.values(episode.evidence_manifest)) entry.excerpt_hash = 'a'.repeat(64)
  await expect(assertExactSourceEpisode(client, dependencies, [], episode)).resolves.toBeUndefined()
  query.mockClear()
  episode.manifestEntry.excerpt_hash = 'a'.repeat(32)
  await expect(assertExactSourceEpisode(client, dependencies, [], episode))
    .rejects.toThrow('cleanup_exact_source_manifest_unparsed')
  expect(query).not.toHaveBeenCalled()
})

test('a valid packet digest cannot attest a cross-installation source', async () => {
  const episode = packetFixture()
  const query = vi.fn(async () => ({rows: [{installation_id: '40000000-0000-4000-8000-000000000098'}]}))
  await expect(assertExactSourceEpisode({query} as unknown as pg.Client, dependencies, [], episode))
    .rejects.toThrow('cleanup_exact_source_cross_owner_unproven')
})
