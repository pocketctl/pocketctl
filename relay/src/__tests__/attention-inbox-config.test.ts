import { describe, expect, test } from 'vitest'

import { attentionInboxConfig } from '../attention-inbox/config.js'

describe('Attention Inbox v1 runtime configuration', () => {
  test('defaults to a fully disabled capability without enabling Claude', () => {
    expect(attentionInboxConfig({})).toEqual({
      schemaVersion: 1,
      mode: 'off',
      enabled: false,
      remoteResponseEnabled: false,
      providers: {
        codex: { projection: false, remoteResponse: false },
        opencode: { projection: false, remoteResponse: false },
        'claude-code': { projection: false, remoteResponse: false },
      },
      recovery: {
        mode: 'off',
        projection: false,
        visible: false,
      },
    })
  })

  test('separates observe projection from on-mode remote response', () => {
    expect(attentionInboxConfig({ ATTENTION_INBOX_V1: ' observe ' }))
      .toEqual(expect.objectContaining({
        mode: 'observe',
        enabled: true,
        remoteResponseEnabled: false,
        providers: expect.objectContaining({
          codex: { projection: true, remoteResponse: false },
          opencode: { projection: true, remoteResponse: false },
          'claude-code': { projection: false, remoteResponse: false },
        }),
      }))

    expect(attentionInboxConfig({ ATTENTION_INBOX_V1: 'on' }))
      .toEqual(expect.objectContaining({
        mode: 'on',
        enabled: true,
        remoteResponseEnabled: true,
        providers: expect.objectContaining({
          codex: { projection: true, remoteResponse: true },
          opencode: { projection: true, remoteResponse: true },
          'claude-code': { projection: false, remoteResponse: false },
        }),
      }))
  })

  test('rejects unknown modes instead of silently enabling the feature', () => {
    expect(() => attentionInboxConfig({ ATTENTION_INBOX_V1: 'sometimes' }))
      .toThrow('invalid ATTENTION_INBOX_V1')
  })

  test('separates recovery observe projection from on-mode visibility', () => {
    expect(attentionInboxConfig({
      ATTENTION_INBOX_V1: 'on',
      ATTENTION_INBOX_RECOVERY_V2: ' observe ',
    }).recovery).toEqual({
      mode: 'observe',
      projection: true,
      visible: false,
    })

    expect(attentionInboxConfig({
      ATTENTION_INBOX_V1: 'on',
      ATTENTION_INBOX_RECOVERY_V2: 'on',
    }).recovery).toEqual({
      mode: 'on',
      projection: true,
      visible: true,
    })
  })

  test('rejects invalid recovery modes and recovery without v1', () => {
    expect(() => attentionInboxConfig({
      ATTENTION_INBOX_V1: 'on',
      ATTENTION_INBOX_RECOVERY_V2: 'sometimes',
    })).toThrow('invalid ATTENTION_INBOX_RECOVERY_V2')

    expect(() => attentionInboxConfig({
      ATTENTION_INBOX_V1: 'off',
      ATTENTION_INBOX_RECOVERY_V2: 'observe',
    })).toThrow('ATTENTION_INBOX_RECOVERY_V2 requires ATTENTION_INBOX_V1')
  })
})
