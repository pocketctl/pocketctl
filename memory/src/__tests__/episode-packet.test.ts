import { describe, expect, test } from 'vitest'
import {
  buildEpisodePacket,
  canonicalPacketJson,
  computeSourceDigest,
  EPISODE_PACKET_COMPILER_VERSION,
  type PacketSourceArtifact,
  type PacketSourceEvent,
} from '../episodes/packet.js'
import { redactSecrets, sanitizeText, describeEvent, basenameOnly } from '../episodes/content-policy.js'

function event(index: number, type: string, payload: Record<string, unknown>, at = index): PacketSourceEvent {
  return {
    source_event_id: `ev-${String(index).padStart(3, '0')}`,
    event_type: type,
    occurred_at: new Date(Date.UTC(2026, 7, 24, 10, 0, 0) + at * 1000),
    payload_hash: Buffer.from([index]),
    payload,
    classification: {},
  }
}

function artifact(index: number, type: string, extra: Partial<PacketSourceArtifact> = {}): PacketSourceArtifact {
  return {
    artifact_id: `art-${index}`,
    artifact_type: type,
    identity_key: extra.identity_key ?? `id-${index}`,
    path: extra.path ?? null,
    status: extra.status ?? null,
    details: extra.details ?? {},
    source_event_id: extra.source_event_id ?? 'ev-001',
    ...extra,
  }
}

const BASE = {
  installationId: '11111111-1111-4111-8111-111111111111',
  sessionId: 'ses-1',
  turnId: 'turn-1',
  outcome: 'completed',
  reason: 'done',
}

const FULL_EVENTS: readonly PacketSourceEvent[] = Object.freeze([
  event(1, 'user_goal', { text: 'Fix the login flake in auth.test.ts' }),
  event(2, 'tool_call', { tool: 'read', call_id: 'c1' }),
  event(3, 'tool_result', { call_id: 'c1', status: 'ok' }),
  event(4, 'file_change', { file_path: 'src/auth.ts', change_type: 'modified', lines_added: 12, lines_removed: 4 }),
  event(5, 'code_symbol', { symbol: 'verifyToken', kind: 'function', path: 'src/auth.ts' }),
  event(6, 'test_result', { test_run_id: 't1', name: 'auth.test.ts', status: 'failed' }),
  event(7, 'ci_result', { name: 'ci', status: 'completed', conclusion: 'failure' }),
  event(8, 'approval', { approval_id: 'a1', status: 'approved' }),
  event(9, 'correction', { text: 'No, use the token clock skew tolerance' }),
  event(10, 'retry', { text: 'rerun suite' }),
  event(11, 'tool_result', { call_id: 'c2', status: 'error' }),
  event(12, 'hypothesis_rejected', { text: 'DNS timeout theory disproved' }),
  event(13, 'turn_status', { turn_status: 'completed', turn_reason: 'done' }),
])

const FULL_ARTIFACTS: readonly PacketSourceArtifact[] = Object.freeze([
  artifact(1, 'file_change', {
    identity_key: 'src/auth.ts', path: 'src/auth.ts', status: 'modified',
    details: { lines_added: 12, lines_removed: 4 }, source_event_id: 'ev-004',
  }),
])

