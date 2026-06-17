<template>
  <!--
    Markdown renderer backed by markdown-it + highlight.js + DOMPurify.
    All HTML output is sanitized before v-html. Claude Code XML command tags
    are stripped in a pre-pass (sanitizeCommandTags) before parsing.
  -->
  <div class="markdown-content" ref="rootEl">
    <div v-for="(segment, idx) in segments" :key="idx">
      <!-- Block code: rendered standalone with header (lang + copy) -->
      <div v-if="segment.type === 'code'" class="md-code-block">
        <div class="code-header">
          <span class="code-lang">{{ segment.language || 'text' }}</span>
          <button class="code-copy" @click="copyCode(segment.content)">
            {{ copiedIdx === idx ? '已复制' : '复制' }}
          </button>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <pre class="code-pre"><code v-html="segment.html"></code></pre>
      </div>

      <!-- Everything else (paragraphs, headings, lists, tables, quotes, links...):
           one markdown-it render + DOMPurify pass per contiguous run. -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="md-prose" v-html="segment.html"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
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

const props = defineProps<{ content: string }>()

interface Segment {
  type: 'code' | 'prose'
  content: string
  language?: string
  html: string
}

// ---- markdown-it instance (module-level, reused across renders) ----
const md = new MarkdownIt({
  html: false,          // disable raw HTML in source (defense in depth)
  linkify: true,        // auto-link URLs
  breaks: true,         // \n → <br>
  highlight(code, lang) {
    // Inline highlight used for fenced code that is NOT a top-level code block
    // (e.g. indented code). Top-level fenced blocks are split out into their
    // own segments below so we can attach a copy button header.
    return highlightToHtml(code, lang)
  },
})

// ---- highlight.js ----
function resolveLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const lower = lang.toLowerCase()
  return LANGUAGE_ALIASES[lower] ?? (hljs.getLanguage(lower) ? lower : undefined)
}

function highlightToHtml(code: string, lang: string | undefined): string {
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

// ---- Segment splitting: extract fenced code blocks so we can render them
// with a custom header (language label + copy button). Non-code segments are
// rendered as normal markdown prose. ----
function parseSegments(text: string): Segment[] {
  const sanitized = sanitizeCommandTags(text)
  const lines = sanitized.split('\n')
  const segments: Segment[] = []
  let proseLines: string[] = []
  let codeLines: string[] = []
  let codeLang: string | undefined
  let inCode = false

  function flushProse() {
    const t = proseLines.join('\n')
    if (t.trim()) {
      segments.push({ type: 'prose', content: t, html: renderProse(t) })
    }
    proseLines = []
  }

  function flushCode() {
    const code = codeLines.join('\n')
    const lang = codeLang?.trim() || undefined
    segments.push({
      type: 'code',
      content: code,
      language: lang,
      html: highlightToHtml(code, lang),
    })
    codeLines = []
    codeLang = undefined
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      if (inCode) {
        inCode = false
        flushCode()
      } else {
        flushProse()
        inCode = true
        codeLang = trimmed.slice(3).trim() || undefined
      }
      continue
    }
    if (inCode) {
      codeLines.push(line)
    } else {
      proseLines.push(line)
    }
  }

  if (inCode) flushCode()
  flushProse()

  return segments
}

function renderProse(text: string): string {
  const raw = md.render(text)
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

const segments = computed(() => parseSegments(props.content))

// ---- copy button ----
const copiedIdx = ref<number>(-1)
let copyTimer: ReturnType<typeof setTimeout> | null = null
const rootEl = ref<HTMLElement | null>(null)

function copyCode(code: string) {
  navigator.clipboard.writeText(code).then(() => {
    // find the index of this code segment to show "已复制" on its button
    const idx = segments.value.findIndex(s => s.type === 'code' && s.content === code)
    copiedIdx.value = idx
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copiedIdx.value = -1 }, 2000)
  }).catch(() => {})
}

// Force all links to open in a new tab safely.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})
</script>

<style scoped>
.markdown-content {
  font-size: 14px;
  line-height: 1.65;
  color: var(--fg);
  word-break: break-word;
  /* Allow this container to shrink below its content's intrinsic width so
     very long code lines scroll inside <pre> instead of widening the column. */
  min-width: 0;
  max-width: 100%;
}

