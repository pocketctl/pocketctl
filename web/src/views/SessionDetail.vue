<template>
  <div class="session-detail">
    <div class="toolbar">
      <button class="btn" @click="$router.push('/')">&larr; Back</button>
      <span class="session-title">{{ sessionTitle || sessionId.slice(0, 8) }}</span>
      <span class="status-badge" :class="effectiveStatus">{{ statusLabel }}</span>
    </div>

    <!-- Daemon disconnected banner -->
    <div v-if="effectiveStatus === 'disconnected'" class="info-banner disconnected-banner">
      <span class="banner-icon">⚠️</span>
      <span>Daemon 离线 — 等待恢复</span>
    </div>

    <!-- Session exited banner with resume -->
    <div v-if="status === 'exited'" class="info-banner exit-banner">
      <div class="exit-banner-content">
        <span class="banner-icon">📤</span>
        <span>Session 已退出</span>
        <span v-if="exitReason" class="exit-reason-tag">{{ exitReasonLabel(exitReason) }}</span>
        <span v-if="exitedAt" class="exit-time">{{ formatRelativeTime(exitedAt) }}退出</span>
      </div>
      <button
        v-if="isDaemonOnline"
        class="btn resume-btn"
        @click="focusResumeInput"
      >Resume Session</button>
      <span v-else class="resume-disabled" title="需要 Daemon 在线才能恢复">Resume (Daemon 离线)</span>
    </div>

    <!-- Terminal state badge -->
    <div v-if="terminalBadge" class="terminal-badge-row">
      <span class="terminal-badge" :class="terminalBadge.class">{{ terminalBadge.text }}</span>
    </div>

    <!-- Timestamp info -->
    <div class="timestamp-row">
      <span v-if="startedAt">创建于 {{ formatRelativeTime(startedAt) }}</span>
      <span v-if="lastActivityAt" class="last-activity">· 最后活跃 {{ formatRelativeTime(lastActivityAt) }}</span>
    </div>

    <div class="messages" ref="messagesEl">
      <div v-for="msg in messages" :key="msg.id" class="message" :class="msg.role">
        <div v-if="msg.role === 'user'" class="msg-bubble user">{{ msg.content }}</div>
        <div v-else-if="msg.type === 'agent_text'" class="msg-bubble agent">
          <span>{{ msg.content }}</span>
          <span v-if="msg.streaming" class="cursor">|</span>
        </div>
        <div v-else-if="msg.type === 'tool_call'" class="msg-bubble tool" :class="{ open: msg.expanded }">
          <!-- Agent tool with linked sub-agent: render SubAgentCard -->
          <SubAgentCard
            v-if="msg.tool === 'Agent' && msg.subAgentId && subAgents[msg.subAgentId]"
            :agent-id="msg.subAgentId"
            :description="subAgents[msg.subAgentId].description"
            :agent-type="subAgents[msg.subAgentId].agentType"
            :messages="subAgents[msg.subAgentId].messages"
            :status="subAgents[msg.subAgentId].status"
          />
          <!-- Other tools: normal tool call rendering -->
          <template v-else>
            <div class="tool-header" @click="msg.expanded = !msg.expanded">
              <span class="tool-chevron">{{ msg.expanded ? '▾' : '▸' }}</span>
              <span class="tool-icon">{{ toolIcon(msg.tool) }}</span>
              <span class="tool-name">{{ msg.tool }}</span>
              <span class="tool-args">{{ toolSummary(msg.tool, msg.input) }}</span>
              <span v-if="!msg.output" class="tool-spinner">⏳</span>
              <span v-else class="tool-check">✓</span>
            </div>
            <div v-if="msg.expanded" class="tool-body">
              <div class="tool-section" v-if="msg.input">
                <div class="tool-section-label">Input</div>
                <pre class="tool-input">{{ formatToolInput(msg.tool, msg.input) }}</pre>
              </div>
              <div class="tool-section" v-if="msg.output">
                <div class="tool-section-label">Output</div>
                <pre class="tool-output" :class="{ collapsed: !msg.outputExpanded && isLongOutput(msg.output) }">{{ msg.output }}</pre>
                <button v-if="isLongOutput(msg.output)" class="tool-toggle" @click="msg.outputExpanded = !msg.outputExpanded">
                  {{ msg.outputExpanded ? '收起' : `展开全部 (${countLines(msg.output)} 行)` }}
                </button>
              </div>
              <div v-else class="tool-pending">Running...</div>
            </div>
          </template>
        </div>
        <div v-else-if="msg.type === 'error'" class="msg-bubble error">{{ msg.content }}</div>
      </div>
    </div>

    <!-- Session lifecycle timeline -->
    <SessionTimeline v-if="timelineMilestones.length > 0" :milestones="timelineMilestones" />

    <!-- Input area: hidden for read-only terminals, shown for resumable -->
    <div v-if="showInput" class="input-area">
      <input
        ref="inputEl"
        v-model="inputText"
        @keydown.enter="sendMessage"
        :placeholder="inputPlaceholder"
        :disabled="!connected || effectiveStatus === 'disconnected'"
      />
    </div>
    <div v-else-if="showEndedMessage" class="input-area ended">
      <span class="ended-text">Session 已结束</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useWebSocket } from '../composables/useWebSocket'
