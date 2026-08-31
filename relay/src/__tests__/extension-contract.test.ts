import { describe, expect, test } from 'vitest'
import {
  EXTENSION_TOPICS,
  EXTENSION_SCOPES,
  EXTENSION_SERVICE_IDS,
  EXTENSION_ERROR_CODES,
  EXTENSION_PROTOCOL_VERSIONS,
  PROVIDER_INSTALLATION_FIELDS,
  isExtensionTopic,
  isExtensionScope,
  isExtensionServiceId,
  isInstallationStatus,
  isExtensionErrorCode,
  extensionTopicForEventType,
} from '../extensions/types.js'
import {
  ExtensionApiError,
  extensionErrorStatus,
  isExtensionApiError,
} from '../extensions/errors.js'

describe('extension topic allowlist', () => {
  test('contains exactly the five frozen topics', () => {
    expect([...EXTENSION_TOPICS].sort()).toEqual([
      'session.access.revoked.v1',
      'session.deleted.v1',
      'session.event.v1',
      'session.lifecycle.v1',
      'turn.lifecycle.v1',
    ])
  })

  test('guards reject arbitrary strings and non-strings', () => {
    expect(isExtensionTopic('session.event.v1')).toBe(true)
    expect(isExtensionTopic('session.event.v2')).toBe(false)
    expect(isExtensionTopic('memory.candidates.v1')).toBe(false)
    expect(isExtensionTopic('')).toBe(false)
    expect(isExtensionTopic(null as unknown as string)).toBe(false)
    expect(isExtensionTopic(123 as unknown as string)).toBe(false)
  })

  test('unknown event types fail open to session.event.v1', () => {
    expect(extensionTopicForEventType('agent_text')).toBe('session.event.v1')
    expect(extensionTopicForEventType('tool_call')).toBe('session.event.v1')
    expect(extensionTopicForEventType('completely_new_type')).toBe('session.event.v1')
  })

  test('turn and session lifecycle events map to their topics', () => {
    expect(extensionTopicForEventType('turn_status')).toBe('turn.lifecycle.v1')
    expect(extensionTopicForEventType('session_created')).toBe('session.lifecycle.v1')
    expect(extensionTopicForEventType('session_discovered')).toBe('session.lifecycle.v1')
    expect(extensionTopicForEventType('session_status')).toBe('session.lifecycle.v1')
  })

  test('protocol versions contain the frozen v1 and additive v2 feeds', () => {
    expect([...EXTENSION_PROTOCOL_VERSIONS]).toEqual(['extension-feed.v1', 'extension-feed.v2'])
  })
})

describe('extension scope and service allowlists', () => {
  test('contains the frozen session scopes plus the v2 control scope', () => {
    expect([...EXTENSION_SCOPES].sort()).toEqual([
      'scope:control:read',
      'session:deletion:read',
      'session:events:read',
      'session:snapshot:read',
    ])
    expect(isExtensionScope('scope:control:read')).toBe(true)
  })

  test('contains exactly the first-party memory services', () => {
    expect([...EXTENSION_SERVICE_IDS].sort()).toEqual([
      'knowledge.query',
      'memory.context',
      'memory.manage',
      'memory.mcp',
      'memory.recall',
      'memory.search',
    ])
  })

  test('guards reject arbitrary strings', () => {
    expect(isExtensionScope('session:events:read')).toBe(true)
    expect(isExtensionScope('session:events:write')).toBe(false)
    expect(isExtensionScope('admin')).toBe(false)
    expect(isExtensionServiceId('memory.search')).toBe(true)
    expect(isExtensionServiceId('memory.manage')).toBe(true)
    expect(isExtensionServiceId('memory.drop_tables')).toBe(false)
    expect(isExtensionServiceId('arbitrary.service')).toBe(false)
  })
})