describe('episode packet golden fixtures', () => {
  test('captures goal, repository, files, symbols, tools, tests, CI, approvals, corrections, retries, failures, final and incomplete', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      events: FULL_EVENTS,
      artifacts: FULL_ARTIFACTS,
      repository: {
        repository_id: '33333333-3333-4333-8333-333333333333',
        repo_snapshot_id: '44444444-4444-4444-8444-444444444444',
        commit_sha: 'abc123def4567890',
        branch: 'main',
        worktree_identity: 'wt-1',
      },
    })
    const doc = packet.document
    expect(doc.schema_version).toBe(1)
    expect(doc.objective[0]?.text).toBe('Fix the login flake in auth.test.ts')
    expect(doc.repository).toEqual({
      repository_id: '33333333-3333-4333-8333-333333333333',
      repo_snapshot_id: '44444444-4444-4444-8444-444444444444',
      commit_sha: 'abc123def4567890',
      branch: 'main',
      worktree_identity: 'wt-1',
    })
    expect(doc.files[0]?.text).toContain('modified src/auth.ts (+12/-4)')
    expect(doc.symbols[0]?.text).toContain('verifyToken')
    expect(doc.timeline.some(entry => entry.kind === 'tool_call')).toBe(true)
    expect(doc.tests).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ])
    expect(doc.approvals.length).toBe(1)
    expect(doc.corrections[0]?.text).toContain('token clock skew tolerance')
    expect(doc.failures.length).toBe(1)
    expect(doc.final_outcome?.text).toContain('completed')
    expect(doc.incomplete).toEqual([])

    // Every statement handle resolves to a manifest entry.
    const handles = new Set<string>()
    for (const statement of [
      ...doc.objective, ...doc.files, ...doc.symbols, ...doc.approvals,
      ...doc.corrections, ...doc.failures, ...doc.incomplete,
      ...doc.tests.map(({ evidence_handle }) => ({ evidence_handle })),
    ]) handles.add(statement.evidence_handle)
    for (const entry of doc.timeline) handles.add(entry.evidence_handle)
    if (doc.final_outcome) handles.add(doc.final_outcome.evidence_handle)
    for (const handle of handles) {
      expect(packet.manifest[handle], `manifest entry for ${handle}`).toBeDefined()
    }
  })

  test('an unfinished outcome records an incomplete statement', () => {
    const packet = buildEpisodePacket({
      ...BASE, outcome: 'interrupted', reason: 'user stopped',
      events: FULL_EVENTS.slice(0, 3), artifacts: [], repository: null,
    })
    expect(packet.document.final_outcome?.text).toContain('interrupted')
    expect(packet.document.incomplete[0]?.text).toContain('unfinished')
  })

  test('identical input is byte-identical; any event change moves the digest', () => {
    const first = buildEpisodePacket({ ...BASE, events: FULL_EVENTS, artifacts: FULL_ARTIFACTS, repository: null })
    const second = buildEpisodePacket({ ...BASE, events: FULL_EVENTS, artifacts: FULL_ARTIFACTS, repository: null })
    expect(canonicalPacketJson(second.document)).toBe(canonicalPacketJson(first.document))
    expect(second.sourceDigest.equals(first.sourceDigest)).toBe(true)
    expect(second.compilerVersion).toBe(EPISODE_PACKET_COMPILER_VERSION)

    const changed = buildEpisodePacket({
      ...BASE,
      events: [...FULL_EVENTS.slice(0, 5), event(99, 'file_change', { file_path: 'src/other.ts' })],
      artifacts: FULL_ARTIFACTS, repository: null,
    })
    expect(changed.sourceDigest.equals(first.sourceDigest)).toBe(false)
  })

  test('event ordering derives from occurrence time, not input order', () => {
    const shuffled = [...FULL_EVENTS].reverse()
    const packet = buildEpisodePacket({ ...BASE, events: shuffled, artifacts: [], repository: null })
    expect(packet.document.objective[0]?.text).toBe('Fix the login flake in auth.test.ts')
    const firstTimeline = packet.document.timeline[0]
    expect(firstTimeline?.kind).toBe('user_goal')
  })

  test('repository identity never comes from cwd or absolute paths', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      events: [
        event(1, 'session_status', { cwd: '/Users/alice/secret/project', worktree_path: '/Users/alice/secret/project' }),
        event(2, 'file_change', { file_path: '/abs/path/src/a.ts' }),
      ],
      artifacts: [],
      repository: null,
    })
    expect(packet.document.repository.repository_id).toBeNull()
    expect(JSON.stringify(packet.document)).not.toContain('/Users/alice')
    // Absolute file paths appear basename-only.
    const serialized = JSON.stringify(packet.document)
    expect(serialized).not.toContain('/abs/path/')
    expect(serialized).toContain('src/a.ts')
  })

  test('absolute paths embedded in free text are minimized before model export', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      outcome: 'failed',
      reason: 'see C:\\Users\\alice\\private\\project\\failure.log',
      events: [event(1, 'user_goal', {
        text: 'open "/Users/alice/My Project/src/auth.ts", file:///Users/alice/private/project/src/token.ts, and vscode://file/Users/alice/private/project/src/editor.ts then retry',
      })],
      artifacts: [],
      repository: null,
    })
    const serialized = JSON.stringify(packet.document)
    expect(serialized).not.toContain('/Users/alice')
    expect(serialized).not.toContain('file:///Users/alice')
    expect(serialized).not.toContain('alice')
    expect(serialized).not.toContain('My Project')
    expect(serialized).not.toContain('C:\\Users\\alice')
    expect(serialized).toContain('src/auth.ts')
    expect(serialized).toContain('[file:src/token.ts]')
    expect(serialized).toContain('[editor:src/editor.ts]')
    expect(serialized).toContain('project/failure.log')
  })

  test('deny-by-default: unknown event types and fields never reach the packet', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      events: [
        event(1, 'totally_new_event', { drop: 'me', tool: 'hidden' }),
        event(2, 'tool_call', { tool: 'read', call_id: 'c1', environ: { SECRET: 'x' } }),
      ],
      artifacts: [],
      repository: null,
    })
    const serialized = JSON.stringify(packet.document)
    expect(serialized).not.toContain('drop=me')
    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('environ')
    expect(serialized).toContain('tool=read')
  })

  test('secrets are redacted in every statement', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      events: [event(1, 'user_goal', { text: 'rotate AKIAIOSFODNN7EXAMPLE and password=hunter2 now' })],
      artifacts: [],
      repository: null,
    })
    const serialized = JSON.stringify(packet.document)
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).toContain('[redacted]')
  })

  test('quoted JSON secrets, spaces, and worktree paths never leave the packet', () => {
    const packet = buildEpisodePacket({
      ...BASE,
      events: [event(1, 'user_goal', { text: 'config {"api_key":"secret phrase"}' })],
      artifacts: [],
      repository: {
        repository_id: '33333333-3333-4333-8333-333333333333',
        repo_snapshot_id: null,
        commit_sha: null,
        branch: 'feature/password=hunter2',
        worktree_identity: '/Users/alice/private/project/worktree',
      },
    })
    const serialized = JSON.stringify(packet.document)
    expect(serialized).not.toContain('secret phrase')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('/Users/alice')
    expect(packet.document.repository.worktree_identity).toBe('project/worktree')
  })

  test('long statements truncate with original length and hash recorded in the manifest', () => {
    const longText = 'x'.repeat(2_000)
    const packet = buildEpisodePacket({
      ...BASE,
      events: [event(1, 'user_goal', { text: longText })],
      artifacts: [],
      repository: null,
    })
    const statement = packet.document.objective[0]
    expect(statement!.text.length).toBeLessThanOrEqual(480)
    const entry = packet.manifest[statement!.evidence_handle]
    expect(entry.truncated).toBe(true)
    expect(entry.excerpt_length).toBe(2_000)
    expect(entry.excerpt_hash).toMatch(/^[0-9a-f]{16}$/)
  })

  test('the total document budget deterministically omits low-priority statements', () => {
    const manyEvents = Array.from({ length: 400 }, (_, index) =>
      event(index + 1, 'agent_text', { text: `y`.repeat(400) }))
    expect(() => buildEpisodePacket({
      ...BASE, events: manyEvents, artifacts: [], repository: null,
    })).not.toThrow() // 400 bounded statements stay under the default budget
    const bounded = buildEpisodePacket({
      ...BASE, events: manyEvents, artifacts: [], repository: null,
      budget: { statementChars: 480, timelineEntries: 200, sectionEntries: 64, totalDocumentChars: 1000 },
    })
    expect(canonicalPacketJson(bounded.document).length).toBeLessThanOrEqual(1000)
    const omission = bounded.document.incomplete.find(item => item.evidence_handle.startsWith('h-omitted-'))
    expect(omission?.text).toMatch(/omitted \d+ lower-priority statements/)
    expect(bounded.manifest[omission!.evidence_handle]).toMatchObject({ truncated: true, omitted: true })
    const referenced = new Set([
      ...bounded.document.objective.map(item => item.evidence_handle),
      ...bounded.document.timeline.map(item => item.evidence_handle),
      ...bounded.document.files.map(item => item.evidence_handle),
      ...bounded.document.symbols.map(item => item.evidence_handle),
      ...bounded.document.tests.map(item => item.evidence_handle),
      ...bounded.document.approvals.map(item => item.evidence_handle),
      ...bounded.document.corrections.map(item => item.evidence_handle),
      ...bounded.document.failures.map(item => item.evidence_handle),
      ...bounded.document.incomplete.map(item => item.evidence_handle),
      ...(bounded.document.final_outcome ? [bounded.document.final_outcome.evidence_handle] : []),
    ])
    expect(Object.keys(bounded.manifest).sort()).toEqual([...referenced].sort())
  })

  test('source digest covers compiler version, policy version and artifact identity', () => {
    const events = FULL_EVENTS.slice(0, 2)
    const digest = computeSourceDigest({ installationId: BASE.installationId, events, artifacts: FULL_ARTIFACTS })
    const withOtherArtifact = computeSourceDigest({
      installationId: BASE.installationId, events,
      artifacts: [artifact(9, 'file_change', { identity_key: 'other.ts' })],
    })
    expect(digest.equals(withOtherArtifact)).toBe(false)
  })
})

