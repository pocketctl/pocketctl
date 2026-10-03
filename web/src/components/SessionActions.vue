<template>
  <div class="ss-wrap">
    <button ref="trigger" type="button" :aria-label="t('session.actions.more')" :aria-expanded="menuOpen || moveOpen || archiveOpen || exportOpen || deleteOpen" class="ss-more-btn" :title="t('session.actions.more')" @click.stop.prevent="toggleMenu($event)">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
    </button>

    <ActionList v-if="menuOpen || moveOpen || archiveOpen || exportOpen || deleteOpen" :anchor="trigger" :title="panelTitle" :back="!menuOpen" @back="backToMenu" @close="closeAll"><template v-if="menuOpen">
      <button class="ss-menu-item action-item" @click="copyId">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        <span>{{ copied ? t('common.copied') : t('session.actions.copy_id') }}</span>
        <em v-if="!copied" class="ss-menu-hint">{{ session.session_id?.slice(0, 12) }}…</em>
      </button>
      <div class="ss-menu-sep"></div>
      <button v-if="!archivedView" class="ss-menu-item action-item" :class="{ active: session.pinned }" @click="togglePin">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2v2H6v-2l3-3.2z"/></svg>
        <span>{{ session.pinned ? t('session.actions.unpin') : t('session.actions.pin') }}</span>
      </button>
      <button class="ss-menu-item action-item" @click="emit('startRename', props.session.session_id, props.session.title || props.session.session_id?.slice(0, 8) || '')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span>{{ t('session.actions.rename') }}</span>
      </button>
      <button class="ss-menu-item action-item" @click="openExport">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
        <span>{{ t('session.actions.export') }}</span>
      </button>
      <button v-if="!archivedView && resumeCommand" class="ss-menu-item action-item" @click="copyResumeCmd">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span>{{ t('session.actions.resume') }}</span>
      </button>
      <div class="ss-menu-sep"></div>
      <button class="ss-menu-item action-item" @click.stop="moveOpen = true; closeMenu()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <span>{{ t('workspace.move_to_project') }}</span>
      </button>
      <button class="ss-menu-item action-item" @click.stop="archivedView ? restoreArchive() : openArchive()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 13h4"/></svg>
        <span>{{ archivedView ? t('workspace.restore_session') : t('workspace.archive_session') }}</span>
      </button>
      <div class="ss-menu-sep"></div>
      <button class="ss-menu-item action-item danger" @click="openDelete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
        <span>{{ t('session.actions.delete') }}</span>
      </button>
    </template>

    <template v-else-if="moveOpen">
      <p>{{ displayTitle() }}</p>
      <button class="action-item" :class="{selected: !session.project_id}" :disabled="moving" @click.stop="moveTo(null)">{{ t('workspace.ungrouped') }}<WorkspaceIcon v-if="!session.project_id" name="check" /></button>
      <button v-for="project in projects" :key="project.id" class="action-item" :class="{selected:session.project_id===project.id}" :disabled="moving" @click.stop="moveTo(project.id)">{{ project.name }}<WorkspaceIcon v-if="session.project_id===project.id" name="check" /></button>
    </template>
    <template v-else-if="archiveOpen"><p>{{ t('workspace.archive_hint') }}</p><p>{{ displayTitle() }}</p></template>
    <template v-else-if="exportOpen"><p>{{ displayTitle() }}</p><button v-for="f in ['md','json','txt']" :key="f" class="action-item" :class="{selected:exportFmt===f}" @click="exportFmt=f">{{ f === 'md' ? t('session.export_markdown') : f === 'json' ? t('session.export_json') : t('session.export_text') }}<WorkspaceIcon v-if="exportFmt===f" name="check" /></button></template>
    <template v-else-if="deleteOpen"><p>{{ t('session.delete_dialog_desc') }}</p><p>{{ displayTitle() }}</p></template>
    <template v-if="!menuOpen" #footer>
      <button type="button" @click="backToMenu">{{ t('common.cancel') }}</button>
      <button v-if="archiveOpen" type="button" class="primary" :disabled="archiving" @click="confirmArchive">{{ t('workspace.confirm_archive') }}</button>
      <button v-if="exportOpen" type="button" class="primary" :disabled="exporting" @click="doExport">{{ t('session.export_confirm') }}</button>
      <button v-if="deleteOpen" type="button" class="danger" :disabled="deleting" @click="confirmDelete">{{ deleting ? t('session.actions.deleting') : t('session.actions.delete_confirm') }}</button>
    </template>
    </ActionList>

    <!-- Toast (undo) -->
    <Teleport to="body">
    <div v-if="toast.show" class="ss-toast" @click.stop>
      <span class="ss-toast-msg">{{ toast.msg }}</span>
      <button v-if="toast.undo" class="ss-toast-undo" @click="toast.undo()">{{ toast.undoLabel || t('session.actions.undo') }}</button>
    </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import ActionList from './ActionList.vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
