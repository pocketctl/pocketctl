<template>
  <div class="session-layout">
    <!-- Session List Panel -->
    <div class="session-panel">
      <div class="session-panel-header">
        <h3>{{ daemonName }}</h3>
        <button class="btn-icon" style="width:28px;height:28px;border:none;background:var(--accent);color:#fff;" :title="t('session.new_session')" @click="emitNewSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div style="padding:4px 8px;display:flex;align-items:center;gap:6px;">
        <span :class="['status-dot', { online: isDaemonOnline }]" style="width:6px;height:6px;"></span>
        <span style="font-size:11px;color:var(--fg-tertiary);">{{ isDaemonOnline ? t('dashboard.online') : t('dashboard.offline') }} · {{ statusSubtext }}</span>
      </div>
      <div v-if="hostFilter" class="host-filter-chip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20M17 2v20M2 12h20"/></svg>
        <span class="hfc-name">{{ daemonName }}</span>
        <button class="hfc-clear" @click="clearHostFilter" :title="t('session.show_all_hosts')">✕</button>
      </div>
      <div class="session-list">
        <div v-for="s in visibleSessions" :key="s.session_id"
          :class="['session-list-item', { active: s.session_id === sessionId, 'pending-delete': (s as any).__pendingDelete }]"
          @click="!(s as any).__pendingDelete && $router.push(`/session/${s.session_id}`)">
          <span :class="['status-dot', s.statusEffective || s.status]" style="width:7px;height:7px;"></span>
          <div class="sl-info">
            <div :class="['sl-title', { mono: !s.title || s.title.startsWith('Terminal Session') }]">
              <svg v-if="s.pinned" class="pin-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;"><path d="M16 3l5 5-3 1-3 3-1 5-2-2-5 5-1-1 5-5-2-2 5-1 3-3z"/></svg>
              <input v-if="renamingId === s.session_id" class="ss-rename-input" v-model="renameInput" maxlength="60"
                @click.stop @keydown.enter="commitRename(s)" @keydown.escape="cancelRename" @blur="commitRename(s)" />
              <template v-else>{{ s.title || s.session_id.slice(0, 8) }}</template>
            </div>
            <div class="sl-meta">{{ formatRelativeTime(s.last_activity_at || s.updated_at) }}<span v-if="s.subagent_count > 0"> · {{ t('session.sub_agents', { n: s.subagent_count }) }}</span></div>
          </div>
          <SessionActions :session="s" @startRename="startRename" @deleted="onDeleted" @pinned="onPinned" />
        </div>
      </div>
    </div>

    <!-- Chat Main Area -->
    <div class="chat-area">
      <!-- Chat Toolbar -->
      <div class="chat-toolbar">
        <div class="session-label">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" @click="$router.push('/')"><path d="M15 18l-6-6 6-6"/></svg>
          {{ sessionTitle || sessionId?.slice(0, 8) }}
          <span class="daemon-name">· {{ daemonName }}</span>
        </div>
        <span :class="['status-pill', statusClass]"><span class="pulse"></span>{{ statusLabel }}</span>
        <span v-if="contextTokens" class="context-pill" :title="t('session.context_usage')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          {{ contextTokens }}
        </span>
        <div class="session-id-box">
          <code class="session-id-text">{{ sessionId?.slice(0, 8) }}</code>
          <button class="copy-btn" @click="copySessionId" :title="copied ? t('common.copied') : t('session.actions.copy_id')">
            <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button v-if="currentSessionAgent !== 'opencode'" class="copy-btn" style="margin-left:6px;" :title="resumeCopied ? t('session.actions.resume_toast') : t('session.actions.resume') + t('session.actions.resume_hint')" @click="copyResumeCmd">
            <svg v-if="!resumeCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div class="chat-messages" ref="messagesEl" @scroll="onMessagesScroll">
        <!-- Exit Banner -->
        <div v-if="status === 'exited'" class="banner banner-info" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span>{{ t('session.exited_banner') }}</span>
          <span v-if="exitReason" style="margin-left:4px;">· {{ exitReasonLabel(exitReason) }}</span>
          <button v-if="isDaemonOnline" class="btn btn-accent" style="margin-left:auto;padding:4px 12px;font-size:12px;" @click="focusResumeInput">Resume</button>
        </div>

        <!-- Disconnected Banner -->
        <div v-if="isDisconnected" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{{ t('session.daemon_offline') }}</span>
        </div>

        <!-- Timeline -->
        <div class="timeline" v-if="milestones.length > 0">
          <template v-for="(m, i) in milestones" :key="i">
            <div class="milestone">
              <div :class="['dot', m.state]"></div>
              <span :class="['label', m.state === 'current' || m.state === 'active' ? 'active' : '']">{{ m.label }}</span>
              <span class="time">{{ m.time }}</span>
            </div>
            <div v-if="i < milestones.length - 1" :class="['line', { done: m.state === 'active' }]"></div>
          </template>
        </div>

        <!-- Messages -->
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message (right bubble) -->
          <MessageUser v-if="msg.role === 'user'" :content="cleanContent(msg.content)" />

          <!-- Agent text message (full-width block) -->
          <MessageAgent
            v-else-if="msg.type === 'agent_text'"
            :content="cleanContent(msg.content)"
            :streaming="msg.streaming"
          />

          <!-- Tool call / subagent (full-width block) -->
          <ToolCallCard
            v-else-if="msg.type === 'tool_call' || msg.type === 'subagent'"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />

          <!-- Error message (full-width block) -->
          <MessageError v-else-if="msg.type === 'error'" :content="msg.content || msg.error" />

          <!-- Command execution receipt -->
          <CommandReceiptCard v-else-if="msg.type === 'command_receipt'" :command="msg.command" :status="msg.receiptStatus" :message="msg.message" />
        </template>
      </div>

      <!-- Chat Input — unified container with embedded controls -->
      <div class="chat-input-area" :class="{ ended: !canInput }">
        <!-- Scroll-to-bottom: absolute child of chat-input-area, floats above
             its top edge. Doesn't take up flex space in chat-messages. -->
        <Transition name="scroll-btn">
          <button v-if="messages.length > 0 && !autoScroll" class="scroll-to-bottom" :title="t('session.scroll_to_bottom')" @click="scrollToBottom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
          </button>
        </Transition>
        <template v-if="canInput">
          <div class="chat-input-container" :class="{ focused: isInputFocused }">
            <!-- Slash command popover -->
            <CommandPopover
              v-if="showPopover"
              :commands="filteredCommands"
              :active-index="selectedIndex"
              @select="applyCommand"
              @hover="selectedIndex = $event"
            />
            <!-- Textarea (multi-line) -->
            <textarea
              v-model="messageInput"
              class="chat-textarea"
              :placeholder="isPendingSession ? t('session.input_creating') : (isDaemonSession && isTerminal ? t('session.input_resume') : t('session.input_send'))"
              @keydown="onInputKeydown"
              @focus="isInputFocused = true"
              @blur="isInputFocused = false"
              :disabled="isDisconnected || isPendingSession || isLoading"
              ref="inputEl"
              rows="3"
            ></textarea>

            <!-- Bottom control row -->
            <div class="input-controls">
              <!-- Left: permission mode dropdown -->
              <div class="perm-dropdown" ref="permDropdownEl">
                <button class="perm-trigger" @click="showPermMenu = !showPermMenu" :title="`当前: ${t(currentPermLabel)}`">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span class="perm-label">{{ t(currentPermLabel) }}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <Transition name="perm-menu">
                  <div v-if="showPermMenu" class="perm-menu">
                    <button v-for="m in PERMISSION_MODES" :key="m.value"
                      :class="['perm-menu-item', { active: currentPermissionMode === m.value }]"
                      @click="setPermissionMode(m.value); showPermMenu = false">
                      <span class="perm-menu-name">{{ t(m.label) }}</span>
                      <svg v-if="currentPermissionMode === m.value" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                    </button>
                  </div>
                </Transition>
              </div>

              <!-- Right: context usage + send/stop button -->
              <div class="input-right">
                <div v-if="contextTokens" class="ctx-indicator" :title="contextTooltip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                  <span class="ctx-value">{{ contextTokens }}</span>
                </div>

                <!-- Send button (idle) -->
                <button v-if="!isExecuting" class="action-btn send-btn"
                  @click="sendMessage"
                  :disabled="isDisconnected || isPendingSession || isLoading || !messageInput.trim()"
                  :title="t('session.send_enter')">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
                </button>

                <!-- Stop button (executing) -->
                <button v-else class="action-btn stop-btn"
                  @click="interruptSession"
                  :title="t('session.stop_gen')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="ended-text">{{ t('session.ended') }}</div>
      </div>
    </div>
  </div>

  <NewSessionDialog
    v-if="showNewSession"
    :daemons="daemonList"
    :preSelectedDaemonId="hostFilter"
    @close="showNewSession = false"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import SessionActions from '../components/SessionActions.vue'
