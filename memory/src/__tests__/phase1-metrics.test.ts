import { describe, expect, test } from 'vitest'
import { createPhase1Metrics } from '../metrics.js'

describe('phase one metrics', () => {
  test('exposes bounded-label extraction, search and recall metrics', async () => {
    const metrics = createPhase1Metrics()
    metrics.extractionRuns.inc({ result: 'succeeded' })
    metrics.extractionLatency.observe({ mode: 'enabled' }, 120)
    metrics.extractionTokens.inc({ direction: 'input' }, 1500)
    metrics.extractionCostMicros.inc(725)
    metrics.candidateStatus.inc({ status: 'validated' })
    metrics.reviewDecisions.inc({ decision: 'accepted_as_is' })
    metrics.indexJobs.inc({ result: 'success' })
    metrics.searchLatency.observe({ degraded: 'none' }, 0.42)
    metrics.searchResults.observe({ degraded: 'none' }, 5)
    metrics.recallFeedback.inc({ action: 'recall_used' })
    metrics.purgeInvalidations.inc({ scope: 'session' })

    const output = await metrics.registry.metrics()
    for (const name of [
      'pocketctl_memory_extraction_runs_total',
      'pocketctl_memory_extraction_latency_seconds',
      'pocketctl_memory_extraction_tokens_total',
      'pocketctl_memory_extraction_cost_micros_total',
      'pocketctl_memory_candidate_status_total',
      'pocketctl_memory_review_decisions_total',
      'pocketctl_memory_index_jobs_total',
      'pocketctl_memory_search_latency_seconds',
      'pocketctl_memory_search_results',
      'pocketctl_memory_recall_feedback_total',
      'pocketctl_memory_purge_invalidations_total',
    ]) {
      expect(output).toContain(name)
    }
  })

  test('labels stay within their frozen allowlists', () => {
    const metrics = createPhase1Metrics()
    // Invalid label values are rejected by construction: the metrics module
    // exposes typed helpers whose values are checked allowlists.
    expect(() => metrics.extractionRuns.inc({ result: 'succeeded' } as const)).not.toThrow()
    expect(metrics.extractionLabelAllowed('result', 'succeeded')).toBe(true)
    expect(metrics.extractionLabelAllowed('result', 'exploded_with_secret_text')).toBe(false)
    expect(metrics.searchLabelAllowed('degraded', 'embedding')).toBe(true)
    expect(metrics.searchLabelAllowed('degraded', 'query:"DROP TABLE"')).toBe(false)
  })

  test('serialized metrics never contain query, claim, evidence or session text', async () => {
    const metrics = createPhase1Metrics()
    metrics.extractionRuns.inc({ result: 'failed' })
    metrics.searchLatency.observe({ degraded: 'embedding' }, 1.2)
    const output = await metrics.registry.metrics()
    const forbidden = ['how to fix login flake', 'ses-1', 'claim-', 'evidence-', 'Bearer ', 'AKIA']
    for (const marker of forbidden) {
      expect(output).not.toContain(marker)
    }
  })
})
