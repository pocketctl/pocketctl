/**
 * Tool call display helpers — shared by ToolCallCard.vue and any other caller.
 * Extracted from SessionDetail.vue so tool rendering logic lives in one place.
 */

/** Emoji icon for a tool name (kept as emoji to match iOS toolIcon). */
export function toolIcon(tool: string): string {
  const icons: Record<string, string> = {
    Read: '📖', Write: '✏️', Bash: '⚡', Edit: '✏️', Agent: '🤖',
    Glob: '🔍', Grep: '🔎', WebSearch: '🌐', WebFetch: '📡', Task: '📋',
  }
  return icons[tool] || '🔧'
}

export function isShellTool(tool?: string): boolean {
  return /^(bash|shell|exec_command|shell_command|commandExecution)$/i.test(tool || '')
}

export function parseSimpleToolCommand(tool: string | undefined, text: string) {
  if (!isShellTool(tool) || text.length > 4096) return null
  // Only style complete, simple commands. Preserve the original spacing and
  // fall back to the entire verbatim input for shell expressions or JSON.
  const simple = /^([ \t]*)([\w./-]+)((?:[ \t]+(?:[\w./:@%+=,-]+|'[^'\r\n]*'|"[^"\\$`\r\n]*"))*[ \t]*)$/
  const match = simple.exec(text)
  return match?.[0] === text ? match : null
}

/** Short argument summary shown in the collapsed header. */
export function toolArgs(msg: any): string {
  return msg.inputDesc || msg.description || ''
}

/** Full input text shown in the expanded "输入" section. */
export function toolInputText(msg: any): string {
  if (msg.inputDesc) return msg.inputDesc
  if (msg.input) {
    if (typeof msg.input === 'string') return msg.input
    try { return JSON.stringify(msg.input, null, 2) } catch { return String(msg.input) }
  }
  return msg.description || ''
}

/**
 * Format tool input for the collapsed header summary.
 * Mirrors iOS SessionDetailViewModel formatting logic.
 */
export function formatToolInput(tool: string, input: any): string {
  if (!input) return ''
  if (typeof input === 'string') return isShellTool(tool) ? input : input.slice(0, 80)
  if (typeof input === 'object') {
    if (isShellTool(tool)) {
      const command = input.command ?? input.cmd
      if (typeof command === 'string') return command
    }
    switch (tool) {
      case 'Read':
      case 'Write':
      case 'Edit':
        return input.file_path || input.path || ''
      case 'Glob':
      case 'Grep':
        return input.pattern || input.query || ''
      case 'Agent':
        return (input.prompt || '').slice(0, 60)
      case 'AskUserQuestion':
        return input.questions?.[0]?.question?.slice(0, 60) || '提问'
      default:
        break
    }
    // Fallback: first string value
    const first = Object.values(input).find(v => typeof v === 'string')
    if (first) return String(first).slice(0, 60)
  }
  return ''
}

/**
 * Infer the highlight.js language for a tool's output, based on tool type
 * and/or the input file path extension. Returns undefined for plain text.
 */
export function inferOutputLanguage(tool: string, inputDesc: string): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return detectLanguageFromPath(inputDesc)
    case 'Grep':
    case 'Glob':
      return undefined
    default:
      return undefined
  }
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  go: 'go', py: 'python', swift: 'swift', rs: 'rust',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', json: 'json', html: 'xml', xml: 'xml', vue: 'xml', svg: 'xml',
  css: 'css', yaml: 'yaml', yml: 'yaml', md: 'markdown',
}

function detectLanguageFromPath(path: string): string | undefined {
  if (!path) return undefined
  const components = path.split(/\s+/)
  for (const c of components) {
    const ext = c.split('.').pop()?.toLowerCase()
    if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]
  }
  return undefined
}