import CommandPopover from '../components/CommandPopover.vue'
import CommandReceiptCard from '../components/CommandReceiptCard.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageError from '../components/messages/MessageError.vue'
import { useLocale } from '../composables/useLocale'
import ToolCallCard from '../components/messages/ToolCallCard.vue'
import { buildResumeCommand } from '../utils/resumeCommand'
import { formatToolInput } from '../utils/toolDisplay'
import { useSessionRename } from '../composables/useSessionRename'
import type { CommandItem } from '../composables/useWebSocket'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()

const route = useRoute()
const router = useRouter()
const { connect, send, onEvent } = useWebSocket()
const { t } = useLocale()

const sessionId = computed(() => route.params.id as string)
const messages = ref<any[]>([])
const allSessions = ref<any[]>([])
const messageInput = ref('')
const commandsCache = ref<CommandItem[]>([])
const replayReqId = ref(0)
const isLoading = ref(false)
// session-history-pagination: backward pagination state
const pageSize = computed(() => 50)  // session-history-pagination: 一次加载 50 条（平衡首屏/翻页性能）
const loadedMinId = ref(0)      // oldest loaded event id (backward cursor)
const isLoadingBackward = ref(false)  // a pagination (scroll-up) request in flight
const hasMore = ref(false)      // relay signaled older events exist
const resumeCopied = ref(false)  // session-resume-command: 复制恢复命令反馈
const showNewSession = ref(false)
const daemonList = computed(() => Object.values(daemons.value))
const currentSessionAgent = computed(() => allSessions.value.find((x: any) => x.session_id === sessionId.value)?.agent)
const isPendingSession = computed(() => sessionId.value.startsWith('pending-'))
const selectedIndex = ref(0)
const popoverDismissed = ref(false)
const status = ref('running')
const exitReason = ref('')
const currentPermissionMode = ref('acceptEdits')
const showPermMenu = ref(false)
const PERMISSION_MODES = [
  { value: 'default', label: 'session.perm_default' },
  { value: 'acceptEdits', label: 'session.perm_accept_edits' },
  { value: 'plan', label: 'session.perm_plan' },
]
const PERM_LABELS: Record<string, string> = { default: 'session.perm_default', acceptEdits: 'session.perm_accept_edits', plan: 'session.perm_plan' }
const currentPermLabel = computed(() => PERM_LABELS[currentPermissionMode.value] || currentPermissionMode.value)
const exitedAt = ref('')
const autoScroll = ref(true)
const copied = ref(false)
const messagesEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const permDropdownEl = ref<HTMLElement | null>(null)
const isInputFocused = ref(false)
const daemons = ref<Record<string, any>>({})
const hostFilter = computed(() => (route.query.host as string) || '')
const visibleSessions = computed(() => {
  if (!hostFilter.value) return allSessions.value
  return allSessions.value.filter((s: any) => s.daemon_id === hostFilter.value)
})