import type { DaemonEvent } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import SessionTimeline from '../components/SessionTimeline.vue'
import type { Milestone } from '../components/SessionTimeline.vue'
import SubAgentCard from '../components/SubAgentCard.vue'
import { useNotifications } from '../composables/useNotifications'

const props = defineProps<{ id: string }>()
const { connect, send, onEvent, connected, ws, isDaemonOnline: checkDaemonOnline, effectiveStatus: computeEffectiveStatus } = useWebSocket()
const { requestPermission, notifySessionStateChange } = useNotifications()

const sessionId = ref(props.id)
const sessionTitle = ref('')
const status = ref('running')
const exitReason = ref('')
const exitedAt = ref('')
const startedAt = ref('')
const lastActivityAt = ref('')
const daemonId = ref('')
const messages = ref<any[]>([])
const timelineMilestones = ref<Milestone[]>([])
const inputText = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
let msgCounter = 0
let replayDone = false
let replayTimer: ReturnType<typeof setTimeout> | null = null

// Sub-agent state: agentId -> { messages[], description, agentType, status }
interface SubAgentInfo {
  agentId: string
  description: string
  agentType: string
  messages: any[]
  status: string
}
const subAgents = ref<Record<string, SubAgentInfo>>({})


function scrollToBottom() {
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
}

function scheduleScroll() {
  if (!replayDone) return
  nextTick(scrollToBottom)
}

// Computed: effective status
const effectiveStatus = computed(() => {
  return computeEffectiveStatus({ status: status.value, daemon_id: daemonId.value })
})

const isDaemonOnline = computed(() => checkDaemonOnline(daemonId.value))

// Computed: status label
const statusLabel = computed(() => {
  const labels: Record<string, string> = {
    running: 'Running',
    busy: 'Running',
    idle: 'Idle',
    waiting_approval: 'Waiting',
    exited: 'Exited',
    disconnected: 'Disconnected',
    completed: 'Completed',
    error: 'Error',
    killed: 'Killed',
  }
  return labels[effectiveStatus.value] || effectiveStatus.value
})

// Computed: terminal state badge
const terminalBadge = computed(() => {
  const s = effectiveStatus.value
  if (s === 'exited' && isDaemonOnline.value) return { text: '可恢复', class: 'resumable' }
  if (s === 'completed') return { text: '只读', class: 'readonly' }
  if (s === 'error') return { text: '异常退出', class: 'errored' }
  if (s === 'killed') return { text: '已终止', class: 'killed-badge' }
  return null
})

// Computed: show input or ended message
const showInput = computed(() => {
  const s = effectiveStatus.value
  return s === 'running' || s === 'busy' || s === 'idle' || s === 'waiting_approval' || (s === 'exited' && isDaemonOnline.value)
})

const showEndedMessage = computed(() => {
  const s = effectiveStatus.value
  return s === 'completed' || s === 'error' || s === 'killed' || (s === 'exited' && !isDaemonOnline.value)
})

const inputPlaceholder = computed(() => {
  if (status.value === 'exited') return '输入消息以恢复 Session...'
  return 'Send a message...'
})

function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    user_interrupt: '用户中断',
    normal_exit: '正常退出',
    process_crash: '异常退出',
    signal_kill: '被终止',
    unknown: '已退出',
  }
  return labels[reason] || '已退出'
}

function focusResumeInput() {
  nextTick(() => { inputEl.value?.focus() })
}