describe('content policy primitives', () => {
  test('redactSecrets handles keys, tokens, JWTs and assignment secrets', () => {
    const redacted = redactSecrets(
      'key AKIAIOSFODNN7EXAMPLE token ghp_16C7e42F292c6912E7710c5385eb373d and api_key=abcd1234efgh5678 plus jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456',
    )
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(redacted).not.toContain('ghp_16C7e42F292c6912E7710c5385eb373d')
    expect(redacted).not.toContain('abcd1234efgh5678')
    expect(redacted).toContain('[redacted]')
  })

  test('sanitizeText collapses whitespace and keeps short text intact', () => {
    const result = sanitizeText('a\n\n  b\t\tc', 100)
    expect(result.text).toBe('a b c')
    expect(result.truncated).toBe(false)
    expect(result.originalLength).toBe('a\n\n  b\t\tc'.length)
  })

  test('manifest digests do not distinguish different redacted secret values', () => {
    const first = sanitizeText('password="first secret"', 100)
    const second = sanitizeText('password="second secret"', 100)
    expect(first.text).toBe('password=[redacted]')
    expect(second.text).toBe(first.text)
    expect(second.originalHash).toBe(first.originalHash)
  })

  test('describeEvent renders allowlisted fields in a stable order', () => {
    const described = describeEvent('tool_call', { tool: 'read', call_id: 'c1', environ: 'x' }, 100)
    expect(described.text).toBe('tool_call tool=read call_id=c1')
  })

  test('basenameOnly keeps at most the last two segments', () => {
    expect(basenameOnly('/a/b/c/src/thing.ts')).toBe('src/thing.ts')
  })
})