const statusClass = computed(() => {
  const map: Record<string, string> = { running: 'running', busy: 'running', idle: 'running', completed: '', error: '', killed: '', disconnected: '', exited: '' }
  return map[status.value] || ''
})

const statusLabel = computed(() => {
  const STATUS_KEYS: Record<string, string> = { running: 'session.status.running', busy: 'session.status.busy', idle: 'session.status.idle', completed: 'session.status.completed', error: 'session.status.error', killed: 'session.status.killed', disconnected: 'session.status.disconnected', exited: 'session.status.exited' }
  return t(STATUS_KEYS[status.value] || 'session.status.running')
})

const isDaemonOnline = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_online ?? true
})

const isDisconnected = computed(() => status.value === 'disconnected' || !isDaemonOnline.value)
const isTerminal = computed(() => ['completed', 'error', 'killed'].includes(status.value))
// Daemon-created sessions can be resumed (via claude --resume) even after completion,
// so the input box stays available as long as the daemon is online.
const isDaemonSession = computed(() => {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value)
  return s?.source === 'daemon'
})
const canInput = computed(() => !isDisconnected.value && (!isTerminal.value || isDaemonSession.value))
// Agent is actively generating (send button → stop button)
const isExecuting = computed(() => status.value === 'running' || status.value === 'busy')

const daemonName = computed(() => {
  if (hostFilter.value) {
    const d = daemons.value[hostFilter.value]
    return d?.daemon_alias || d?.hostname || hostFilter.value.slice(0, 8)
  }
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_alias || s?.hostname || s?.daemon_id?.slice(0, 8) || t('session.unknown_host')
})
function clearHostFilter() {
  const q = { ...route.query }
  delete q.host
  router.replace({ query: q })
}

const sessionTitle = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.title
})

const statusSubtext = computed(() => isDaemonOnline.value ? t('session.status.connected') : t('session.status.waiting'))

// Context token usage — from the last agent_text message that carried usage.
const contextTokens = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const u = (messages.value[i] as any).usage
    if (u) {
      const total = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_create_tokens || 0)
      return total > 1000 ? (total / 1000).toFixed(1) + 'K' : String(total)
    }
  }
  return ''
})

