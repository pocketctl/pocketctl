import { describe, expect, test } from 'vitest'

import { resolveSessionDocumentConfig } from '../session-documents/config.js'

describe('session document feature policy', () => {
  test('defaults every exposure flag off and applies bounded initial limits', () => {
    expect(resolveSessionDocumentConfig({})).toEqual({
      captureMode: 'off',
      listVisibility: 'off',
      htmlRendering: 'off',
      htmlDownload: 'off',
      uploadTimeoutMs: 15 * 60 * 1000,
      maxDocumentBytes: 2 * 1024 * 1024,
      maxDocumentsPerSession: 50,
      maxVersionsPerDocument: 5,
      maxSessionBytes: 20 * 1024 * 1024,
      maxUserBytes: 100 * 1024 * 1024,
    })
  })

  test('parses independent capture, list, and HTML rollout flags', () => {
    expect(resolveSessionDocumentConfig({
      RELAY_SESSION_DOCUMENT_CAPTURE: 'shadow',
      RELAY_SESSION_DOCUMENT_LIST: 'on',
      RELAY_SESSION_DOCUMENT_HTML: 'on',
      RELAY_SESSION_DOCUMENT_HTML_DOWNLOAD: 'on',
    })).toEqual(expect.objectContaining({
      captureMode: 'shadow',
      listVisibility: 'on',
      htmlRendering: 'on',
      htmlDownload: 'on',
    }))
  })

  test.each([
    ['RELAY_SESSION_DOCUMENT_CAPTURE', 'enabled'],
    ['RELAY_SESSION_DOCUMENT_LIST', 'yes'],
    ['RELAY_SESSION_DOCUMENT_HTML', 'true'],
    ['RELAY_SESSION_DOCUMENT_MAX_BYTES', '0'],
    ['RELAY_SESSION_DOCUMENT_MAX_PER_SESSION', '50docs'],
    ['RELAY_SESSION_DOCUMENT_UPLOAD_TIMEOUT_MS', '-1'],
  ])('rejects invalid %s=%s instead of silently changing exposure', (name, value) => {
    expect(() => resolveSessionDocumentConfig({ [name]: value }))
      .toThrow(name)
  })

  test('rejects quota relationships that cannot admit one maximum document', () => {
    expect(() => resolveSessionDocumentConfig({
      RELAY_SESSION_DOCUMENT_MAX_BYTES: '2097152',
      RELAY_SESSION_DOCUMENT_SESSION_BYTES: '1048576',
    })).toThrow('session byte limit')
    expect(() => resolveSessionDocumentConfig({
      RELAY_SESSION_DOCUMENT_SESSION_BYTES: '20971520',
      RELAY_SESSION_DOCUMENT_USER_BYTES: '10485760',
    })).toThrow('user byte limit')
  })
})
