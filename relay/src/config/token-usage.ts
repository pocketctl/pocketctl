export interface TokenUsageFeatures {
  writeFacts: boolean
  shadowRead: boolean
  dashboardV2: boolean
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/**
 * New token accounting remains opt-in after implementation so production can
 * progress through facts, shadow-read and V2-read rollout stages explicitly.
 */
export function tokenUsageFeatures(env: NodeJS.ProcessEnv = process.env): TokenUsageFeatures {
  return {
    writeFacts: enabled(env.TOKEN_USAGE_FACTS_WRITE),
    shadowRead: enabled(env.TOKEN_USAGE_SHADOW_READ),
    dashboardV2: enabled(env.TOKEN_USAGE_DASHBOARD_V2),
  }
}

/**
 * Candidate reads are only valid once every newly materialized token delta is
 * durably mirrored into the immutable fact table. Keep this assertion close
 * to process startup so an invalid rollout fails closed instead of serving a
 * partial dashboard.
 */
export function assertTokenUsageFeatureDependencies(
  features: TokenUsageFeatures,
  durableIngressMode?: string,
): void {
  if (!features.writeFacts && (features.shadowRead || features.dashboardV2)) {
    throw new Error(
      'TOKEN_USAGE_SHADOW_READ and TOKEN_USAGE_DASHBOARD_V2 require TOKEN_USAGE_FACTS_WRITE=true',
    )
  }
  if (features.writeFacts && durableIngressMode !== undefined && durableIngressMode !== 'on') {
    throw new Error('TOKEN_USAGE_FACTS_WRITE=true requires RELAY_DURABLE_INGRESS=on')
  }
}

/** Legacy reads need deletion compensation until the V2 read path is live. */
export function useFactAuthoritativeSessionDeletion(features: TokenUsageFeatures): boolean {
  return features.dashboardV2
}