const contextTooltip = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const u = (messages.value[i] as any).usage
    if (u) {
      const parts: string[] = []
      if (u.input_tokens) parts.push(`${t('session.context_input')}: ${u.input_tokens.toLocaleString()}`)
      if (u.output_tokens) parts.push(`${t('session.context_output')}: ${u.output_tokens.toLocaleString()}`)
      if (u.cache_read_tokens) parts.push(`${t('session.context_cache_read')}: ${u.cache_read_tokens.toLocaleString()}`)
      if (u.cache_create_tokens) parts.push(`${t('session.context_cache_create')}: ${u.cache_create_tokens.toLocaleString()}`)
      return parts.length ? t('session.context_usage') + '\n' + parts.join('\n') : ''
    }
  }
  return ''
})

const milestones = computed(() => {
  const ms: any[] = []
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  if (!s) return ms
  if (s.created_at) ms.push({ label: t('session.milestone_created'), time: formatTime(s.created_at), state: 'active' })
  ms.push({ label: t('session.status.running'), time: formatTime(s.last_activity_at || s.updated_at || s.created_at), state: status.value === 'running' || status.value === 'busy' ? 'current' : 'active' })
  ms.push({ label: statusLabel.value, time: '—', state: isTerminal.value || status.value === 'exited' ? 'active' : '' })
  return ms
})

let copyTimer: ReturnType<typeof setTimeout> | null = null
function copySessionId() {
  navigator.clipboard.writeText(sessionId.value).then(() => {
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2000)
  }).catch(() => {})
}

// session-resume-command: copy `cd "<cwd>" && <agent resume <sid>>` for terminal handoff
function copyResumeCmd() {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value)
  if (!s) return
  const cmd = buildResumeCommand({ agent: (s as any).agent, cwd: (s as any).cwd, session_id: sessionId.value })
  navigator.clipboard.writeText(cmd).then(() => {
    resumeCopied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { resumeCopied.value = false }, 2000)
  }).catch(() => {})
}

function formatTime(ts: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
}

