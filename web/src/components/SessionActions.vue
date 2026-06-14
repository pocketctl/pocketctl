<template>
  <div class="ss-wrap">
    <!-- Trigger button -->
    <button class="ss-more-btn" :title="'更多操作'" @click.stop.prevent="toggleMenu($event)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>

    <!-- Menu -->
    <div v-if="menuOpen" class="ss-menu" :style="{ left: menuX + 'px', top: menuY + 'px' }" @click.stop>
      <button class="ss-menu-item" @click="copyId">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        <span>{{ copied ? '已复制' : '复制会话 ID' }}</span>
        <em v-if="!copied" class="ss-menu-hint">{{ session.session_id?.slice(0, 12) }}…</em>
      </button>
      <div class="ss-menu-sep"></div>
      <button class="ss-menu-item" :class="{ active: session.pinned }" @click="togglePin">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2v2H6v-2l3-3.2z"/></svg>
        <span>{{ session.pinned ? '取消固定' : '固定到顶部' }}</span>
      </button>
      <button class="ss-menu-item" @click="emit('startRename', props.session.session_id, props.session.title || props.session.session_id?.slice(0, 8) || '')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>重命名会话</span>
      </button>
      <button class="ss-menu-item" @click="openExport">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        <span>导出记录</span>
      </button>
      <div class="ss-menu-sep"></div>
      <button class="ss-menu-item danger" @click="openDelete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        <span>删除会话</span>
      </button>
    </div>

    <!-- Export dialog -->
    <div v-if="exportOpen" class="ss-overlay" @click.self.stop="exportOpen = false">
      <div class="ss-dialog ss-export-dialog" @click.stop>
        <div class="ss-export-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        </div>
        <h3 class="ss-dialog-title">导出会话记录</h3>
        <p class="ss-dialog-desc">{{ displayTitle }}</p>
        <div class="ss-format-group">
          <button v-for="f in ['md','json','txt']" :key="f" :class="['ss-format', { selected: exportFmt === f }]" @click="exportFmt = f">
            {{ f === 'md' ? 'Markdown' : f === 'json' ? 'JSON' : '纯文本' }}
          </button>
        </div>
        <div class="ss-dialog-footer">
          <button class="ss-btn-cancel" @click="exportOpen = false">取消</button>
          <button class="ss-export-confirm" @click="doExport">导出下载</button>
        </div>
      </div>
    </div>

    <!-- Delete confirm dialog -->
    <div v-if="deleteOpen" class="ss-overlay" @click.self.stop="deleteOpen = false">
      <div class="ss-dialog" @click.stop>
        <div class="ss-dialog-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>
        </div>
        <h3 class="ss-dialog-title">删除会话？</h3>
        <p class="ss-dialog-desc">将删除该会话及其所有消息和工具调用记录。删除后 5 秒内可撤销恢复。</p>
        <p class="ss-dialog-target">{{ displayTitle }}</p>
        <div class="ss-dialog-footer">
          <button class="ss-btn-cancel" @click="deleteOpen = false">取消</button>
          <button class="ss-confirm" :disabled="deleting" @click="confirmDelete">
            <span v-if="deleting" class="ss-mini-spinner"></span>{{ deleting ? '删除中' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Toast (undo) -->
    <div v-if="toast.show" class="ss-toast" @click.stop>
      <span class="ss-toast-msg">{{ toast.msg }}</span>
      <button v-if="toast.undo" class="ss-toast-undo" @click="toast.undo()">{{ toast.undoLabel || '撤销' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue'
import { useWebSocket } from '../composables/useWebSocket'
import { useAuth } from '../composables/useAuth'

const props = defineProps<{ session: any }>()
const emit = defineEmits<{
  renamed: [sessionId: string, title: string]
  deleted: [sessionId: string]
  pinned: [sessionId: string, pinned: boolean]
  startRename: [sessionId: string, oldTitle: string]
}>()

const { send, onEvent } = useWebSocket()
const { accessToken } = useAuth()

const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const copied = ref(false)
const exportOpen = ref(false)
const exportFmt = ref('md')
const deleteOpen = ref(false)
const deleting = ref(false)
const toast = ref<{ show: boolean; msg: string; undo?: () => void; undoLabel?: string }>({ show: false, msg: '' })
let deleteTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

const displayTitle = () => props.session.title || props.session.session_id?.slice(0, 8) || '会话'

function toggleMenu(e: MouseEvent) {
  if (menuOpen.value) { menuOpen.value = false; return }
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  menuX.value = r.right - 188
  menuY.value = r.bottom + 6
  if (menuX.value < 8) menuX.value = 8
  menuOpen.value = true
}

function closeMenu() { menuOpen.value = false }

// Global click/esc/scroll to close
const onDocClick = () => { if (menuOpen.value) closeMenu() }
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeMenu(); exportOpen.value = false; deleteOpen.value = false } }
const onScroll = () => closeMenu()
document.addEventListener('click', onDocClick)
document.addEventListener('keydown', onEsc)
window.addEventListener('scroll', onScroll, true)
onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onEsc)
  window.removeEventListener('scroll', onScroll, true)
  if (deleteTimer) clearTimeout(deleteTimer)
  if (toastTimer) clearTimeout(toastTimer)
})

