// Explicit product-owner restriction. This is never sourced from browser state or an email override.
export const PLATFORM_STATISTICS_OWNER_EMAIL = 'james_2001_2001@163.com'

export interface StatisticsConfig {
  enabled: boolean
  ownerUserId: number | null
  excludedUserIds: number[]
  excludedInstallationIds: string[]
  valid: boolean
}

function positiveId(value: string | undefined): number | null {
  return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
}

export function platformStatisticsConfig(env: NodeJS.ProcessEnv = process.env): StatisticsConfig {
  const ids = (env.PLATFORM_STATS_EXCLUDED_USER_IDS || '').split(',').filter(Boolean)
  const installations = (env.PLATFORM_STATS_EXCLUDED_INSTALLATION_IDS || '').split(',').filter(Boolean)
  const valid = ids.every(id => positiveId(id) !== null)
    && installations.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  return {
    enabled: env.PLATFORM_STATS_ENABLED === 'true',
    ownerUserId: valid ? positiveId(env.PLATFORM_STATS_OWNER_USER_ID) : null,
    excludedUserIds: valid ? [...new Set(ids.map(Number))] : [],
    excludedInstallationIds: valid ? [...new Set(installations.map(id => id.toLowerCase()))] : [],
    valid,
  }
}