onMounted(() => {
  // Request notification permission
  requestPermission()

  const relayWs = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  const token = localStorage.getItem('pocketctl_access_token') || ''
  const wsUrl = `${relayWs}?type=client&token=${encodeURIComponent(token)}`
  connect(wsUrl)

  const sendReplay = () => {
    send({ type: 'replay', session_id: sessionId.value, last_seq: 0 })
    // Add initial milestone
    if (startedAt.value) {
      timelineMilestones.value.push({ status: 'running', time: startedAt.value })
    }
    replayTimer = setTimeout(() => { replayDone = true; scheduleScroll() }, 300)
  }
  if (connected.value) { sendReplay() } else { const stop = watch(connected, (v) => { if (v) { sendReplay(); stop() } }) }

  // Sub-agent event router
  function handleSubAgentEvent(evt: DaemonEvent) {
    const agent = subAgents.value[evt.agent_id!]
    if (!agent) return
    switch (evt.type) {
      case 'agent_text': {
        const last = agent.messages[agent.messages.length - 1]
        if (last && last.type === 'agent_text' && last.streaming) {
          last.content += evt.text; last.streaming = evt.streaming
        } else {
          agent.messages.push({ id: msgCounter++, type: 'agent_text', content: evt.text, streaming: evt.streaming })
        }
        break
      }
      case 'tool_call':
        agent.messages.push({ id: msgCounter++, type: 'tool_call', tool: evt.tool, input: evt.input, output: '', call_id: evt.call_id, expanded: false, outputExpanded: false })
        break
      case 'tool_result': {
        const toolMsg = [...agent.messages].reverse().find((m: any) => m.type === 'tool_call' && m.call_id === evt.call_id)
        if (toolMsg) toolMsg.output = evt.output
        break
      }
    }
  }

  onEvent((evt: DaemonEvent) => {
    if (evt.session_id !== sessionId.value) return

    // Route sub-agent content events
    if (evt.agent_id) {
      handleSubAgentEvent(evt)
      scheduleScroll()
      return
    }

    switch (evt.type) {
      case 'subagent_discovered': {
        const aId = evt.agent_id!
        const tId = evt.call_id
        if (aId) {
          subAgents.value[aId] = {
            agentId: aId,
            description: evt.subagent_desc || 'Sub-agent',
            agentType: evt.subagent_type || 'general-purpose',
            messages: [],
            status: 'completed',
          }
          // Link to existing Agent tool_call in main messages
          if (tId) {
            const toolMsg = messages.value.find(m => m.type === 'tool_call' && m.call_id === tId)
            if (toolMsg) toolMsg.subAgentId = aId
          }
        }
        break
      }
      case 'agent_text': {
        const last = messages.value[messages.value.length - 1]
        if (last && last.type === 'agent_text' && last.streaming) {
          last.content += evt.text; last.streaming = evt.streaming
        } else {
          messages.value.push({ id: msgCounter++, role: 'agent', type: 'agent_text', content: evt.text, streaming: evt.streaming })
        }
        break
      }
      case 'tool_call':
        messages.value.push({ id: msgCounter++, role: 'agent', type: 'tool_call', tool: evt.tool, input: evt.input, output: '', call_id: evt.call_id, expanded: false, outputExpanded: false })
        break
      case 'tool_result': {
        const toolMsg = [...messages.value].reverse().find(m => m.type === 'tool_call' && m.call_id === evt.call_id)
        if (toolMsg) {
          // For Agent tool calls, suppress raw output
          if (toolMsg.tool === 'Agent' && toolMsg.subAgentId) {
            toolMsg.output = 'Sub-agent completed'
          } else {
            toolMsg.output = evt.output
          }
        }
        break
      }
      case 'session_status':
        status.value = evt.status || 'unknown'
        if (evt.exit_reason) exitReason.value = evt.exit_reason
        if (evt.last_activity_at) {
          lastActivityAt.value = evt.last_activity_at
          if (evt.status === 'exited') exitedAt.value = evt.last_activity_at
        }
        // Add timeline milestone for state changes (exclude disconnected overlay)
        if (evt.status && evt.status !== 'disconnected' && evt.last_activity_at) {
          const last = timelineMilestones.value[timelineMilestones.value.length - 1]
          if (!last || last.status !== evt.status) {
            timelineMilestones.value.push({ status: evt.status, time: evt.last_activity_at })
          }
        }
        // Browser notification for terminal states (if not on this page)
        if (evt.status && ['exited', 'error', 'killed', 'completed'].includes(evt.status)) {
          notifySessionStateChange(
            sessionId.value,
            sessionTitle.value,
            evt.status,
            props.id // current route session ID
          )
        }
        break
      case 'session_title_update':
        sessionTitle.value = evt.title || sessionTitle.value
        break
      case 'error':
        messages.value.push({ id: msgCounter++, role: 'agent', type: 'error', content: evt.error })
        break
    }
    scheduleScroll()
  })
})

