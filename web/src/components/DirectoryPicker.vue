<template>
  <section ref="pickerEl" class="directory-picker" role="dialog" aria-modal="true" :aria-label="t('directory.title')" @keydown="handleKeydown">
    <header class="picker-header">
      <button class="back" @click="$emit('close')">{{ t('common.cancel') }}</button>
      <h2>{{ t('directory.title') }} <small>{{ hostName }}</small></h2>
      <button class="mobile-select" :disabled="!canSelect" @click="selectDirectory">{{ t('directory.select') }}</button>
    </header>
    <div class="path-toolbar">
      <button class="up" :disabled="!result?.parent || loading || !online" :aria-label="t('directory.up')" @click="navigate(result!.parent)">↑</button>
      <button class="path-menu" :title="result?.path" @click="showLocations = !showLocations">{{ shortPath }} ⌄</button>
      <nav class="breadcrumbs" :aria-label="t('directory.path')">
        <button @click="showLocations = !showLocations" :aria-label="t('directory.roots')">⌄</button>
        <template v-for="part in ancestors" :key="part.path"><button :title="part.path" @click="navigate(part.path)">{{ part.name }}</button><span>/</span></template>
      </nav>
      <button @click="showPath = !showPath">{{ t('directory.enter_path') }}</button>
    </div>
    <div v-if="showLocations" class="locations">
      <span>{{ t('directory.roots') }}</span>
      <button v-for="root in result?.roots || []" :key="root" @click="navigate(root)">{{ displayPath(root) }}</button>
      <span v-if="ancestors.length > 1">{{ t('directory.ancestors') }}</span>
      <button v-for="part in ancestors.slice(0, -1)" :key="part.path" @click="navigate(part.path)">{{ displayPath(part.path) }}</button>
    </div>
    <form v-if="showPath" class="path-input" @submit.prevent="navigate(pathInput)">
      <input v-model="pathInput" :aria-label="t('directory.path')" :placeholder="t('directory.path')" spellcheck="false" />
      <button :disabled="!online">{{ t('directory.go') }}</button>
    </form>
    <div class="search"><input v-model="query" type="search" :disabled="!online" :placeholder="t('directory.search')" :aria-label="t('directory.search')" /></div>
    <div v-if="result?.fallback" class="notice">{{ t('directory.fallback') }}</div>
    <div v-if="error || !online" class="error" role="alert">
      {{ t('directory.error.' + (!online ? 'daemon_offline' : error)) }}
      <button v-if="error !== 'unsupported' && online" @click="load(false)">{{ t('directory.retry') }}</button>
    </div>
    <div ref="listEl" class="directory-list" :aria-busy="loading" @scroll="onScroll">
      <button v-if="result?.parent && !query" class="directory-row" :disabled="loading || !online" @click="navigate(result!.parent)">
        <span class="folder">▱</span><span class="name">..</span><span class="secondary">{{ t('directory.up') }} ↑</span>
      </button>
      <div v-if="windowStart" :style="{ height: windowStart * rowHeight + 'px' }" aria-hidden="true"></div>
      <button v-for="entry in visibleEntries" :key="entry.path" class="directory-row" :disabled="!entry.can_browse || loading || !online" :title="entry.name" @click="navigate(entry.path)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 8h18"/></svg>
        <span class="name">{{ entry.name }}</span><span v-if="entry.reason" class="permission">{{ t('directory.entry.' + entry.reason) }}</span><span class="secondary">›</span>
      </button>
      <div v-if="bottomRows" :style="{ height: bottomRows * rowHeight + 'px' }" aria-hidden="true"></div>
      <div v-if="loading" class="empty" role="status">{{ t('directory.loading') }}</div>
      <div v-else-if="!error && online && !entries.length" class="empty">{{ t(query ? 'directory.no_match' : 'directory.empty') }}</div>
      <button v-if="result?.next_cursor && !error" class="load-more" :disabled="loading || !online" @click="load(true)">{{ t('directory.more') }}</button>
    </div>
    <footer>
      <span class="summary">{{ hostName }} · {{ entries.length }} {{ t('directory.loaded') }}</span>
      <span :class="['access', { readonly: !result?.can_select }]">{{ !online || error ? t('directory.unknown_access') : t(result?.can_select ? 'directory.writable' : 'directory.readonly') }}</span>
      <button class="desktop-cancel" @click="$emit('close')">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="!canSelect" @click="selectDirectory">{{ t(validating ? 'directory.checking' : 'directory.select_current') }}</button>
    </footer>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWebSocket } from '../composables/useWebSocket'