function cleanContent(text: string): string {
  if (!text) return ''
  return text
    .replace(/<command-name>.*?<\/command-name>\s*/gs, '')
    .replace(/<command-message>.*?<\/command-message>\s*/gs, '')
    .replace(/<command-args>.*?<\/command-args>\s*/gs, '')
    .replace(/<local-command-caveat>.*?<\/local-command-caveat>\s*/gs, '')
    .replace(/<local-command-stdout>(.*?)<\/local-command-stdout>/gs, '$1')
    .replace(/<local-command-stderr>(.*?)<\/local-command-stderr>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = { user_interrupt: '用户中断', normal_exit: '正常退出', process_crash: '异常退出', signal_kill: '被终止', unknown: '已退出' }
  return labels[reason] || reason
}

function emitNewSession() { showNewSession.value = true }

function scrollToBottom() {
  if (messagesEl.value) { messagesEl.value.scrollTop = messagesEl.value.scrollHeight; autoScroll.value = true }
}

function onMessagesScroll() {
  if (!messagesEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = messagesEl.value
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 60
  // session-history-pagination: scrolled to top → fetch older page (backward)
  if (scrollTop < 60 && hasMore.value && !isLoadingBackward.value && !isLoading.value && loadedMinId.value > 0) {
    isLoadingBackward.value = true
    replayReqId.value++
    send({ type: 'replay', session_id: sessionId.value, direction: 'backward', last_seq: loadedMinId.value, limit: pageSize.value, req_id: replayReqId.value })
  }
}

function focusResumeInput() { if (inputEl.value) { inputEl.value.focus() } }

function setPermissionMode(mode: string) {
  send({ type: 'set_permission_mode', session_id: sessionId.value, content: mode })
}

function interruptSession() {
  send({ type: 'session_interrupt', session_id: sessionId.value })
}

function sendMessage() {
  const text = messageInput.value.trim()
  if (!text || isDisconnected.value) return
  if (isPendingSession.value) return // D3: pending-id 窗口期不发命令（--resume pending-xxx 必失败）
  send({ type: 'user_message', session_id: sessionId.value, content: text })
  messageInput.value = ''
}

// Slash command autocompletion
const filteredCommands = computed(() => {
  const input = messageInput.value
  if (!input.startsWith('/')) return []
  const prefix = input.slice(1).toLowerCase()
  const pool = commandsCache.value
  if (prefix === '') return pool.slice(0, 50)
  return pool.filter(c => c.name.toLowerCase().startsWith(prefix)).slice(0, 50)
})
const showPopover = computed(() => !popoverDismissed.value && filteredCommands.value.length > 0)

// Reset selection/dismissal whenever the input changes
watch(messageInput, () => {
  selectedIndex.value = 0
  popoverDismissed.value = false
  // Auto-resize textarea
  if (inputEl.value) {
    inputEl.value.style.height = 'auto'
    inputEl.value.style.height = Math.min(inputEl.value.scrollHeight, 200) + 'px'
  }
})

function onInputKeydown(e: KeyboardEvent) {
  // Alt/Option+Enter or Shift+Enter → insert newline (checked first, even
  // when popover is open, so /command<Alt+Enter> doesn't auto-apply).
  if (e.key === 'Enter' && (e.altKey || e.shiftKey)) {
    e.preventDefault()
    const el = inputEl.value
    if (el) {
      const start = el.selectionStart
      const end = el.selectionEnd
      messageInput.value = messageInput.value.slice(0, start) + '\n' + messageInput.value.slice(end)
      nextTick(() => {
        el.selectionStart = el.selectionEnd = start + 1
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
      })
    }
    return
  }

  if (showPopover.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value + 1) % filteredCommands.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      applyCommand(filteredCommands.value[selectedIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      popoverDismissed.value = true
      return
    }
    return // popover open: don't process Enter below
  }

  // Enter (no modifier) → send
  if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    sendMessage()
  }
}

function applyCommand(item: CommandItem) {
  if (!item) return
  messageInput.value = '/' + item.name + ' '
  popoverDismissed.value = true
  nextTick(() => { inputEl.value?.focus() })
}

const msgCounter = { value: 0 }
function nextId(prefix: string) { return prefix + (++msgCounter.value) }

// Dedup: only skip an event if it's identical to the immediately preceding one
// (guards against relay batch re-send / reconnect). We intentionally do NOT dedup
// by content globally — claude -p's synthetic command replies (e.g. "No response
// requested.", "/model isn't available...") share text across history and new
// commands, so a global Set would wrongly swallow a new command's reply that
// matches a historical one.
function isDuplicate(type: string, text: string, target = messages.value): boolean {
  const last = target[target.length - 1]
  return !!last && last.type === type && (last.content || '') === text
}

function processEvent(evt: any, target: any[] = messages.value) {
  const type = evt.type || evt.event_type
  if (type === 'user_text') {
    const text = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    if (text && !isDuplicate('user_text', text, target)) target.push({ id: nextId('u'), type: 'user_text', role: 'user', content: text })
  } else if (type === 'agent_text') {
    const content = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    if (!content || isDuplicate('agent_text', content, target)) return
    const streaming = evt.streaming ?? evt.payload?.streaming ?? false
    const usage = evt.usage || evt.payload?.usage
    const last = target[target.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !content.startsWith('\n')) {
      last.content += content
      if (!streaming) last.streaming = false
      if (usage) last.usage = usage
    } else {
      target.push({ id: nextId('a'), type: 'agent_text', role: 'agent', content, streaming, usage })
    }
  } else if (type === 'tool_call') {
    const callId = evt.call_id || evt.payload?.call_id
    if (!callId) return
    const tool = evt.tool || evt.payload?.tool || ''
    const input = evt.input || evt.payload?.input
    const inputDesc = formatToolInput(tool, input)
    // Always create new tool_call message (matches iOS app)
    target.push({
      id: nextId('t'), type: 'tool_call', call_id: callId,
      tool, input, inputDesc,
      output: null, status: 'running',
      expanded: false, outputExpanded: false,
    })
  } else if (type === 'tool_result') {
    const callId = evt.call_id || evt.payload?.call_id
    const output = evt.output || evt.payload?.output || evt.result || evt.payload?.result
    if (!callId) return
    // Find last matching tool_call (matches iOS app lastIndex logic)
    let idx = -1
    for (let i = target.length - 1; i >= 0; i--) {
      if (target[i].type === 'tool_call' && target[i].call_id === callId) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      if (output) target[idx].output = output
      target[idx].status = 'completed'
    }
  } else if (type === 'session_status') {
    const s = evt.status || evt.payload?.status
    if (s) status.value = s
    if (evt.exit_reason || evt.payload?.exit_reason) exitReason.value = evt.exit_reason || evt.payload.exit_reason
    if (evt.exited_at || evt.payload?.exited_at) exitedAt.value = evt.exited_at || evt.payload.exited_at
  } else if (type === 'command_receipt') {
    target.push({
      id: nextId('r'), type: 'command_receipt',
      command: evt.command || '', receiptStatus: evt.receipt_status || 'success',
      message: evt.message || '',
    })
  }
}

// Watch for session switch — clear messages and replay new session
watch(sessionId, (newId, oldId) => {
  if (newId && newId !== oldId) {
    messages.value = []
    status.value = 'running'
    exitReason.value = ''
    exitedAt.value = ''
    commandsCache.value = []
    replayReqId.value++
    isLoading.value = true
    loadedMinId.value = 0
    isLoadingBackward.value = false
    hasMore.value = false
    send({ type: 'replay', session_id: newId, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    send({ type: 'list_commands', session_id: newId })
  }
})

const cleanups: (() => void)[] = []

onMounted(() => {
  connect()
  send({ type: 'list_sessions' })
  send({ type: 'list_daemons' })
  replayReqId.value++
  isLoading.value = true
  loadedMinId.value = 0
  isLoadingBackward.value = false
  hasMore.value = false
  send({ type: 'replay', session_id: sessionId.value, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
  send({ type: 'list_commands', session_id: sessionId.value })

  cleanups.push(onEvent('session_list', (msg: any) => {
    allSessions.value = msg.sessions || []
    // 从主机"查看全部"跳来（带 host query + default 哨兵）→ 自动落到该主机首个会话
    if (hostFilter.value && sessionId.value === 'default') {
      const first = allSessions.value.find((s: any) => s.daemon_id === hostFilter.value)
      if (first) router.replace({ path: `/session/${first.session_id}`, query: { host: hostFilter.value } })
    }
  }))
  cleanups.push(onEvent('daemon_list', (msg: any) => {
    const map: Record<string, any> = {}
    for (const d of (msg.daemons || [])) map[d.daemon_id] = d
    daemons.value = map
  }))
  cleanups.push(onEvent('command_list', (msg: any) => {
    if (msg.session_id !== sessionId.value) return // discard stale responses from other sessions
    commandsCache.value = msg.commands || []
  }))
  cleanups.push(onEvent('command_receipt', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('replay_batch', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return // D4: stale batch
    const isBackward = msg.direction === 'backward'
    // backward batches arrive in id DESC; reverse to ASC for chronological render/prepend
    const evts = isBackward ? [...msg.events].reverse() : msg.events
    if (isLoadingBackward.value && isBackward) {
      // pagination: build page into a temp array, prepend in ONE shot, then manually
      // restore scrollTop so the viewport stays on the exact same content.
      // overflow-anchor is DISABLED (CSS) because it mis-anchors to the newly prepended
      // top element and yanks the viewport to the oldest record. Manual restore is precise.
      const oldScrollHeight = messagesEl.value?.scrollHeight || 0
      const oldScrollTop = messagesEl.value?.scrollTop || 0
      const tempMsgs: any[] = []
      for (const evt of evts) processEvent(evt, tempMsgs)
      if (tempMsgs.length) messages.value = [...tempMsgs, ...messages.value]
      nextTick(() => {
        if (!messagesEl.value) return
        const delta = messagesEl.value.scrollHeight - oldScrollHeight
        messagesEl.value.scrollTop = oldScrollTop + delta
      })
    } else {
      // initial load (first backward page, or legacy forward full-load): render + scroll bottom
      for (const evt of evts) processEvent(evt)
      nextTick(scrollToBottom)
    }
  }))
  cleanups.push(onEvent('replay_end', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return
    isLoading.value = false
    isLoadingBackward.value = false
    if (msg.has_more !== undefined) hasMore.value = !!msg.has_more
    // backward: last_seq is the oldest id of the returned page → next page cursor
    if (msg.last_seq && (!loadedMinId.value || msg.last_seq < loadedMinId.value)) loadedMinId.value = msg.last_seq
  }))

  cleanups.push(onEvent('user_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('agent_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('tool_call', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('tool_result', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
  }))

  cleanups.push(onEvent('subagent_discovered', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    messages.value.push({ id: nextId('sa'), type: 'subagent', tool: msg.agent_id || 'Agent', input: msg.subagent_desc, status: 'completed', expanded: true, outputExpanded: false })
  }))

  cleanups.push(onEvent('session_status', (msg: any) => {
    if (msg.session_id === sessionId.value) { status.value = msg.status; if (msg.exit_reason) exitReason.value = msg.exit_reason; if (msg.exited_at) exitedAt.value = msg.exited_at }
  }))

  cleanups.push(onEvent('permission_mode_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    currentPermissionMode.value = msg.permission_mode || 'acceptEdits'
  }))

  // 兜底：URL 仍是 pending 时，session_id_changed 到达则替换为真实 ID 并重新 replay
  cleanups.push(onEvent('session_id_changed', (msg: any) => {
    if (msg.old_session_id && msg.old_session_id === sessionId.value) {
      router.replace(`/session/${msg.session_id}`)
      // 清空旧消息，重新拉取真实 ID 的历史
      messages.value = []
      replayReqId.value++
      isLoading.value = true
      send({ type: 'replay', session_id: msg.session_id, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    }
  }))

  cleanups.push(onEvent('error', (msg: any) => {
    if (msg.session_id && msg.session_id !== sessionId.value) return
    messages.value.push({ id: nextId('e'), type: 'error', content: msg.error || '未知错误' })
  }))

  cleanups.push(onEvent('session_deleted', (msg: any) => {
    allSessions.value = allSessions.value.filter((s: any) => s.session_id !== msg.session_id)
    if (msg.session_id === sessionId.value) {
      const next = allSessions.value[0]
      if (next) router.push(`/session/${next.session_id}`)
    }
  }))

  cleanups.push(onEvent('session_pinned', (msg: any) => {
    const s = allSessions.value.find((x: any) => x.session_id === msg.session_id)
    if (s) (s as any).pinned = msg.pinned
  }))

  cleanups.push(onEvent('session_title_update', (msg: any) => {
    const s = allSessions.value.find((x: any) => x.session_id === msg.session_id)
    if (s) s.title = msg.title
  }))
})

// SessionActions handlers (optimistic local updates)
function onDeleted(_sessionId: string) { /* handled by session_deleted WS event */ }
function onPinned(sessionId: string, pinned: boolean) {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId)
  if (s) (s as any).pinned = pinned
}

onUnmounted(() => {
  for (const fn of cleanups) fn()
  cleanups.length = 0
  document.removeEventListener('click', closePermMenu)
})

function closePermMenu(e: MouseEvent) {
  if (permDropdownEl.value && !permDropdownEl.value.contains(e.target as Node)) {
    showPermMenu.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', closePermMenu)
})
</script>

<style>
.session-layout { display: flex; flex: 1; width: 100%; min-width: 0; height: calc(100vh - var(--topbar-h)); overflow: hidden; }

/* Session Panel */
.session-panel { width: 300px; background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); display: flex; flex-direction: column; flex-shrink: 0; transition: background var(--transition), border-color var(--transition); }
.session-panel-header { padding: 16px; border-bottom: 1px solid var(--sidebar-border); display: flex; align-items: center; justify-content: space-between; }
.session-panel-header h3 { font-size: 14px; font-weight: 600; color: var(--fg); }
.host-filter-chip { margin: 8px; padding: 6px 10px; background: var(--accent-muted); border: 1px solid var(--accent); border-radius: var(--radius-full); display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--accent); }
.host-filter-chip .hfc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.host-filter-chip .hfc-clear { flex-shrink: 0; width: 16px; height: 16px; border: none; background: none; color: var(--accent); cursor: pointer; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; opacity: 0.7; }
.host-filter-chip .hfc-clear:hover { opacity: 1; background: rgba(88,166,255,0.2); }
.session-list { flex: 1; overflow-y: auto; padding: 8px; }
.session-list-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.1s, opacity 0.25s ease; margin-bottom: 2px; }
.session-list-item:hover { background: var(--surface-hover); }
.session-list-item.pending-delete { opacity: 0.35; pointer-events: none; }
.session-list-item.active { background: var(--sidebar-active); }
.session-list-item .sl-info { flex: 1; min-width: 0; }
.session-list-item .sl-title { font-size: 13px; font-weight: 500; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-list-item .pin-icon { color: var(--accent); flex-shrink: 0; vertical-align: middle; }
.session-list-item .ss-rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-muted); color: var(--fg); font-family: var(--font-body); font-size: 13px; font-weight: 500; padding: 3px 6px; outline: none; width: 100%; }
.session-list-item .sl-title.mono { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.session-list-item .sl-meta { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; }

/* Chat Area */
.chat-area { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; max-width: 100%; overflow: hidden; background: var(--bg); transition: background var(--transition); }

/* Toolbar */
.chat-toolbar { height: 52px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 20px; gap: 12px; background: var(--surface); transition: background var(--transition), border-color var(--transition); }
.chat-toolbar .session-label { font-size: 14px; font-weight: 600; color: var(--fg); flex: 1; display: flex; align-items: center; gap: 8px; }
.chat-toolbar .session-label .daemon-name { font-size: 12px; color: var(--fg-tertiary); font-weight: 400; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.status-pill.running { background: var(--success-bg); color: var(--success); }
.status-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse-green 1.5s infinite; }

.session-id-box { display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.session-id-text { font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); }
.copy-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 4px; padding: 0; transition: color 0.15s, background 0.15s; }
.copy-btn:hover { color: var(--accent); background: var(--accent-muted); }

