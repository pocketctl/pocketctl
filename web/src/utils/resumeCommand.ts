// web/src/utils/resumeCommand.ts
// session-resume-command: build a shell command to resume a web session in the host terminal.

export interface ResumeSession {
  agent?: string
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
 *   - claude-code → claude --resume <sid>  (default)
 *   - opencode    → NOT handled here (caller hides the entry); falls back to claude.
 *
 * cwd is quoted to survive spaces/special chars; a missing cwd falls back to `cd ~`.
 */
export function buildResumeCommand(session: ResumeSession): string {
  const cwd = session.cwd ? `"${session.cwd}"` : '~'
  const sid = session.session_id
  const cmd = session.agent === 'codex' ? `codex resume ${sid}` : `claude --resume ${sid}`
  return `cd ${cwd} && ${cmd}`
}
