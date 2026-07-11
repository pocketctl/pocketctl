import { describe, expect, test } from 'vitest'
import { defaultPermission, expandCodexPreset, permissionOptions, permissionTitleKey } from '../permission'

describe('agent permissions', () => {
  test('uses identical product defaults', () => {
    expect(defaultPermission('claude-code')).toEqual({ agent: 'claude-code', mode: 'acceptEdits' })
    expect(defaultPermission('codex')).toEqual({ agent: 'codex', preset: 'custom' })
    expect(defaultPermission('opencode')).toBeUndefined()
  })

  test('expands codex presets without silently enabling blocking approval', () => {
    expect(expandCodexPreset('full_access')).toEqual({ agent: 'codex', preset: 'full_access', dangerously_bypass: true })
    expect(expandCodexPreset('request_approval')).toEqual({ agent: 'codex', preset: 'request_approval', approval_policy: 'on-request', sandbox_mode: 'workspace-write' })
  })

  test('claude exposes six native startup modes', () => {
    expect(permissionOptions('claude-code', true)).toHaveLength(6)
    expect(permissionTitleKey({ agent: 'claude-code', mode: 'plan' })).toBe('session.permission.claude.plan.title')
  })
})