/* Messages */
.chat-messages { flex: 1; min-height: 0; width: 100%; overflow-y: auto; overflow-x: hidden; padding: 20px; display: flex; flex-direction: column; align-items: stretch; gap: 16px; position: relative; overflow-anchor: none; }
/* min-width:0 lets long content (code/URLs) wrap instead of overflowing
   horizontally. max-width + center keeps lines readable on wide screens.
   User bubbles are excluded (they use fit-content + right align). */
/* Agent text: adaptive width — short replies stay narrow, long content grows to 720px.
   Left-aligned (natural document flow), unlike centered tool cards. */
.chat-messages > .agent-block { min-width: 0; max-width: 720px; width: fit-content; align-self: flex-start; }
/* Tool cards / receipts / errors / banners: full width within 820px, centered. */
.chat-messages > *:not(.msg):not(.agent-block) { min-width: 0; max-width: 820px; width: 100%; align-self: center; }
.chat-messages > *.msg { min-width: 0; max-width: 85%; }
/* Scroll-to-bottom: floats centered above the input bar. Auto-hides (v-if)
   when content is already scrolled to the bottom (autoScroll === true). */
/* Scroll-to-bottom: absolute child of chat-input-area, pinned above its top
   edge. Takes zero flex space — doesn't shrink chat-messages. */
