export type SessionDocumentCaptureMode = 'off' | 'shadow' | 'on'
export type SessionDocumentExposureMode = 'off' | 'on'

export interface SessionDocumentConfig {
  captureMode: SessionDocumentCaptureMode
  listVisibility: SessionDocumentExposureMode
  htmlRendering: SessionDocumentExposureMode
  htmlDownload: SessionDocumentExposureMode
  uploadTimeoutMs: number
  maxDocumentBytes: number
  maxDocumentsPerSession: number
  maxVersionsPerDocument: number
  maxSessionBytes: number
  maxUserBytes: number
}

const DEFAULTS = Object.freeze({
  uploadTimeoutMs: 15 * 60 * 1000,
  maxDocumentBytes: 2 * 1024 * 1024,
  maxDocumentsPerSession: 50,
  maxVersionsPerDocument: 5,
  maxSessionBytes: 20 * 1024 * 1024,
  maxUserBytes: 100 * 1024 * 1024,
})

function strictMode<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const raw = env[name] ?? fallback
  if (!allowed.includes(raw as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}`)
  return raw as T
}

function strictPositiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a positive decimal integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe positive integer`)
  return value
}

export function resolveSessionDocumentConfig(
  env: Record<string, string | undefined> = process.env,
): SessionDocumentConfig {
  const config: SessionDocumentConfig = {
    captureMode: strictMode(env, 'RELAY_SESSION_DOCUMENT_CAPTURE', 'off', ['off', 'shadow', 'on']),
    listVisibility: strictMode(env, 'RELAY_SESSION_DOCUMENT_LIST', 'off', ['off', 'on']),
    htmlRendering: strictMode(env, 'RELAY_SESSION_DOCUMENT_HTML', 'off', ['off', 'on']),
    htmlDownload: strictMode(env, 'RELAY_SESSION_DOCUMENT_HTML_DOWNLOAD', 'off', ['off', 'on']),
    uploadTimeoutMs: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_UPLOAD_TIMEOUT_MS', DEFAULTS.uploadTimeoutMs,
    ),
    maxDocumentBytes: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_MAX_BYTES', DEFAULTS.maxDocumentBytes,
    ),
    maxDocumentsPerSession: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_MAX_PER_SESSION', DEFAULTS.maxDocumentsPerSession,
    ),
    maxVersionsPerDocument: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_MAX_VERSIONS', DEFAULTS.maxVersionsPerDocument,
    ),
    maxSessionBytes: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_SESSION_BYTES', DEFAULTS.maxSessionBytes,
    ),
    maxUserBytes: strictPositiveInteger(
      env, 'RELAY_SESSION_DOCUMENT_USER_BYTES', DEFAULTS.maxUserBytes,
    ),
  }

  if (config.maxSessionBytes < config.maxDocumentBytes) {
    throw new Error('session byte limit must admit one maximum document')
  }
  if (config.maxUserBytes < config.maxSessionBytes) {
    throw new Error('user byte limit must admit one maximum session')
  }
  return config
}
