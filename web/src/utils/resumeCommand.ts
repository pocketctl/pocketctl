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
 *
 * cwd is quoted to survive spaces/special chars; a missing cwd falls back to `cd ~`.
 */
export function buildResumeCommand(session: ResumeSession): string {
  const cwd = session.cwd ? `"${session.cwd}"` : '~'
  const sid = session.session_id
  const agent = session.agent_type || session.agent
  const cmd = agent === 'codex'
    ? `codex resume ${sid}`
    : agent === 'opencode'
      ? `opencode --session ${sid}`
      : `claude --resume ${sid}`
  return `cd ${cwd} && ${cmd}`
}