// 1. Copy ID
async function copyId() {
  const id = props.session.session_id
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
  } catch {
    const ta = document.createElement('textarea'); ta.value = id; document.body.appendChild(ta)
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => { copied.value = false; closeMenu() }, 1200)
}

// 2. Pin
function togglePin() {
  closeMenu()
  const newPinned = !props.session.pinned
  props.session.pinned = newPinned
  send({ type: 'session_pin', session_id: props.session.session_id, pinned: newPinned })
  emit('pinned', props.session.session_id, newPinned)
  showToast(newPinned ? '已固定到顶部' : '已取消固定', () => {
    props.session.pinned = !newPinned
    send({ type: 'session_pin', session_id: props.session.session_id, pinned: !newPinned })
    emit('pinned', props.session.session_id, !newPinned)
  })
}

// 3. Rename — handled by parent (emit startRename); input renders inline at title position

// 4. Export
function openExport() { closeMenu(); exportFmt.value = 'md'; exportOpen.value = true }

async function doExport() {
  const origin = getRelayOrigin()
  try {
    const res = await fetch(`${origin}/api/sessions/${props.session.session_id}/export?format=${exportFmt.value}`, {
      headers: { Authorization: `Bearer ${accessToken.value}` },
    })
    if (!res.ok) return
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const m = cd.match(/filename="?(.+?)"?$/)
    const filename = m ? m[1] : `session.${exportFmt.value}`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
    exportOpen.value = false
    showToast(`已导出 ${filename}`)
  } catch {}
}

// 5. Delete (delayed send for undo)
function openDelete() { closeMenu(); deleteOpen.value = true }

function confirmDelete() {
  deleting.value = true
  setTimeout(() => {
    deleting.value = false
    deleteOpen.value = false
    // Mark session as pending-delete (parent may fade it out) but do NOT emit('deleted')
    // — emitting would unmount this component, and onUnmounted would clear the deleteTimer
    // before session_delete is ever sent. Instead, rely on relay's session_deleted broadcast
    // (triggered 5s below) to remove the row.
    props.session.__pendingDelete = true
    // Delay actual WS delete 5s for undo window
    deleteTimer = setTimeout(() => {
      send({ type: 'session_delete', session_id: props.session.session_id })
    }, 5000)
    showToast(`已删除「${displayTitle()}」`, () => {
      if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null }
      props.session.__pendingDelete = false
    }, '撤销')
  }, 700)
}

// Toast
function showToast(msg: string, undo?: () => void, undoLabel?: string) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { show: true, msg, undo, undoLabel }
  toastTimer = setTimeout(() => { toast.value = { show: false, msg: '' } }, 5000)
}

function getRelayOrigin(): string {
  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  try {
    const url = new URL(relayWs)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''
    return url.origin.replace(/^ws/, 'http')
  } catch { return '' }
}
</script>

<style scoped>
.ss-wrap { display: inline-flex; align-items: center; position: relative; }
.ss-more-btn { width: 28px; height: 28px; border: none; background: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s, background 0.15s, color 0.15s; flex-shrink: 0; }
.ss-more-btn:hover, .ss-wrap:hover .ss-more-btn { opacity: 1; background: var(--surface-active); color: var(--fg); }

