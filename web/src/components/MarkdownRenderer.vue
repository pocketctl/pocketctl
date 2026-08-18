<template>
  <!--
    Markdown renderer backed by the singleton markdown-it + highlight.js +
    DOMPurify pipeline in utils/markdownRenderer. All HTML output is sanitized
    before v-html. Claude Code XML command tags are stripped in a pre-pass.
  -->
  <div class="markdown-content" ref="rootEl">
    <div v-for="(segment, idx) in segments" :key="idx" class="md-segment">
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
import { parseMarkdownSegments } from '../utils/markdownRenderer'

const props = defineProps<{ content: string }>()

const segments = computed(() => parseMarkdownSegments(props.content))

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
.md-segment { min-width: 0; max-width: 100%; }

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
