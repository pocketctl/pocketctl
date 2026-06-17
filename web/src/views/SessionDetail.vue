<template>
  <div class="session-layout">
    <!-- Session List Panel -->
    <div class="session-panel">
      <div class="session-panel-header">
        <h3>{{ daemonName }}</h3>
        <button class="btn-icon" style="width:28px;height:28px;border:none;background:var(--accent);color:#fff;" title="新建会话" @click="emitNewSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div style="padding:4px 8px;display:flex;align-items:center;gap:6px;">
        <span :class="['status-dot', { online: isDaemonOnline }]" style="width:6px;height:6px;"></span>
        <span style="font-size:11px;color:var(--fg-tertiary);">{{ isDaemonOnline ? '在线' : '离线' }} · {{ statusSubtext }}</span>
      </div>
      <div v-if="hostFilter" class="host-filter-chip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20M17 2v20M2 12h20"/></svg>
        <span class="hfc-name">{{ daemonName }}</span>
        <button class="hfc-clear" @click="clearHostFilter" title="显示全部主机会话">✕</button>
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
            <div class="sl-meta">{{ formatRelativeTime(s.last_activity_at || s.updated_at) }}<span v-if="s.subagent_count > 0"> · {{ s.subagent_count }} 子智能体</span></div>
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
        <div class="session-id-box">
          <code class="session-id-text">{{ sessionId?.slice(0, 8) }}</code>
          <button class="copy-btn" @click="copySessionId" :title="copied ? '已复制' : '复制会话ID'">
            <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button v-if="currentSessionAgent !== 'opencode'" class="copy-btn" style="margin-left:6px;" :title="resumeCopied ? '已复制恢复命令 — 在主机终端粘贴运行' : '恢复会话命令（复制到粘贴板）'" @click="copyResumeCmd">
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
          <span>Session 已退出</span>
          <span v-if="exitReason" style="margin-left:4px;">· {{ exitReasonLabel(exitReason) }}</span>
          <button v-if="isDaemonOnline" class="btn btn-accent" style="margin-left:auto;padding:4px 12px;font-size:12px;" @click="focusResumeInput">Resume</button>
        </div>

        <!-- Disconnected Banner -->
        <div v-if="isDisconnected" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>Daemon 离线 — 等待恢复</span>
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

      <!-- Chat Input -->
      <div class="chat-input-area" :class="{ ended: !canInput }">
        <template v-if="canInput">
          <div class="chat-input-wrap">
            <CommandPopover
              v-if="showPopover"
              :commands="filteredCommands"
              :active-index="selectedIndex"
              @select="applyCommand"
              @hover="selectedIndex = $event"
            />
            <input type="text" v-model="messageInput" :placeholder="isPendingSession ? '会话创建中…' : (isDaemonSession && isTerminal ? '继续会话（将恢复历史上下文）...' : '发送消息...')" @keydown="onInputKeydown" :disabled="isDisconnected || isPendingSession || isLoading" ref="inputEl" />
          </div>
          <button class="send-btn" @click="sendMessage" :disabled="isDisconnected || isPendingSession || isLoading || !messageInput.trim()">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </template>
        <div v-else class="ended-text">Session 已结束</div>
      </div>

      <!-- Scroll-to-bottom: fixed above the input bar, auto-hides when at bottom -->
      <Transition name="scroll-btn">
        <button v-if="messages.length > 0 && !autoScroll" class="scroll-to-bottom" title="回到底部" @click="scrollToBottom">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
        </button>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import SessionActions from '../components/SessionActions.vue'
import CommandPopover from '../components/CommandPopover.vue'
import CommandReceiptCard from '../components/CommandReceiptCard.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageError from '../components/messages/MessageError.vue'
import ToolCallCard from '../components/messages/ToolCallCard.vue'
import { buildResumeCommand } from '../utils/resumeCommand'
import { formatToolInput } from '../utils/toolDisplay'
import { useSessionRename } from '../composables/useSessionRename'
import type { CommandItem } from '../composables/useWebSocket'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()