import { useWebSocket } from '../composables/useWebSocket'
import { useAuth } from '../composables/useAuth'
import { useLocale } from '../composables/useLocale'
import { getRelayOrigin } from '../composables/useEnv'
import { buildResumeCommand } from '../utils/resumeCommand'
import { moveSession, archiveSession, type SessionProject } from '../services/sessionOrganization'

const props = withDefaults(defineProps<{ session: any; projects?: SessionProject[]; archivedView?: boolean }>(), { projects: () => [], archivedView: false })
const emit = defineEmits<{
  renamed: [sessionId: string, title: string]
  deleted: [sessionId: string]
  pinned: [sessionId: string, pinned: boolean]
  startRename: [sessionId: string, oldTitle: string]
  moved: [sessionId: string, projectId: string | null]
  archived: [sessionId: string, archived: boolean]
}>()

const { send, onEvent } = useWebSocket()
const { accessToken } = useAuth()
const { t } = useLocale()

const trigger = ref<HTMLButtonElement | null>(null)
const exporting = ref(false)
const menuOpen = ref(false)
const copied = ref(false)
const exportOpen = ref(false)
const exportFmt = ref('md')
const deleteOpen = ref(false)
const moveOpen = ref(false)
const moving = ref(false)
const archiveOpen = ref(false)
const archiving = ref(false)
const deleting = ref(false)
const toast = ref<{ show: boolean; msg: string; undo?: () => void; undoLabel?: string }>({ show: false, msg: '' })
let deleteTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
let mounted = true

const displayTitle = () => props.session.title || props.session.session_id?.slice(0, 8) || t('session.title_default')
const resumeCommand = computed(() => buildResumeCommand(props.session))

function toggleMenu(e: MouseEvent) {
  if (menuOpen.value) { menuOpen.value = false; return }
  const btn = e.currentTarget as HTMLButtonElement
  trigger.value = btn
  menuOpen.value = true
}
function closeMenu() { menuOpen.value = false }
const panelTitle = computed(() => moveOpen.value ? t('workspace.move_to_project') : archiveOpen.value ? t('workspace.archive_session') : exportOpen.value ? t('session.export_dialog_title') : deleteOpen.value ? t('session.delete_dialog_title') : t('session.actions.more'))
function closeAll() { menuOpen.value=false; exportOpen.value=false; deleteOpen.value=false; moveOpen.value=false; archiveOpen.value=false }
function backToMenu() { closeAll(); menuOpen.value=true }
onUnmounted(() => {
  mounted = false
  if (toastTimer) clearTimeout(toastTimer)
})

// 1. Copy ID
async function copyId() {
  const id = props.session.session_id
  if (!id) return
  try { await navigator.clipboard.writeText(id) }
  catch { const ta = document.createElement('textarea'); ta.value = id; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta) }
  copied.value = true
  setTimeout(() => { copied.value = false; closeMenu() }, 1200)
}

// 1b. Copy resume command
async function copyResumeCmd() {
  if (props.archivedView) return
  const cmd = resumeCommand.value
  if (!cmd) return
  try { await navigator.clipboard.writeText(cmd) }
  catch { const ta = document.createElement('textarea'); ta.value = cmd; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta) }
  closeMenu()
  showToast(t('session.actions.resume_toast'))
}