function sendMessage() {
  const text = inputText.value.trim()
  if (!text || !connected.value) return
  messages.value.push({ id: msgCounter++, role: 'user', content: text })
  send({ type: 'user_message', session_id: sessionId.value, content: text })
  inputText.value = ''
  scheduleScroll()
}

function toolIcon(tool: string): string {
  const icons: Record<string, string> = {
    'Read': '📖', 'Write': '✏️', 'Edit': '✏️', 'Bash': '⚡', 'Glob': '🔍',
    'Grep': '🔍', 'WebSearch': '🌐', 'WebFetch': '🌐', 'Agent': '🤖',
  }
  return icons[tool] || '🔧'
}

function toolSummary(tool: string, input: any): string {
  if (!input) return ''
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
    const path = input.file_path || input.path || ''
    return path.length > 60 ? '…' + path.slice(-57) : path
  }
  if (tool === 'Bash') {
    const cmd = input.command || input.description || ''
    return cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd
  }
  if (tool === 'Grep') {
    const pat = input.pattern || input.query || ''
    const path = input.path || ''
    return `${pat} ${path}`
  }
  if (tool === 'Glob') {
    const pat = input.pattern || ''
    const path = input.path || ''
    return `${pat} ${path}`
  }
  const s = JSON.stringify(input)
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

function formatToolInput(tool: string, input: any): string {
  if (!input) return ''
  if (tool === 'Bash') {
    const cmd = input.command || ''
    const desc = input.description || ''
    let result = `$ ${cmd}`
    if (desc && desc !== cmd) result += `\n# ${desc}`
    return result
  }
  if (tool === 'Read') {
    const path = input.file_path || ''
    const offset = input.offset ? `:${input.offset}` : ''
    const limit = input.limit ? `-${input.limit}` : ''
    return `📖 ${path}${offset}${limit}`
  }
  if (tool === 'Write') {
    const path = input.file_path || ''
    const content = input.content || ''
    const lines = content.split('\n').length
    return `📝 ${path} (${lines} 行)`
  }
  if (tool === 'Edit') {
    const path = input.file_path || ''
    const old = (input.old_string || '').split('\n')[0]
    return `✏️ ${path}\n替换: ${old.length > 80 ? old.slice(0, 77) + '…' : old}`
  }
  return JSON.stringify(input, null, 2)
}

function isLongOutput(output: string): boolean {
  if (!output) return false
  return output.split('\n').length > 20 || output.length > 2000
}

function countLines(output: string): number {
  return output.split('\n').length
}
</script>