.scroll-to-bottom { position: absolute; top: -40px; left: 50%; transform: translateX(-50%); width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 10px rgba(0,0,0,0.3); transition: background 0.15s, color 0.15s; z-index: 50; }
.scroll-to-bottom:hover { background: var(--surface-hover); color: var(--fg); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.25s ease; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; }

/* Messages — message type styles (msg-user/msg-agent/tool-card/msg-error)
   now live in their own components under components/messages/. The timeline
   and chat-input styles below remain here because they are layout concerns
   of this view, not reusable message rendering. */

/* Timeline */
.timeline { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 4px; flex-shrink: 0; }
.timeline .milestone { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.timeline .milestone .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
.timeline .milestone .dot.active { background: var(--success); }
.timeline .milestone .dot.current { background: var(--success); animation: pulse-green 1.5s infinite; }
.timeline .milestone .label { font-size: 11px; color: var(--fg-tertiary); }
.timeline .milestone .label.active { color: var(--fg-secondary); }
.timeline .milestone .time { font-size: 10px; color: var(--fg-tertiary); font-family: var(--font-mono); }
.timeline .line { flex: 1; height: 1px; background: var(--border); margin: 0 12px; align-self: flex-start; margin-top: 4px; }
.timeline .line.done { background: var(--success); }

/* Chat Input — unified container */
.chat-input-area { position: relative; border-top: 1px solid var(--border); padding: 12px 20px; background: var(--surface); transition: background var(--transition), border-color var(--transition); }
.chat-input-area.ended { display: flex; align-items: center; justify-content: center; padding: 14px 20px; }
.ended-text { color: var(--fg-tertiary); font-size: 13px; }

.chat-input-container { position: relative; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-xl); transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-container.focused { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted); }