// 2. Pin
function togglePin() {
  if (props.archivedView) return
  closeMenu()
  const newPinned = !props.session.pinned
  props.session.pinned = newPinned
  send({ type: 'session_pin', session_id: props.session.session_id, pinned: newPinned })
  emit('pinned', props.session.session_id, newPinned)
  showToast(newPinned ? t('session.actions.pinned_toast') : t('session.actions.unpinned_toast'), () => {
    props.session.pinned = !newPinned
    send({ type: 'session_pin', session_id: props.session.session_id, pinned: !newPinned })
    emit('pinned', props.session.session_id, !newPinned)
  })
}

// 4. Export
function openExport() { closeMenu(); exportFmt.value = 'md'; exportOpen.value = true }
async function doExport() {
  if (exporting.value) return
  exporting.value = true
  const origin = getRelayOrigin()
  try {
    const res = await fetch(`${origin}/api/sessions/${props.session.session_id}/export?format=${exportFmt.value}`, { headers: { Authorization: `Bearer ${accessToken.value}` } })
    if (!res.ok) throw new Error(t('workspace.export_failed'))
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const m = cd.match(/filename="?(.+?)"?$/)
    const filename = m ? m[1] : `session.${exportFmt.value}`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
    exportOpen.value = false
    showToast(t('session.actions.exported_toast', { filename }))
  } catch (error) { showToast(error instanceof Error ? error.message : t('workspace.export_failed')) }
  finally { exporting.value = false }
}

// 5. Delete
async function moveTo(projectId: string | null) {
  moving.value = true
  try {
    await moveSession(props.session.session_id, projectId)
    props.session.project_id = projectId
    emit('moved', props.session.session_id, projectId)
    moveOpen.value = false
  } catch (error) { showToast(error instanceof Error ? error.message : t('workspace.move_failed')) }
  finally { moving.value = false }
}
function openArchive() { closeMenu(); archiveOpen.value = true }
async function confirmArchive() {
  archiving.value = true
  try {
    await archiveSession(props.session.session_id, true)
    emit('archived', props.session.session_id, true)
    archiveOpen.value = false
  } catch (error) { showToast(error instanceof Error ? error.message : t('workspace.archive_failed')) }
  finally { archiving.value = false }
}
async function restoreArchive() {
  closeMenu()
  try {
    await archiveSession(props.session.session_id, false)
    emit('archived', props.session.session_id, false)
  } catch (error) { showToast(error instanceof Error ? error.message : t('workspace.restore_failed')) }
}
function openDelete() { closeMenu(); deleteOpen.value = true }
function confirmDelete() {
  if (deleting.value || props.session.__pendingDelete) return
  // A confirmed operation belongs to its original session, even if navigation
  // removes this row or reuses it before the undo window expires.
  const session = props.session
  const sessionId = session.session_id
  const title = displayTitle()
  deleting.value = true
  setTimeout(() => {
    deleting.value = false; deleteOpen.value = false
    session.__pendingDelete = true
    deleteTimer = setTimeout(() => { deleteTimer = null; send({ type: 'session_delete', session_id: sessionId }) }, 5000)
    if (mounted) showToast(t('workspace.deleted_session', {title}), () => { if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null }; session.__pendingDelete = false }, t('session.actions.undo'))
  }, 700)
}

function showToast(msg: string, undo?: () => void, undoLabel?: string) {
  if (toastTimer) clearTimeout(toastTimer)
  toast.value = { show: true, msg, undo, undoLabel }
  toastTimer = setTimeout(() => { toast.value = { show: false, msg: '' } }, 5000)
}
</script>

<style scoped>
.ss-wrap { display: inline-flex; align-items: center; position: relative; }
.ss-more-btn { width: 28px; height: 28px; border: none; background: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; opacity: 1; transition: opacity 0.15s, background 0.15s, color 0.15s; flex-shrink: 0; }
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
.ss-choice-dialog { text-align: left; }
.ss-choice-list { max-height: min(300px, 45dvh); overflow-y: auto; margin: 12px 0; }
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