<style scoped>
.session-detail { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
.toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid #21262d; background: #161b22; }
.btn { padding: 6px 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 13px; }
.session-title { font-family: monospace; color: #58a6ff; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.status-badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; flex-shrink: 0; }
.status-badge.running, .status-badge.busy { background: #238636; color: white; }
.status-badge.idle { background: #484f58; color: #e6edf3; }
.status-badge.waiting_approval { background: #F97316; color: white; }
.status-badge.exited { background: #6B7280; color: white; }
.status-badge.completed { background: #9CA3AF; color: white; }
.status-badge.error { background: #da3633; color: white; }
.status-badge.killed { background: #DC2626; color: white; }
.status-badge.disconnected { background: #1e3a5f; color: #58a6ff; border: 1px dashed #3B82F6; }

/* Info banners */
.info-banner { padding: 10px 20px; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.disconnected-banner { background: #1e3a5f; color: #58a6ff; border-bottom: 1px solid #2d5a8e; }
.exit-banner {
  background: #1c2129; border-bottom: 1px solid #30363d; color: #e6edf3;
  justify-content: space-between; flex-wrap: wrap; gap: 8px;
}
.exit-banner-content { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.banner-icon { font-size: 16px; }
.exit-reason-tag { background: #30363d; padding: 1px 8px; border-radius: 10px; font-size: 12px; color: #8b949e; }
.exit-time { font-size: 12px; color: #8b949e; }
.resume-btn { background: #238636 !important; border-color: #238636 !important; color: white !important; }
.resume-btn:hover { background: #2ea043 !important; }
.resume-disabled { font-size: 12px; color: #484f58; }

/* Terminal state badge row */
.terminal-badge-row { padding: 4px 20px; }
.terminal-badge { font-size: 11px; padding: 2px 10px; border-radius: 10px; }
.terminal-badge.resumable { background: #1f3a5f; color: #79c0ff; }
.terminal-badge.readonly { background: #30363d; color: #8b949e; }
.terminal-badge.errored { background: #3d1214; color: #f85149; }
.terminal-badge.killed-badge { background: #3d1214; color: #da3633; }

/* Timestamp row */
.timestamp-row { padding: 2px 20px 6px; font-size: 12px; color: #484f58; }
.last-activity { margin-left: 4px; }

.messages { flex: 1; overflow-y: auto; padding: 20px; -webkit-overflow-scrolling: touch; }
.message { margin-bottom: 16px; display: flex; }
.message.user { justify-content: flex-end; }
.msg-bubble { max-width: 70%; padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.msg-bubble.user { background: #1f6feb; color: white; border-bottom-right-radius: 4px; }
.msg-bubble.agent { background: #21262d; color: #e6edf3; border-bottom-left-radius: 4px; }
.msg-bubble.tool { background: #161b22; border: 1px solid #30363d; max-width: 85%; padding: 0; white-space: normal; }

/* Tool header */
.tool-header { display: flex; align-items: center; gap: 6px; padding: 10px 14px; cursor: pointer; font-family: monospace; font-size: 13px; user-select: none; }
.tool-header:hover { background: #1c2129; border-radius: 12px; }
.tool-chevron { color: #484f58; font-size: 11px; width: 12px; }
.tool-icon { font-size: 14px; }
.tool-name { color: #58a6ff; font-weight: 600; }
.tool-args { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.tool-spinner { font-size: 12px; animation: spin 1s linear infinite; }
.tool-check { color: #3fb950; font-size: 13px; }

/* Tool body */
.tool-body { padding: 0 14px 14px; }
.tool-section { margin-bottom: 8px; }
.tool-section-label { font-size: 11px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 600; }
.tool-input { margin: 0; padding: 8px 10px; background: #0d1117; border-radius: 6px; font-size: 12px; overflow-x: auto; color: #79c0ff; border: 1px solid #1c2533; }
.tool-output { margin: 0; padding: 8px 10px; background: #0d1117; border-radius: 6px; font-size: 12px; overflow-x: auto; color: #e6edf3; border: 1px solid #1c2533; white-space: pre-wrap; word-break: break-all; }
.tool-output.collapsed { max-height: 200px; overflow: hidden; position: relative; }
.tool-pending { color: #8b949e; font-style: italic; padding: 4px 0; }
.tool-toggle { background: none; border: 1px solid #30363d; color: #58a6ff; padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; margin-top: 4px; }
.tool-toggle:hover { background: #21262d; }

.msg-bubble.error { background: #3d1214; color: #f85149; border: 1px solid #da3633; }
.cursor { animation: blink 0.7s infinite; color: #58a6ff; }
.input-area { padding: 12px 20px; border-top: 1px solid #21262d; background: #161b22; }
.input-area input { width: 100%; padding: 10px 14px; border-radius: 8px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px; outline: none; }
.input-area input:focus { border-color: #58a6ff; }
.input-area input:disabled { opacity: 0.5; }
.input-area.ended { display: flex; align-items: center; justify-content: center; padding: 14px 20px; }
.ended-text { color: #484f58; font-size: 13px; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Mobile */
@media (max-width: 768px) {
  .toolbar { padding: 10px 12px; gap: 8px; }
  .session-title { max-width: 120px; font-size: 12px; }
  .messages { padding: 12px; }
  .msg-bubble { max-width: 90%; font-size: 13px; padding: 10px 12px; }
  .msg-bubble.tool { max-width: 95%; }
  .input-area { padding: 10px 12px; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
  .input-area input { font-size: 16px; padding: 12px; min-height: 44px; }
  .btn { min-height: 44px; }
  .tool-header { font-size: 12px; padding: 8px 10px; }
  .tool-input, .tool-output { font-size: 11px; }
  .info-banner { padding: 8px 12px; font-size: 12px; }
}
</style>
