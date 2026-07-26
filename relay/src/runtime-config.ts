export function resolveCorsOrigin(
  nodeEnv: string,
  allowedOrigins: string[],
): string[] | true {
  const normalized = allowedOrigins
    .map(origin => origin.trim())
    .filter(Boolean)

  if (normalized.length > 0) return normalized
  if (nodeEnv === 'production') {
    throw new Error('ALLOWED_ORIGINS is required in production')
  }
  return true
}

export function resolvePublicIssuer(
  nodeEnv: string,
  configuredUrl: string | undefined,
  fallback: string,
): string {
  const raw = configuredUrl?.trim() || (nodeEnv === 'production' ? '' : fallback)
  if (!raw) {
    throw new Error('PUBLIC_ISSUER_URL is required in production')
  }

  const url = new URL(raw)
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_ISSUER_URL must use HTTPS in production')
  }

  return url.toString().replace(/\/$/, '')
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv): {
  release_version: string
  git_sha: string
  build_time: string
} {
  const production = env.NODE_ENV === 'production'
  const releaseVersion = env.RELEASE_VERSION?.trim() || (production ? '' : 'dev')
  const gitSha = env.GIT_SHA?.trim() || (production ? '' : 'unknown')
  const buildTime = env.BUILD_TIME?.trim() || (production ? '' : 'unknown')

  if (!releaseVersion || (production && releaseVersion === 'dev')) {
    throw new Error('RELEASE_VERSION is required in production')
  }
  if (!gitSha || (production && gitSha === 'unknown')) {
    throw new Error('GIT_SHA is required in production')
  }
  if (!buildTime || (production && buildTime === 'unknown')) {
    throw new Error('BUILD_TIME is required in production')
  }

  return {
    release_version: releaseVersion,
    git_sha: gitSha,
    build_time: buildTime,
  }
}