.chat-textarea { width: 100%; background: none; border: none; color: var(--fg); font-size: 14px; font-family: var(--font-body); line-height: 1.5; outline: none; resize: none; padding: 12px 16px 4px; min-height: 60px; max-height: 200px; }
.chat-textarea::placeholder { color: var(--fg-tertiary); }
.chat-textarea:disabled { opacity: 0.5; }

/* Bottom control row */
.input-controls { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px 12px; gap: 8px; }

/* Permission dropdown (left) */
.perm-dropdown { position: relative; }
.perm-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: none; border: none; color: var(--fg-secondary); font-size: 12px; cursor: pointer; border-radius: var(--radius-sm); transition: color 0.15s, background 0.15s; font-family: var(--font-body); }
.perm-trigger:hover { color: var(--fg); background: var(--surface-hover); }
.perm-label { font-weight: 500; }
.perm-menu { position: absolute; bottom: calc(100% + 4px); left: 0; min-width: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 4px 16px rgba(0,0,0,0.3); padding: 4px; z-index: 30; }
.perm-menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 10px; background: none; border: none; color: var(--fg); font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); transition: background 0.1s; font-family: var(--font-body); }
.perm-menu-item:hover { background: var(--surface-hover); }
.perm-menu-item.active { color: var(--accent); }
.perm-menu-item.active svg { color: var(--accent); }
.perm-menu-enter-active, .perm-menu-leave-active { transition: opacity 0.15s, transform 0.15s; }
.perm-menu-enter-from, .perm-menu-leave-to { opacity: 0; transform: translateY(4px); }

/* Right side: context + action button */
.input-right { display: flex; align-items: center; gap: 8px; }
.ctx-indicator { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); cursor: help; white-space: pre-line; }

.action-btn { width: 32px; height: 32px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s, opacity 0.15s; }
.send-btn { background: var(--accent); color: #fff; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { background: var(--border); color: var(--fg-tertiary); cursor: not-allowed; }
.stop-btn { background: var(--fg); color: var(--bg); }
.stop-btn:hover { opacity: 0.85; }

@media (max-width: 1024px) { .session-layout { height: calc(100vh - var(--topbar-h)); } }
@media (max-width: 768px) { .session-panel { display: none; } }
</style>