const route = useRoute()
const router = useRouter()
const { connect, send, onEvent } = useWebSocket()

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
const currentSessionAgent = computed(() => allSessions.value.find((x: any) => x.session_id === sessionId.value)?.agent)
const isPendingSession = computed(() => sessionId.value.startsWith('pending-'))
const selectedIndex = ref(0)
const popoverDismissed = ref(false)
const status = ref('running')
const exitReason = ref('')
const exitedAt = ref('')
const autoScroll = ref(true)
const copied = ref(false)
const messagesEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
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
  const map: Record<string, string> = { running: '运行中', busy: '繁忙', idle: '空闲', completed: '已完成', error: '错误', killed: '已终止', disconnected: '已断开', exited: '已退出' }
  return map[status.value] || status.value
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

const daemonName = computed(() => {
  if (hostFilter.value) {
    const d = daemons.value[hostFilter.value]
    return d?.daemon_alias || d?.hostname || hostFilter.value.slice(0, 8)
  }
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_alias || s?.hostname || s?.daemon_id?.slice(0, 8) || '未知'
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

const statusSubtext = computed(() => isDaemonOnline.value ? '已连接' : '等待恢复')

const milestones = computed(() => {
  const ms: any[] = []
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  if (!s) return ms
  if (s.created_at) ms.push({ label: '创建', time: formatTime(s.created_at), state: 'active' })
  ms.push({ label: '运行', time: formatTime(s.last_activity_at || s.updated_at || s.created_at), state: status.value === 'running' || status.value === 'busy' ? 'current' : 'active' })
  ms.push({ label: statusLabel.value === '运行中' ? '进行中' : statusLabel.value, time: '—', state: isTerminal.value || status.value === 'exited' ? 'active' : '' })
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

function emitNewSession() { router.push('/') }

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
watch(messageInput, () => { selectedIndex.value = 0; popoverDismissed.value = false })

function onInputKeydown(e: KeyboardEvent) {
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
  } else if (e.key === 'Enter') {
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
    const last = target[target.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !content.startsWith('\n')) {
      last.content += content
      if (!streaming) last.streaming = false
    } else {
      target.push({ id: nextId('a'), type: 'agent_text', role: 'agent', content, streaming })
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
/* Force every direct message child to fill the column width (flex column's
   default align-items: stretch already does this, but width:100% makes it
   explicit and prevents any shrink-to-fit). min-width:0 lets long content
   (code/URLs) wrap instead of overflowing horizontally. */
.chat-messages > * { width: 100%; min-width: 0; }
/* Scroll-to-bottom: floats centered above the input bar. Auto-hides (v-if)
   when content is already scrolled to the bottom (autoScroll === true). */
.scroll-to-bottom { position: absolute; bottom: 76px; left: 50%; transform: translateX(-50%); width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 14px rgba(0,0,0,0.35); transition: background 0.15s; z-index: 50; }
.scroll-to-bottom:hover { background: var(--surface-hover); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.2s ease, transform 0.2s ease; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; transform: translate(-50%, 6px); }

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

/* Chat Input */
.chat-input-area { border-top: 1px solid var(--border); padding: 12px 20px; background: var(--surface); display: flex; gap: 10px; align-items: center; transition: background var(--transition), border-color var(--transition); }
.chat-input-area.ended { display: flex; align-items: center; justify-content: center; padding: 14px 20px; }
.ended-text { color: var(--fg-tertiary); font-size: 13px; }
.chat-input-wrap { position: relative; flex: 1; display: flex; align-items: center; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 0 16px; min-height: 42px; transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-wrap:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted); }
.chat-input-wrap input { flex: 1; background: none; border: none; color: var(--fg); font-size: 14px; font-family: var(--font-body); outline: none; padding: 8px 0; }
.chat-input-wrap input::placeholder { color: var(--fg-tertiary); }
.chat-input-wrap input:disabled { opacity: 0.5; }
.send-btn { width: 36px; height: 36px; border-radius: 50%; background: var(--accent); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.send-btn svg { width: 16px; height: 16px; fill: var(--bg); }

@media (max-width: 1024px) { .session-layout { height: calc(100vh - var(--topbar-h)); } }
@media (max-width: 768px) { .session-panel { display: none; } }
</style>
