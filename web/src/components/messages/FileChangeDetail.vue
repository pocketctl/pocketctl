<template>
  <div class="file-change-detail" data-testid="file-change-detail">
    <nav class="file-change-files" :aria-label="t('session.file_change_file_count', { n: files.length })">
      <button
        v-for="file in files"
        :key="file.path"
        type="button"
        :class="['file-change-file', { selected: file.path === selectedPath }]"
        :data-file-path="file.path"
        :aria-current="file.path === selectedPath ? 'true' : undefined"
        @click="selectFile(file.path)"
      >
        <span :class="['file-change-kind', file.kind]">{{ kindLabel(file.kind) }}</span>
        <span class="file-change-path">{{ file.path }}</span>
        <span class="file-change-file-stats"><span class="add">+{{ file.additions }}</span> <span class="del">-{{ file.deletions }}</span></span>
      </button>
    </nav>

    <section v-if="selectedFile && selectedEdit" class="file-change-patch">
      <header class="file-change-patch-header">
        <code data-testid="selected-file-path">{{ selectedFile.path }}</code>
        <span v-if="selectedFile.movePath" class="file-change-move">→ {{ selectedFile.movePath }}</span>
        <div v-if="selectedFile.edits.length > 1" class="file-change-edits" :aria-label="t('session.file_change_edit_number', { n: selectedFile.edits.length })">
          <button
            v-for="(edit, index) in selectedFile.edits"
            :key="edit.id"
            type="button"
            :class="{ selected: index === selectedEditIndex }"
            :aria-pressed="index === selectedEditIndex"
            @click="selectEdit(index)"
          >{{ t('session.file_change_edit_number', { n: index + 1 }) }}</button>
        </div>
      </header>

      <div v-if="statusLabel" :class="['file-change-state', selectedEdit.integrity]" role="status">
        <span v-if="selectedEdit.integrity === 'streaming' || selectedEdit.integrity === 'verifying'" class="file-change-spinner" aria-hidden="true" />
        {{ statusLabel }}
      </div>
      <div v-if="showDiff" ref="codeScroll" class="file-change-code-scroll" data-testid="file-change-code-scroll" @scroll="onScroll">
        <table class="file-change-diff">
          <tbody>
            <tr v-for="(row, index) in parsed.rows" :key="`${index}:${row.oldLine}:${row.newLine}`" :class="`diff-${row.kind}`" data-testid="diff-row">
              <td class="line-number old">{{ row.oldLine ?? '' }}</td>
              <td class="line-number new">{{ row.newLine ?? '' }}</td>
              <td class="line-sign">{{ row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '-' : '' }}</td>
              <td class="line-code"><pre>{{ row.text }}</pre></td>
            </tr>
          </tbody>
        </table>
        <button v-if="parsed.hasMore" type="button" class="file-change-load-more" data-testid="load-more" @click="loadMore">
          {{ t('session.file_change_load_more') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AgentChangedFile, AgentFileChangeMessage, FileChangeKind } from '../../utils/agentFileChange'
import { parseUnifiedDiffWindow } from '../../utils/unifiedDiff'

const props = defineProps<{ message: AgentFileChangeMessage }>()
const emit = defineEmits<{
  (event: 'selection-change', selection: { path: string; edit: number }): void
}>()
const { t } = useLocale()
const files = computed(() => props.message.fileChange.files)
const selectedPath = ref(props.message.fileChange.selectedPath || files.value[0]?.path || '')
const selectedEditByPath = new Map<string, number>()
const scrollByPath = new Map<string, number>()
const selectedEditIndex = ref(0)
const rowLimit = ref(200)
const codeScroll = ref<HTMLElement | null>(null)

const selectedFile = computed<AgentChangedFile | undefined>(() =>
  files.value.find(file => file.path === selectedPath.value) ?? files.value[0],
)
const selectedEdit = computed(() => selectedFile.value?.edits[selectedEditIndex.value] ?? selectedFile.value?.edits[0])
const parsed = computed(() => selectedEdit.value
  ? parseUnifiedDiffWindow(selectedEdit.value.diff, 0, rowLimit.value)
  : { rows: [], next: 0, hasMore: false },
)
const statusLabel = computed(() => {
  if (!selectedEdit.value) return t('session.file_change_diff_unavailable')
  switch (selectedEdit.value.integrity) {
    case 'streaming': return t('session.file_change_loading')
    case 'verifying': return t('session.file_change_verifying')
    case 'truncated': return t('session.file_change_truncated')
    case 'failed': return t('session.file_change_integrity_failed')
    default: return selectedEdit.value.diff ? '' : t('session.file_change_diff_unavailable')
  }
})
const showDiff = computed(() => !!selectedEdit.value?.diff && selectedEdit.value.integrity !== 'failed')

function kindLabel(kind: FileChangeKind): string {
  return t(`session.file_change_kind_${kind}`)
}

function rememberScroll() {
  if (codeScroll.value) scrollByPath.set(selectedPath.value, codeScroll.value.scrollTop)
}

function onScroll() {
  rememberScroll()
  if (codeScroll.value && parsed.value.hasMore &&
      codeScroll.value.scrollTop + codeScroll.value.clientHeight >= codeScroll.value.scrollHeight - 1) {
    loadMore()
  }
}

function restoreScroll() {
  nextTick(() => {
    if (codeScroll.value) codeScroll.value.scrollTop = scrollByPath.get(selectedPath.value) ?? 0
  })
}

function selectFile(path: string) {
  if (path === selectedPath.value) return
  rememberScroll()
  selectedEditByPath.set(selectedPath.value, selectedEditIndex.value)
  selectedPath.value = path
  selectedEditIndex.value = selectedEditByPath.get(path) ?? 0
  rowLimit.value = 200
  emit('selection-change', { path, edit: selectedEditIndex.value })
  restoreScroll()
}

function selectEdit(index: number) {
  selectedEditIndex.value = index
  selectedEditByPath.set(selectedPath.value, index)
  rowLimit.value = 200
  emit('selection-change', { path: selectedPath.value, edit: index })
  restoreScroll()
}

function loadMore() {
  rowLimit.value += 200
}

watch(files, updated => {
  if (!updated.some(file => file.path === selectedPath.value)) {
    selectedPath.value = updated[0]?.path ?? ''
    selectedEditIndex.value = 0
    rowLimit.value = 200
  } else {
    const maxIndex = Math.max(0, (selectedFile.value?.edits.length ?? 1) - 1)
    selectedEditIndex.value = Math.min(selectedEditIndex.value, maxIndex)
  }
})
</script>

<style scoped>
.file-change-detail { height: 100%; display: grid; grid-template-columns: clamp(220px, 24%, 280px) minmax(0, 1fr); min-height: 0; border-top: 0; cursor: default; }
.file-change-files { min-width: 0; min-height: 0; padding: 8px; border-right: 1px solid var(--border); background: var(--surface); overflow-y: auto; scrollbar-gutter: stable; }
.file-change-file { width: 100%; min-height: 44px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 8px; padding: 7px 8px; border: 0; border-radius: var(--radius-sm); color: var(--fg-secondary); background: transparent; text-align: left; }
.file-change-file:hover, .file-change-file.selected { background: var(--surface-hover); color: var(--fg); }
.file-change-file:focus-visible, .file-change-edits button:focus-visible, .file-change-load-more:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.file-change-kind { padding: 1px 5px; border-radius: var(--radius-full); color: var(--fg-tertiary); background: var(--surface); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.file-change-kind.create { color: var(--success); }
.file-change-kind.delete { color: var(--danger); }
.file-change-kind.move { color: var(--warning); }
.file-change-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/1.4 var(--font-mono); }
.file-change-file-stats { display: flex; gap: 5px; font: 9px/1.2 var(--font-mono); white-space: nowrap; }
.add { color: var(--success); }
.del { color: var(--danger); }
.file-change-patch { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); }
.file-change-patch-header { min-height: 46px; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.file-change-patch-header code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 11px; }
.file-change-move { color: var(--fg-tertiary); font-size: 11px; }
.file-change-edits { display: flex; gap: 4px; margin-left: auto; }
.file-change-edits button { padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-tertiary); background: transparent; font-size: 10px; }
.file-change-edits button.selected { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }
.file-change-state { display: flex; align-items: center; gap: 7px; padding: 8px 11px; color: var(--fg-tertiary); font-size: 11px; }
.file-change-state.failed { color: var(--danger); }
.file-change-state.truncated { color: var(--warning); }
.file-change-spinner { width: 11px; height: 11px; border: 1.5px solid var(--border-light); border-top-color: var(--accent); border-radius: 50%; animation: file-change-spin .8s linear infinite; }
.file-change-code-scroll { min-width: 0; min-height: 0; flex: 1; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; background: var(--bg); }
.file-change-diff { width: max-content; min-width: 100%; border-collapse: collapse; font: 11px/1.55 var(--font-mono); }
.file-change-diff td { padding: 0; vertical-align: top; }
.line-number { position: sticky; z-index: 2; width: 44px; min-width: 44px; padding: 0 8px !important; border-right: 1px solid color-mix(in srgb, var(--border) 72%, transparent); color: var(--fg-tertiary); background: var(--surface); text-align: right; user-select: none; }
.line-number.old { left: 0; }
.line-number.new { left: 44px; }
.line-sign { width: 18px; color: var(--fg-tertiary); text-align: center; user-select: none; }
.line-code { min-width: 720px; padding-right: 24px !important; }
.line-code pre { margin: 0; white-space: pre; font: inherit; }
.diff-addition { background: color-mix(in srgb, var(--success) 12%, transparent); }
.diff-deletion { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.diff-addition .line-number { background: color-mix(in srgb, var(--surface) 88%, var(--success)); }
.diff-deletion .line-number { background: color-mix(in srgb, var(--surface) 88%, var(--danger)); }
.diff-metadata { color: var(--fg-tertiary); background: var(--surface-hover); }
.file-change-load-more { display: block; margin: 10px auto; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--accent); background: var(--surface); }
@keyframes file-change-spin { to { transform: rotate(360deg); } }
@media (max-width: 768px) {
  .file-change-detail { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); height: 100%; border-top: 0; }
  .file-change-files { display: flex; gap: 6px; padding: 6px 0 10px; border: 0; overflow-x: auto; overflow-y: hidden; }
  .file-change-file { width: auto; min-width: 190px; flex: 0 0 auto; border: 1px solid var(--border); background: var(--surface); }
  .line-code { min-width: 560px; }
}
@media (prefers-reduced-motion: reduce) { .file-change-spinner { animation: none; } }
</style>