import { useLocale } from '../composables/useLocale'
import { createClientId } from '../utils/clientId'
interface Entry { name: string; path: string; can_browse: boolean; can_select: boolean; reason?: string }
interface Result { path: string; parent: string; home: string; roots: string[]; entries: Entry[]; next_cursor?: string; can_browse: boolean; can_select: boolean; reason?: string; fallback?: boolean }
const props = defineProps<{ daemonId: string; hostName: string; initialPath: string; online: boolean }>()
const emit = defineEmits<{ close: []; select: [path: string] }>()
const { t } = useLocale()
const { send, onEvent } = useWebSocket()
const result = ref<Result>(), entries = ref<Entry[]>([]), loading = ref(false), validating = ref(false), error = ref('')
const path = ref(props.initialPath || '~/'), pathInput = ref(path.value), query = ref(''), showLocations = ref(false), showPath = ref(false)
const rowHeight = ref(window.innerWidth <= 768 ? 44 : 34), scrollTop = ref(0)
const windowStart = computed(() => entries.value.length > 300 ? Math.min(Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - 12), Math.max(0, entries.value.length - 80)) : 0)
const visibleEntries = computed(() => entries.value.length > 300 ? entries.value.slice(windowStart.value, windowStart.value + 80) : entries.value)
const bottomRows = computed(() => Math.max(0, entries.value.length - windowStart.value - visibleEntries.value.length))
function resize() { rowHeight.value = window.innerWidth <= 768 ? 44 : 34 }
const cache = new Map<string, { firstCursor?: string; result: Result; entries: Entry[] }>()
let firstCursor: string | undefined
const pickerEl = ref<HTMLElement>()
const listEl = ref<HTMLElement>(), positions = new Map<string, number>()
let requestId = '', pendingAppend = false, timer: ReturnType<typeof setTimeout> | undefined, debounce: ReturnType<typeof setTimeout> | undefined
let off: (() => void) | undefined, first = true, closed = false
const canSelect = computed(() => props.online && !!result.value?.can_select && !loading.value && !validating.value && !error.value)
function displayPath(p: string) { const home = result.value?.home; return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p }
const ancestors = computed(() => {
  const p = result.value?.path
  const root = result.value?.roots?.find(r => p === r || p?.startsWith(r === '/' ? '/' : r + '/'))
  if (!p || !root) return []
  let current = root
  return [{ path: root, name: displayPath(root) }, ...p.slice(root.length).split('/').filter(Boolean).map(name => { current = current.replace(/\/$/, '') + '/' + name; return { name, path: current } })]
})
const shortPath = computed(() => { const a = ancestors.value; return a.length > 3 ? '…/' + a.slice(-2).map(p => p.name).join('/') : displayPath(result.value?.path || path.value) })
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation(); event.preventDefault()
    if (showLocations.value || showPath.value) { showLocations.value = false; showPath.value = false }
    else emit('close')
  }
  if (event.key === 'Tab') {
    const items = Array.from(pickerEl.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') || []).filter(el => el.getClientRects().length)
    const first = items[0], last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function cancelRequest() {
  clearTimeout(timer)
  if (requestId) send({ type: 'cancel_directory', daemon_id: props.daemonId, request_id: requestId })
  requestId = ''; loading.value = false; validating.value = false
}
function request(type: string, append = false) {
  cancelRequest()
  if (!props.online) { error.value = 'daemon_offline'; return }
  error.value = ''; loading.value = type === 'list_directories'; validating.value = type === 'validate_directory'; pendingAppend = append
  requestId = createClientId()
  const sent = send({ type, daemon_id: props.daemonId, request_id: requestId, path: path.value, query: query.value, cursor: append ? result.value?.next_cursor : undefined, limit: 100, fallback: first && type === 'list_directories' })
  first = false
  if (sent === false) { cancelRequest(); error.value = 'daemon_offline'; return }
  timer = setTimeout(() => { cancelRequest(); error.value = 'timeout' }, 12000)
}
function load(append: boolean) { request('list_directories', append) }
function navigate(p: string) {
  if (!props.online) return
  if (listEl.value && result.value?.path) positions.set(result.value.path, listEl.value.scrollTop)
  if (result.value?.path && !query.value && !loading.value && !error.value && entries.value.length <= 5000) {
    cache.set(result.value.path, { firstCursor, result: result.value, entries: entries.value })
    if (cache.size > 5) cache.delete(cache.keys().next().value!)
  }
  clearTimeout(debounce); query.value = ''; path.value = p; pathInput.value = p
  entries.value = []; result.value = result.value ? { ...result.value, can_select: false, next_cursor: undefined } : undefined
  showLocations.value = false; showPath.value = false
  // query watcher handles its own debounce; cancel that before issuing navigation.
  void nextTick(() => { clearTimeout(debounce); load(false) })
}
function selectDirectory() { if (canSelect.value) request('validate_directory') }
function onScroll() { const el = listEl.value; scrollTop.value = el?.scrollTop || 0; if (el && !loading.value && !error.value && result.value?.next_cursor && el.scrollHeight - el.scrollTop - el.clientHeight < 80) load(true) }
watch(query, () => {
  cancelRequest(); error.value = ''; entries.value = []
  if (result.value) result.value = { ...result.value, can_select: false, next_cursor: undefined }
  clearTimeout(debounce); debounce = setTimeout(() => load(false), 250)
})
watch(() => props.online, online => { if (!online) { clearTimeout(debounce); cancelRequest(); error.value = 'daemon_offline' } })
onMounted(() => {
  window.addEventListener('resize', resize)
  off = onEvent('directory_result', (msg: any) => {
    if (closed || !requestId || msg.request_id !== requestId || msg.daemon_id !== props.daemonId) return
    const wasValidating = validating.value
    clearTimeout(timer); requestId = ''; loading.value = false; validating.value = false
    if (msg.reason) { error.value = msg.reason; if (msg.directory && !pendingAppend) result.value = msg.directory; return }
    if (!msg.directory?.path) { error.value = 'invalid_response'; return }
    if (wasValidating) { if (msg.directory.can_select && props.online) emit('select', msg.directory.path); else error.value = 'read_only'; return }
    const r: Result = msg.directory
    const top = pendingAppend ? listEl.value?.scrollTop || 0 : query.value ? 0 : positions.get(r.path) || 0
    const cached = !pendingAppend && !query.value ? cache.get(r.path) : undefined
    if (!pendingAppend) firstCursor = r.next_cursor
    if (cached && r.next_cursor && cached.firstCursor === r.next_cursor && cached.entries.length > r.entries.length) {
      r.entries = cached.entries; r.next_cursor = cached.result.next_cursor
    }
    entries.value = pendingAppend ? [...entries.value, ...r.entries.filter(e => !entries.value.some(old => old.path === e.path))] : r.entries
    result.value = r; path.value = r.path; pathInput.value = r.path
    scrollTop.value = top
    void nextTick(() => { if (listEl.value) listEl.value.scrollTop = top })
  })
  load(false)
  pickerEl.value?.querySelector<HTMLButtonElement>('.back')?.focus()
})
onUnmounted(() => { window.removeEventListener('resize', resize); closed = true; clearTimeout(debounce); cancelRequest(); off?.() })
</script>
<style scoped>
.directory-picker{width:800px;max-width:100%;height:min(720px,90dvh);background:var(--surface);border:1px solid var(--border);border-radius:20px;box-shadow:var(--shadow-lg);display:flex;flex-direction:column;overflow:hidden;color:var(--fg)}button,input{font:inherit;color:inherit}button{border:1px solid var(--border);border-radius:8px;background:var(--surface-hover);padding:8px 12px;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.picker-header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border)}h2{font-size:18px;flex:1;margin:0}small{font-size:12px;font-weight:400;color:var(--fg-secondary);margin-left:10px}.mobile-select,.path-menu{display:none}.path-toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px 6px}.breadcrumbs{display:flex;align-items:center;overflow:auto;flex:1;white-space:nowrap;font:12px var(--font-mono)}.breadcrumbs button{border:0;background:none;padding:8px;color:var(--fg-secondary)}.breadcrumbs span:last-child{display:none}.breadcrumbs button:last-of-type{color:var(--fg)}.breadcrumbs span{color:var(--fg-tertiary)}.path-input{display:flex;gap:8px;padding:6px 16px}.path-input input{flex:1;min-width:0;font-family:var(--font-mono)}input{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--fg)}.search{padding:6px 16px 10px}.search input{width:100%}.locations{padding:8px 16px;max-height:230px;overflow:auto;border-bottom:1px solid var(--border)}.locations>span{font-size:11px;color:var(--fg-secondary)}.locations button{display:block;width:100%;text-align:left;background:none;border:0;overflow-wrap:anywhere}.directory-list{flex:1;min-height:0;overflow:auto;margin:0 16px;overscroll-behavior:contain}.directory-row{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:5px 8px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:none;text-align:left;font-size:13px}.directory-row:hover:not(:disabled){background:var(--surface-hover)}.directory-row svg,.folder{color:var(--accent);width:18px;height:18px;flex-shrink:0}.name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.permission{color:var(--warning);font-size:11px}.secondary{color:var(--fg-secondary)}.empty{padding:22px;text-align:center;color:var(--fg-secondary);font-size:13px}.load-more{display:block;margin:10px auto}.notice,.error{font-size:12px;padding:8px 16px;overflow-wrap:anywhere}.notice{color:var(--fg-secondary)}.error{color:var(--error)}.error button{margin-left:8px}footer{display:flex;align-items:center;gap:12px;padding:14px 20px;border-top:1px solid var(--border);font-size:12px}.summary{color:var(--fg-secondary);margin-right:auto}.access{color:var(--success)}.access.readonly{color:var(--warning)}.primary{background:var(--primary-btn);color:white;font-weight:600}.primary:hover:not(:disabled){background:var(--primary-btn-hover)}
@media(max-width:768px){.directory-picker{width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0;padding-bottom:env(safe-area-inset-bottom)}.picker-header{padding:6px 12px;min-height:56px}.picker-header h2{text-align:center;font-size:17px}.picker-header small,.breadcrumbs,.up{display:none}.picker-header button{min-height:44px;border:0;background:none;color:var(--accent)}.mobile-select{display:block;font-weight:600}.path-menu{display:block;flex:1;min-width:0;text-align:left;border:0;background:none;color:var(--accent);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.path-toolbar button{min-height:44px}.search input{min-height:44px;font-size:16px}.path-input input{font-size:16px}.directory-row{min-height:44px;padding:9px 4px;font-size:14px}footer .primary,.desktop-cancel{display:none}footer{padding:10px 16px;border:0;font-size:11px}.locations button{min-height:44px}}
</style>
