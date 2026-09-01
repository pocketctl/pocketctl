import { describe, expect, test } from 'vitest'

import { createMemoryMetrics, phase4LogFieldAllowed } from '../metrics.js'

describe('phase4 observability contracts', () => {
  test('registers the frozen bounded metric names and labels', async () => {
    const metrics = createMemoryMetrics()
    const phase4 = metrics.phase4

    phase4.codeSnapshots.inc({ result: 'accepted', source_kind: 'personal' })
    phase4.codeSnapshotBytes.inc({ language_class: 'typescript' }, 42)
    phase4.codegraphRuns.inc({ mode: 'shadow', result: 'succeeded', incremental: 'false' })
    phase4.codegraphNodes.set({ kind: 'symbol' }, 4)
    phase4.codegraphEdges.set({ kind: 'call', resolution: 'resolved' }, 3)
    phase4.codegraphImpact.inc({ result: 'complete' })
    phase4.wikiBuilds.inc({ mode: 'shadow', result: 'succeeded' })
    phase4.wikiStaleSections.set({ reason: 'source_file_changed' }, 1)
    phase4.wikiPublications.inc({ result: 'published' })
    phase4.wikiManualActions.inc({ action: 'lock', result: 'succeeded' })

    const text = await metrics.registry.metrics()
    for (const name of [
      'pocketctl_memory_code_snapshot_total',
      'pocketctl_memory_code_snapshot_bytes',
      'pocketctl_memory_codegraph_runs_total',
      'pocketctl_memory_codegraph_nodes',
      'pocketctl_memory_codegraph_edges',
      'pocketctl_memory_codegraph_impact_total',
      'pocketctl_memory_wiki_builds_total',
      'pocketctl_memory_wiki_stale_sections',
      'pocketctl_memory_wiki_publications_total',
      'pocketctl_memory_wiki_manual_actions_total',
    ]) expect(text).toContain(name)
  })

  test('allows only frozen low-cardinality label values', () => {
    const labels = createMemoryMetrics().phase4.labelAllowed
    expect(labels('codegraph_runs', 'mode', 'shadow')).toBe(true)
    expect(labels('codegraph_edges', 'resolution', 'dynamic')).toBe(true)
    expect(labels('wiki_manual_actions', 'action', 'unlock')).toBe(true)
    expect(labels('wiki_stale_sections', 'reason', 'source_symbol_changed')).toBe(true)
    expect(labels('codegraph_runs', 'mode', '/private/repository/src/secret.ts')).toBe(false)
    expect(labels('wiki_builds', 'result', 'generated wiki text')).toBe(false)
    expect(labels('unknown', 'result', 'succeeded')).toBe(false)
  })

  test('log field contract rejects content, identity, paths, symbols, commits, grants and queries', () => {
    for (const allowed of ['request_id', 'job_id', 'run_id', 'result', 'error_code', 'count', 'duration_ms', 'mode', 'content_hash']) {
      expect(phase4LogFieldAllowed(allowed), allowed).toBe(true)
    }
    for (const forbidden of [
      'source_text', 'wiki_text', 'path', 'symbol', 'repository_key', 'commit_sha',
      'grant', 'user_id', 'scope_id', 'member_id', 'query',
    ]) expect(phase4LogFieldAllowed(forbidden), forbidden).toBe(false)
  })
})