.ss-menu { position: fixed; z-index: 200; min-width: 188px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); padding: 4px; }
.ss-menu-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: none; background: none; color: var(--fg-secondary); font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); text-align: left; transition: background 0.1s, color 0.1s; }
.ss-menu-item:hover { background: var(--surface-hover); color: var(--fg); }
.ss-menu-item.active { color: var(--accent); }
.ss-menu-item.danger { color: var(--error); }
.ss-menu-item.danger:hover { background: rgba(248,81,73,0.12); }
[data-theme="light"] .ss-menu-item.danger:hover { background: var(--error-bg); }
.ss-menu-hint { font-family: var(--font-mono); font-size: 11px; color: var(--fg-tertiary); max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; margin-left: auto; }
.ss-menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }

.ss-rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-muted); color: var(--fg); font-family: var(--font-body); font-size: 14px; font-weight: 500; padding: 4px 8px; outline: none; width: 100%; max-width: 200px; }

.ss-overlay { position: fixed; inset: 0; z-index: 210; background: rgba(1,4,9,0.6); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; animation: ss-fade 0.15s ease; }
[data-theme="light"] .ss-overlay { background: rgba(31,35,40,0.3); }
.ss-dialog { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); padding: 24px; max-width: 400px; width: 90%; text-align: center; animation: ss-slide 0.18s ease; }
.ss-export-dialog { max-width: 380px; }
.ss-dialog-icon { width: 44px; height: 44px; border-radius: 50%; background: rgba(248,81,73,0.12); color: var(--error); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; }
.ss-export-icon { width: 44px; height: 44px; border-radius: 50%; background: var(--accent-muted); color: var(--accent); display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; }
.ss-dialog-title { font-size: 17px; font-weight: 700; color: var(--fg); margin: 0 0 8px; }
.ss-dialog-desc { font-size: 13px; color: var(--fg-secondary); line-height: 1.5; margin: 0 0 8px; }
.ss-dialog-target { font-family: var(--font-mono); font-size: 12px; color: var(--fg-tertiary); margin: 0 0 16px; }
.ss-format-group { display: flex; gap: 8px; margin: 12px 0 16px; }
.ss-format { flex: 1; padding: 10px; border: 2px solid var(--border); background: var(--bg); color: var(--fg-secondary); font-size: 13px; font-weight: 600; border-radius: var(--radius-md); cursor: pointer; }
.ss-format:hover { border-color: var(--border-light); color: var(--fg); }
.ss-format.selected { border-color: var(--accent); background: var(--accent-muted); color: var(--accent); }
.ss-dialog-footer { display: flex; gap: 10px; }
.ss-btn-cancel { flex: 1; padding: 10px; border: 1px solid var(--border); background: var(--surface-hover); color: var(--fg-secondary); border-radius: var(--radius-md); cursor: pointer; font-size: 14px; }
.ss-btn-cancel:hover { background: var(--surface-active); color: var(--fg); }
.ss-confirm { flex: 1; padding: 10px; border: none; background: var(--error); color: #fff; border-radius: var(--radius-md); cursor: pointer; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.ss-confirm:hover:not(:disabled) { filter: brightness(1.1); }
.ss-confirm:disabled { opacity: 0.6; cursor: not-allowed; }
.ss-export-confirm { flex: 1; padding: 10px; border: none; background: var(--primary-btn); color: #fff; border-radius: var(--radius-md); cursor: pointer; font-size: 14px; font-weight: 600; }
.ss-export-confirm:hover { background: var(--primary-btn-hover); }
.ss-mini-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: ss-spin 0.7s linear infinite; display: inline-block; }

.ss-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 220; background: var(--surface-active); color: var(--fg); padding: 10px 16px; border-radius: var(--radius-full, 999px); font-size: 13px; display: flex; align-items: center; gap: 12px; box-shadow: var(--shadow-lg); animation: ss-toast-in 0.2s ease; }
.ss-toast-undo { background: var(--primary-btn); color: #fff; border: none; padding: 4px 12px; border-radius: var(--radius-full, 999px); font-size: 12px; font-weight: 600; cursor: pointer; }
.ss-toast-undo:hover { background: var(--primary-btn-hover); }

@keyframes ss-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ss-slide { from { opacity: 0; transform: translateY(8px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes ss-spin { to { transform: rotate(360deg); } }
@keyframes ss-toast-in { from { opacity: 0; transform: translate(-50%, 16px); } to { opacity: 1; transform: translate(-50%, 0); } }
</style>
