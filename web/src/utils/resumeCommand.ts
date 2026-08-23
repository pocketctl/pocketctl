// web/src/utils/resumeCommand.ts
// session-resume-command: build a shell command to resume a web session in the host terminal.

export interface ResumeSession {
  agent?: string
  agent_type?: string
  cwd?: string
  session_id: string
}

/**
 * Build a shell command the user can paste into the host terminal to resume
 * a web session locally:
 *   cd "<cwd>" && <agent resume <session-id>>
 *
 * Agent mapping:
 *   - codex       → codex resume <sid>
 *   - opencode    → opencode --session <sid>
 *   - claude-code → claude --resume <sid>  (default)
 *   - zcode       → null (read-only observer; no resume, never fall back to claude)
 *
 * cwd is quoted to survive spaces/special chars; a missing cwd falls back to `cd ~`.
 * Returns null for observer/zcode sessions so callers suppress the action.
 */
export function buildResumeCommand(session: ResumeSession): string | null {
  const agent = session.agent_type || session.agent
  // ZCode observer sessions are read-only sync from the local ZCode store.
  // There is no CLI resume path and the wire session id is not a native id, so
  // never offer a resume command and never fall back to claude --resume.
  if (agent === 'zcode') {
    return null
  }
  const cwd = session.cwd ? `"${session.cwd}"` : '~'
  const sid = session.session_id
  const cmd = agent === 'codex'
    ? `codex resume ${sid}`
    : agent === 'opencode'
      ? `opencode --session ${sid}`
      : `claude --resume ${sid}`
  return `cd ${cwd} && ${cmd}`
}