describe('provider public origin parsing', () => {
  const allowed = ['pocketctl-memory']

  test('parses the operator JSON map into normalized origins', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    const origins = parseProviderPublicOrigins(
      '{"pocketctl-memory": "https://Memory.Example:443"}',
      { allowedProviders: allowed, requireHttps: true },
    )
    expect(origins.get('pocketctl-memory')).toBe('https://memory.example')
  })

  test('rejects malformed JSON, arrays and non-string values', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    for (const raw of ['not json', '["pocketctl-memory"]', '{"pocketctl-memory": 5}']) {
      expect(() => parseProviderPublicOrigins(raw, { allowedProviders: allowed, requireHttps: true }))
        .toThrow(/EXTENSION_PROVIDER_PUBLIC_ORIGINS/)
    }
  })

  test('rejects unknown providers and duplicate keys', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    expect(() => parseProviderPublicOrigins(
      '{"third-party-memory": "https://x.example"}',
      { allowedProviders: allowed, requireHttps: true },
    )).toThrow(/unknown provider/)
    expect(() => parseProviderPublicOrigins(
      '{"pocketctl-memory": "https://a.example", "pocketctl-memory": "https://b.example"}',
      { allowedProviders: allowed, requireHttps: true },
    )).toThrow(/duplicate/)
  })

  test('rejects credentials, paths and query strings', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    for (const raw of [
      '{"pocketctl-memory": "https://user:pass@memory.example"}',
      '{"pocketctl-memory": "https://memory.example/api"}',
      '{"pocketctl-memory": "https://memory.example?x=1"}',
    ]) {
      expect(() => parseProviderPublicOrigins(raw, { allowedProviders: allowed, requireHttps: true }))
        .toThrow(/EXTENSION_PROVIDER_PUBLIC_ORIGINS/)
    }
  })

  test('rejects plain HTTP when HTTPS is required (production)', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    expect(() => parseProviderPublicOrigins(
      '{"pocketctl-memory": "http://memory.example"}',
      { allowedProviders: allowed, requireHttps: true },
    )).toThrow(/HTTPS/)
    expect(parseProviderPublicOrigins(
      '{"pocketctl-memory": "http://memory.internal"}',
      { allowedProviders: allowed, requireHttps: false },
    ).get('pocketctl-memory')).toBe('http://memory.internal')
  })

  test('an empty value yields an empty map', async () => {
    const { parseProviderPublicOrigins } = await import('../extensions/config.js')
    expect(parseProviderPublicOrigins(undefined, { allowedProviders: allowed, requireHttps: true }).size)
      .toBe(0)
    expect(parseProviderPublicOrigins('  ', { allowedProviders: allowed, requireHttps: true }).size)
      .toBe(0)
  })
})

describe('installation status machine', () => {
  test('contains exactly the five frozen statuses', () => {
    const statuses = ['pending', 'active', 'paused', 'revoking', 'revoked'] as const
    for (const status of statuses) expect(isInstallationStatus(status)).toBe(true)
    expect(isInstallationStatus('deleted')).toBe(false)
    expect(isInstallationStatus('enabled')).toBe(false)
    expect(isInstallationStatus('ACTIVE')).toBe(false)
  })
})

describe('extension error contract', () => {
  test('contains exactly the frozen error codes', () => {
    expect([...EXTENSION_ERROR_CODES].sort()).toEqual([
      'cursor_expired',
      'feature_disabled',
      'forbidden',
      'installation_paused',
      'installation_revoked',
      'invalid_request',
      'not_found',
      'revision_conflict',
      'stale_lease',
      'unauthorized',
    ])
  })

  test('isExtensionErrorCode rejects unknown codes', () => {
    expect(isExtensionErrorCode('stale_lease')).toBe(true)
    expect(isExtensionErrorCode('server_error')).toBe(false)
    expect(isExtensionErrorCode(undefined)).toBe(false)
  })

  test('error codes map to fixed HTTP statuses', () => {
    expect(extensionErrorStatus('unauthorized')).toBe(401)
    expect(extensionErrorStatus('forbidden')).toBe(403)
    expect(extensionErrorStatus('not_found')).toBe(404)
    expect(extensionErrorStatus('invalid_request')).toBe(400)
    expect(extensionErrorStatus('stale_lease')).toBe(409)
    expect(extensionErrorStatus('installation_paused')).toBe(409)
    expect(extensionErrorStatus('cursor_expired')).toBe(410)
    expect(extensionErrorStatus('installation_revoked')).toBe(403)
    expect(extensionErrorStatus('feature_disabled')).toBe(503)
  })

  test('ExtensionApiError carries only its code and safe message', () => {
    const error = new ExtensionApiError('stale_lease', 'lease no longer current')
    expect(isExtensionApiError(error)).toBe(true)
    expect(error.code).toBe('stale_lease')
    expect(error.httpStatus).toBe(409)
    expect(isExtensionApiError(new Error('plain'))).toBe(false)
  })
})

describe('provider installation inventory contract', () => {
  test('exposes exactly the frozen provider-facing fields', () => {
    expect([...PROVIDER_INSTALLATION_FIELDS].sort()).toEqual([
      'config_version',
      'created_at',
      'enabled_services',
      'event_filter',
      'granted_scopes',
      'installation_id',
      'snapshot_required',
      'status',
      'subscriptions',
      'updated_at',
    ])
  })

  test('never exposes owner identity in the inventory payload', () => {
    const serialized = JSON.stringify(PROVIDER_INSTALLATION_FIELDS)
    expect(serialized).not.toContain('owner_user_id')
    expect(serialized).not.toContain('user_id')
    expect(serialized).not.toContain('owner')
  })
})
