<template>
  <div class="markdown-content">
    <template v-for="(segment, idx) in segments" :key="idx">
      <!-- Text with inline formatting -->
      <div v-if="segment.type === 'text'" class="md-text" v-html="renderInline(segment.content || '')"></div>

      <!-- Code block -->
      <div v-else-if="segment.type === 'code'" class="md-code-block">
        <div class="code-header" v-if="segment.language">
          <span class="code-lang">{{ segment.language }}</span>
          <button class="code-copy" @click="copyCode(segment.content || '')">复制</button>
        </div>
        <pre class="code-pre"><code>{{ segment.content }}</code></pre>
      </div>

      <!-- Table -->
      <div v-else-if="segment.type === 'table'" class="md-table-wrap">
        <table class="md-table">
          <thead>
            <tr>
              <th v-for="(h, hi) in (segment.headers || [])" :key="hi">{{ h }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, ri) in (segment.rows || [])" :key="ri">
              <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ content: string }>()

interface Segment {
  type: 'text' | 'code' | 'table'
  content?: string
  language?: string
  headers?: string[]
  rows?: string[][]
}

function sanitizeCommandTags(text: string): string {
  if (!text.includes('<')) return text
  let result = text
  // Remove command tags, keep inner content
  result = result.replace(/<\/?local-command-caveat[^>]*>/gs, '')
  result = result.replace(/<\/?command-name[^>]*>/gs, '')
  result = result.replace(/<\/?command-message[^>]*>/gs, '')
  result = result.replace(/<command-args>.*?<\/command-args>/gs, '')
  result = result.replace(/<\/?local-command-stdout[^>]*>/gs, '')
  result = result.replace(/<\/?local-command-stderr[^>]*>/gs, '')
  result = result.replace(/\n{3,}/g, '\n\n')
  return result.trim()
}

function parseSegments(text: string): Segment[] {
  const sanitized = sanitizeCommandTags(text)
  const lines = sanitized.split('\n')
  const segments: Segment[] = []
  let currentText: string[] = []
  let tableLines: string[] = []
  let codeBlockLines: string[] = []
  let codeBlockLang: string | undefined
  let inCodeBlock = false

  function flushText() {
    const t = currentText.join('\n').trim()
    if (t) segments.push({ type: 'text', content: t })
    currentText = []
  }

  function flushTable() {
    if (tableLines.length < 2) {
      currentText.push(...tableLines)
      tableLines = []
      return
    }
    const headers = parseTableRow(tableLines[0])
    const rows: string[][] = []
    for (let i = 2; i < tableLines.length; i++) {
      rows.push(parseTableRow(tableLines[i]))
    }
    segments.push({ type: 'table', headers, rows })
    tableLines = []
  }

  function flushCodeBlock() {
    segments.push({ type: 'code', content: codeBlockLines.join('\n'), language: codeBlockLang })
    codeBlockLines = []
    codeBlockLang = undefined
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false
        flushCodeBlock()
      } else {
        flushText()
        if (tableLines.length > 0) flushTable()
        inCodeBlock = true
        codeBlockLang = trimmed.slice(3).trim() || undefined
      }
      continue
    }

    if (inCodeBlock) {
      codeBlockLines.push(line)
      continue
    }

    if (isTableLine(trimmed)) {
      if (isSeparatorLine(trimmed) && tableLines.length > 0) {
        tableLines.push(line)
      } else if (tableLines.length === 0) {
        flushText()
        tableLines.push(line)
      } else {
        tableLines.push(line)
      }
    } else {
      if (tableLines.length > 0) flushTable()
      currentText.push(line)
    }
  }

  if (inCodeBlock) flushCodeBlock()
  if (tableLines.length > 0) flushTable()
  flushText()

  return segments
}

function isTableLine(line: string): boolean {
  if (!line.includes('|')) return false
  return (line.match(/\|/g) || []).length >= 2
}

function isSeparatorLine(line: string): boolean {
  return line.replace(/[\|\-\s:]/g, '').length === 0
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim()
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
  return trimmed.split('|').map(s => s.trim())
}

function renderInline(text: string): string {
  // Escape HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')

  // Line breaks
  html = html.replace(/\n/g, '<br>')

  return html
}

function copyCode(code: string) {
  navigator.clipboard.writeText(code).catch(() => {})
}

const segments = computed(() => parseSegments(props.content))
</script>

<style scoped>
.markdown-content {
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg);
  word-break: break-word;
}

.md-text {
  margin-bottom: 8px;
}
.md-text :deep(strong) {
  font-weight: 600;
  color: var(--fg);
}
.md-text :deep(.inline-code) {
  font-family: var(--font-mono);
  font-size: 12px;
  background: var(--code-bg);
  color: var(--accent);
  padding: 2px 6px;
  border-radius: 4px;
}

/* Code block */
.md-code-block {
  margin: 8px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--code-bg);
  border-bottom: 1px solid var(--border);
}
.code-lang {
  font-size: 11px;
  color: var(--fg-tertiary);
  font-family: var(--font-mono);
}
.code-copy {
  font-size: 11px;
  color: var(--fg-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
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
}
.code-pre code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--success);
  line-height: 1.6;
}

/* Table */
.md-table-wrap {
  margin: 8px 0;
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.md-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.md-table th {
  background: var(--code-bg);
  font-weight: 600;
  color: var(--fg);
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.md-table td {
  padding: 6px 12px;
  color: var(--fg-secondary);
  border-bottom: 1px solid var(--border);
}
.md-table tr:last-child td {
  border-bottom: none;
}
.md-table tr:nth-child(even) {
  background: var(--surface-hover);
}
</style>
