import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

// Register only the languages we care about (keeps bundle ~10x smaller than
// importing all of highlight.js). Falls back to plain text for unknown langs.
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import xml from 'highlight.js/lib/languages/xml'        // covers html/vue
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'       // covers sh/shell/zsh
import go from 'highlight.js/lib/languages/go'
import python from 'highlight.js/lib/languages/python'
import swift from 'highlight.js/lib/languages/swift'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import plaintext from 'highlight.js/lib/languages/plaintext'

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  html: 'xml', vue: 'xml', svg: 'xml',
  sh: 'bash', shell: 'bash', zsh: 'bash', zshrc: 'bash',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  text: 'plaintext', txt: 'plaintext', log: 'plaintext',
}

function registerLanguage(name: string, lang: any) {
  hljs.registerLanguage(name, lang)
}

registerLanguage('typescript', typescript)
registerLanguage('javascript', javascript)
registerLanguage('xml', xml)
registerLanguage('css', css)
registerLanguage('json', json)
registerLanguage('bash', bash)
registerLanguage('go', go)
registerLanguage('python', python)
registerLanguage('swift', swift)
registerLanguage('rust', rust)
registerLanguage('sql', sql)
registerLanguage('yaml', yaml)
registerLanguage('markdown', markdown)
registerLanguage('diff', diff)
registerLanguage('plaintext', plaintext)

export interface MarkdownSegment {
  type: 'code' | 'prose'
  content: string
  language?: string
  html: string
}

// ---- markdown-it singleton (module-level, reused across renders) ----
const md = new MarkdownIt({
  html: false,          // disable raw HTML in source (defense in depth)
  linkify: true,        // auto-link URLs
  breaks: true,         // \n → <br>
  highlight(code, lang) {
    // Inline highlight used for fenced code that is NOT a top-level code block
    // (e.g. indented code). Top-level fenced blocks are split out into their
    // own segments so a copy-button header can be attached.
    return highlightToHtml(code, lang)
  },
})

// GFM task markers remain read-only presentation.
md.core.ruler.after('inline', 'readonly_tasks', state => {
  state.tokens.forEach((token, index) => {
    if (token.type !== 'inline' || state.tokens[index - 2]?.type !== 'list_item_open') return
    const first = token.children?.[0]
    const match = first?.type === 'text' && first.content.match(/^\[([ xX])\] /)
    if (!match || !first) return
    first.content = first.content.slice(4)
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = '<input type="checkbox" disabled' + (match[1] !== ' ' ? ' checked' : '') + '> '
    token.children!.unshift(checkbox)
    state.tokens[index - 2].attrJoin('class', 'task-list-item')
  })
})

// ---- highlight.js ----
function resolveLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const lower = lang.toLowerCase()
  return LANGUAGE_ALIASES[lower] ?? (hljs.getLanguage(lower) ? lower : undefined)
}

function highlightToHtml(code: string, lang: string | undefined): string {
  if (code.length > 12000) return escapeHtml(code)
  const resolved = resolveLanguage(lang)
  if (resolved) {
    try {
      return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value
    } catch {
      /* fall through to plain */
    }
  }
  // Unknown / no language: return escaped plaintext (no auto-detect — keeps
  // bundle small and avoids mis-detection on short snippets).
  return escapeHtml(code)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---- Claude Code XML tag stripping (pre-parse pass) ----
function sanitizeCommandTags(text: string): string {
  if (!text.includes('<')) return text
  let result = text
  result = result.replace(/<\/?local-command-caveat[^>]*>/gs, '')
  result = result.replace(/<\/?command-name[^>]*>/gs, '')
  result = result.replace(/<\/?command-message[^>]*>/gs, '')
  result = result.replace(/<command-args>.*?<\/command-args>/gs, '')
  result = result.replace(/<\/?local-command-stdout[^>]*>/gs, '')
  result = result.replace(/<\/?local-command-stderr[^>]*>/gs, '')
  result = result.replace(/\n{3,}/g, '\n\n')
  return result.trim()
}

function sanitizeHtml(raw: string): string {
  // Sanitize: allow only a safe subset of markdown-emitted tags.
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'span', 'div',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'del', 's', 'mark', 'sub', 'sup', 'u',
      'code', 'pre', 'kbd', 'samp', 'var',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input', // for GFM task list checkboxes (we disable them below anyway)
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'alt', 'src',
      'class', 'id',
      // task list items keep type/disabled/checked but we force-disabled
      'type', 'disabled', 'checked',
      'target', 'rel',
    ],
  })
}

// ---- Segment splitting: extract fenced code blocks so they can be rendered
// with a custom header (language label + copy button). Non-code segments are
// rendered as normal markdown prose. ----
export function parseMarkdownSegments(text: string): MarkdownSegment[] {
  if (text.length > 512000) return [{ type: 'prose', content: text, html: '<pre>' + escapeHtml(text) + '</pre>' }]
  const sanitized = text.includes('```') || text.includes('~~~') ? text : sanitizeCommandTags(text)
  const env = {}
  const tokens = md.parse(sanitized, env)
  const segments: MarkdownSegment[] = []
  let start = 0
  function prose(end: number) {
    if (end > start) segments.push({ type: 'prose', content: '', html: sanitizeHtml(md.renderer.render(tokens.slice(start, end), md.options, env)) })
  }
  tokens.forEach((token, index) => {
    if (token.type !== 'fence' || token.level !== 0) return
    prose(index)
    const code = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content
    const language = token.info.trim().split(/\s+/)[0] || undefined
    segments.push({ type: 'code', content: code, language, html: highlightToHtml(code, language) })
    start = index + 1
  })
  prose(tokens.length)
  return segments
}

// Hook installation is keyed by purifier identity so a singleton purifier
// never accumulates duplicate afterSanitizeAttributes hooks across component
// mounts, and tests can install the same hook on their own instance.
const hookInstalledPurifiers = new WeakSet<object>()

export function installMarkdownSanitizerHooks(purifier: typeof DOMPurify = DOMPurify): void {
  if (hookInstalledPurifiers.has(purifier)) return
  hookInstalledPurifiers.add(purifier)
  // Force all links to open in a new tab safely.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

installMarkdownSanitizerHooks()