/* Inline code within prose */
.md-prose :deep(code:not(pre code)) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--code-bg);
  color: var(--accent);
  padding: 2px 6px;
  border-radius: 4px;
}

/* Headings */
.md-prose :deep(h1),
.md-prose :deep(h2),
.md-prose :deep(h3),
.md-prose :deep(h4),
.md-prose :deep(h5),
.md-prose :deep(h6) {
  font-family: var(--font-display);
  font-weight: 600;
  color: var(--fg);
  margin: 1.2em 0 0.5em;
  line-height: 1.3;
}
.md-prose :deep(h1) { font-size: 1.5em; }
.md-prose :deep(h2) { font-size: 1.3em; }
.md-prose :deep(h3) { font-size: 1.15em; }
.md-prose :deep(h4),
.md-prose :deep(h5),
.md-prose :deep(h6) { font-size: 1em; }
.md-prose :deep(h1:first-child),
.md-prose :deep(h2:first-child),
.md-prose :deep(h3:first-child),
.md-prose :deep(h4:first-child) { margin-top: 0; }

/* Paragraphs */
.md-prose :deep(p) { margin: 0 0 0.6em; }
.md-prose :deep(p:last-child) { margin-bottom: 0; }

/* Strong / em / del */
.md-prose :deep(strong) { font-weight: 600; color: var(--fg); }
.md-prose :deep(em) { font-style: italic; }
.md-prose :deep(del) { color: var(--fg-tertiary); }

/* Links */
.md-prose :deep(a) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  transition: border-color 0.15s;
}
.md-prose :deep(a:hover) { border-bottom-color: var(--accent); }

/* Lists */
.md-prose :deep(ul),
.md-prose :deep(ol) {
  margin: 0.4em 0;
  padding-left: 1.5em;
}
.md-prose :deep(li) { margin: 0.2em 0; }
.md-prose :deep(li::marker) { color: var(--fg-secondary); }
/* GFM task list */
.md-prose :deep(.task-list-item) { list-style: none; margin-left: -1.2em; }
.md-prose :deep(.task-list-item input) {
  margin-right: 0.5em;
  accent-color: var(--accent);
}

/* Blockquote */
.md-prose :deep(blockquote) {
  margin: 0.6em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--border-light);
  color: var(--fg-secondary);
}
.md-prose :deep(blockquote p) { margin: 0.2em 0; }

/* Horizontal rule */
.md-prose :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1em 0;
}

/* Inline code already handled above; nested pre code is a fenced block but
   since we extract fenced blocks into dedicated .md-code-block, any remaining
   pre here is indented code. */
.md-prose :deep(pre) {
  margin: 0.6em 0;
  padding: 10px 14px;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
  max-width: 100%;
  min-width: 0;
}
.md-prose :deep(pre code) {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg);
  line-height: 1.6;
  background: none;
  padding: 0;
}

/* Tables (GFM) */
.md-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.6em 0;
  font-size: 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.md-prose :deep(th) {
  background: var(--code-bg);
  font-weight: 600;
  color: var(--fg);
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.md-prose :deep(td) {
  padding: 6px 12px;
  color: var(--fg-secondary);
  border-bottom: 1px solid var(--border);
}
.md-prose :deep(tr:last-child td) { border-bottom: none; }
.md-prose :deep(tr:nth-child(even)) { background: var(--surface-hover); }

/* ---- Dedicated code block (fenced) ---- */
.md-code-block {
  margin: 8px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--code-bg);
  /* Constrain to container width; long lines scroll inside <pre>. */
  max-width: 100%;
  min-width: 0;
}
.md-code-block .code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.code-lang {
  font-size: 11px;
  color: var(--fg-tertiary);
  font-family: var(--font-mono);
  text-transform: lowercase;
}
.code-copy {
  font-size: 11px;
  color: var(--fg-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.15s, background 0.15s;
}
.code-copy:hover {
  color: var(--fg);
  background: var(--surface-hover);
}
.code-pre {
  margin: 0;
  padding: 12px 14px;
  background: var(--code-bg);
  overflow-x: auto;
  /* Cap at container width so very long lines scroll inside instead of
     stretching the block (and the whole chat column with it). */
  max-width: 100%;
  min-width: 0;
}
.code-pre :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg);
}
</style>
