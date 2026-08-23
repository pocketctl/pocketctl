import type { TokenUsageFeatures } from '../config/token-usage.js'
import { compareTokenDashboards, type TokenDashboardLike } from './shadow.js'

export type TokenDashboardShadowObservation =
  | { status: 'match' | 'mismatch'; differingValues: number; maxAbsoluteDelta: number }
  | { status: 'error' }

/**
 * Centralizes the rollout semantics:
 * - V2 enabled: serve the fact/rollup result.
 * - shadow enabled: serve legacy immediately, compare V2 asynchronously.
 * - both disabled: preserve the legacy path exactly.
 */
export async function readTokenDashboard<T extends TokenDashboardLike>(
  features: TokenUsageFeatures,
  loadLegacy: () => Promise<T>,
  loadV2: () => Promise<T>,
  observeShadow: (observation: TokenDashboardShadowObservation) => void = () => {},
): Promise<T> {
  if (features.dashboardV2) return loadV2()

  const legacy = await loadLegacy()
  if (features.shadowRead) {
    void Promise.resolve()
      .then(loadV2)
      .then((candidate) => {
        const comparison = compareTokenDashboards(legacy, candidate)
        observeShadow({
          status: comparison.matches ? 'match' : 'mismatch',
          differingValues: comparison.differingValues,
          maxAbsoluteDelta: comparison.maxAbsoluteDelta,
        })
      })
      .catch(() => observeShadow({ status: 'error' }))
  }
  return legacy
}
