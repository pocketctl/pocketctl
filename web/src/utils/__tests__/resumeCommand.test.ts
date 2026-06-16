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

  test('opencode not specially handled (falls back to claude; caller hides entry)', () => {
    // buildResumeCommand does NOT branch on opencode — the UI hides the entry via v-if.
    // If called anyway, it falls back to claude (safe default).
    expect(buildResumeCommand({ agent: 'opencode', cwd: '/x', session_id: 'abc' }))
      .toBe('cd "/x" && claude --resume abc')
  })
})
