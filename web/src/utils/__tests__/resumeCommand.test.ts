import { describe, test, expect } from 'vitest'
import { buildResumeCommand } from '../resumeCommand.js'

describe('buildResumeCommand (session-resume-command)', () => {
  test('claude-code (default agent)', () => {
    expect(buildResumeCommand({ agent: 'claude-code', cwd: '/Users/x/proj', session_id: 'abc-123' }))
      .toBe('cd "/Users/x/proj" && claude --resume abc-123')
  })

  test('codex', () => {
    expect(buildResumeCommand({ agent: 'codex', cwd: '/x', session_id: 'abc' }))
      .toBe('cd "/x" && codex resume abc')
  })

  test('opencode', () => {
    expect(buildResumeCommand({ agent: 'opencode', cwd: '/x', session_id: 'ses_abc' }))
      .toBe('cd "/x" && opencode --session ses_abc')
  })

  test('agent_type takes precedence over the legacy agent field', () => {
    expect(buildResumeCommand({ agent: 'claude-code', agent_type: 'codex', cwd: '/x', session_id: 'abc' }))
      .toBe('cd "/x" && codex resume abc')
  })

  test('no agent defaults to claude', () => {
    expect(buildResumeCommand({ cwd: '/x', session_id: 'abc' }))
      .toBe('cd "/x" && claude --resume abc')
  })

  test('no cwd → cd ~', () => {
    expect(buildResumeCommand({ agent: 'claude-code', session_id: 'abc' }))
      .toBe('cd ~ && claude --resume abc')
  })

  test('cwd with spaces is quoted', () => {
    expect(buildResumeCommand({ agent: 'claude-code', cwd: '/Users/x/My Project', session_id: 'abc' }))
      .toBe('cd "/Users/x/My Project" && claude --resume abc')
  })

  test('permanent observers return null (no resume, no claude fallback)', () => {
    expect(buildResumeCommand({ agent: 'zcode', cwd: '/x', session_id: 'zcode-wire1' }))
      .toBeNull()
    expect(buildResumeCommand({ agent_type: 'zcode', session_id: 'zcode-wire1' }))
      .toBeNull()
    expect(buildResumeCommand({ agent: 'codex-desktop', cwd: '/x', session_id: 'desktop-wire1' }))
      .toBeNull()
    expect(buildResumeCommand({ agent_type: 'codex-desktop', session_id: 'desktop-wire1' }))
      .toBeNull()
  })

})
