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
      <div class="session-list">
        <div v-for="s in allSessions" :key="s.session_id"
          :class="['session-list-item', { active: s.session_id === sessionId }]"
          @click="$router.push(`/session/${s.session_id}`)">
          <span :class="['status-dot', s.statusEffective || s.status]" style="width:7px;height:7px;"></span>
          <div class="sl-info">
            <div :class="['sl-title', { mono: !s.title || s.title.startsWith('Terminal Session') }]">{{ s.title || s.session_id.slice(0, 8) }}</div>
            <div class="sl-meta">{{ formatRelativeTime(s.last_activity_at || s.updated_at) }}<span v-if="s.subagent_count > 0"> · {{ s.subagent_count }} 子智能体</span></div>
          </div>
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
      </div>

      <!-- Messages -->
      <div class="chat-messages" ref="messagesEl" @scroll="onMessagesScroll">
        <!-- Exit Banner -->
        <div v-if="status === 'exited'" class="banner banner-info" style="flex-shrink:0;">
          <span>📤 Session 已退出</span>
          <span v-if="exitReason" style="margin-left:4px;">· {{ exitReasonLabel(exitReason) }}</span>
          <button v-if="isDaemonOnline" class="btn btn-accent" style="margin-left:auto;padding:4px 12px;font-size:12px;" @click="focusResumeInput">Resume</button>
        </div>

        <!-- Disconnected Banner -->
        <div v-if="isDisconnected" class="banner banner-warning" style="flex-shrink:0;">
          <span>⚠️ Daemon 离线 — 等待恢复</span>
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
          <!-- User message -->
          <div v-if="msg.role === 'user'" class="msg msg-user">{{ msg.content }}</div>

          <!-- Agent text message -->
          <div v-else-if="msg.type === 'agent_text'" :class="['msg msg-agent', { streaming: msg.streaming }]">
            {{ msg.content }}<span v-if="msg.streaming" class="blink-cursor"></span>
          </div>

          <!-- Tool call card -->
          <div v-else-if="msg.type === 'tool_call' || msg.type === 'subagent'" :class="['tool-card', { expanded: msg.expanded }]" @click="msg.expanded = !msg.expanded">
            <div class="tool-header">
              <span class="tool-icon">{{ toolIcon(msg.tool) }}</span>
              <span class="tool-name">{{ msg.tool }}</span>
              <span class="tool-args">{{ toolArgs(msg) }}</span>
              <span class="tool-status">
                <span v-if="msg.status === 'completed'" class="check">✓</span>
                <span v-else class="spinner"></span>
              </span>
              <span class="tool-chevron">▼</span>
            </div>
            <div class="tool-body">
              <div class="tool-section"><div class="tool-label">输入</div></div>
              <div class="tool-input">{{ toolInputText(msg) }}</div>
              <div class="tool-section" style="padding-top:8px;"><div class="tool-label">输出</div></div>
              <div class="tool-output" :class="{ collapsed: !msg.outputExpanded }" ref="outputEl">{{ msg.output || '执行中…' }}</div>
              <button v-if="msg.output && msg.output.length > 300" class="toggle-expand" @click.stop="msg.outputExpanded = !msg.outputExpanded">{{ msg.outputExpanded ? '收起' : '展开全部' }}</button>
            </div>
          </div>

          <!-- Error message -->
          <div v-else-if="msg.type === 'error'" class="msg msg-error">{{ msg.content || msg.error }}</div>
        </template>

        <!-- Scroll to bottom -->
        <button v-if="!autoScroll" class="scroll-to-bottom" @click="scrollToBottom">↓</button>
      </div>

      <!-- Chat Input -->
      <div class="chat-input-area" :class="{ ended: isTerminal }">
        <template v-if="!isTerminal">
          <div class="chat-input-wrap">
            <input type="text" v-model="messageInput" placeholder="发送消息..." @keydown.enter="sendMessage" :disabled="isDisconnected" ref="inputEl" />
          </div>
          <button class="send-btn" @click="sendMessage" :disabled="isDisconnected || !messageInput.trim()">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </template>
        <div v-else class="ended-text">Session 已结束</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'

const route = useRoute()
const router = useRouter()
const { connect, send, onEvent } = useWebSocket()

const sessionId = computed(() => route.params.id as string)
const messages = ref<any[]>([])
const allSessions = ref<any[]>([])
const messageInput = ref('')
const status = ref('running')
const exitReason = ref('')
const exitedAt = ref('')
const autoScroll = ref(true)
const messagesEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const daemons = ref<Record<string, any>>({})

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

const daemonName = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_alias || s?.hostname || s?.daemon_id?.slice(0, 8) || '未知'
})

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

function formatTime(ts: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
}

function toolIcon(tool: string): string {
  const icons: Record<string, string> = { Read: '📖', Write: '✏️', Bash: '⚡', Edit: '✏️', Agent: '🤖', Glob: '🔍', Grep: '🔎', WebSearch: '🌐', WebFetch: '📡', Task: '📋' }
  return icons[tool] || '🔧'
}

function toolArgs(msg: any): string {
  if (msg.input) {
    if (typeof msg.input === 'string') return msg.input.slice(0, 60)
    try { return JSON.stringify(msg.input).slice(0, 60) } catch { return '' }
  }
  return msg.description || ''
}

function toolInputText(msg: any): string {
  if (msg.input) {
    if (typeof msg.input === 'string') return msg.input
    try { return JSON.stringify(msg.input, null, 2) } catch { return String(msg.input) }
  }
  return msg.description || ''
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
}

function focusResumeInput() { if (inputEl.value) { inputEl.value.focus() } }

function sendMessage() {
  const text = messageInput.value.trim()
  if (!text || isDisconnected.value) return
  messages.value.push({ id: 'u' + Date.now(), role: 'user', content: text })
  send({ type: 'user_message', session_id: sessionId.value, content: text })
  messageInput.value = ''
  nextTick(scrollToBottom)
}

onMounted(() => {
  connect()
  send({ type: 'list_sessions' })

  onEvent('session_list', (msg: any) => { allSessions.value = msg.sessions || [] })

  onEvent('agent_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !msg.content.startsWith('\n')) {
      last.content += msg.content
    } else {
      messages.value.push({ id: 'a' + Date.now(), type: 'agent_text', role: 'agent', content: msg.content, streaming: msg.streaming })
    }
    if (!msg.streaming) nextTick(scrollToBottom)
  })

  onEvent('tool_call', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    const existing = messages.value.find(m => m.call_id === msg.call_id)
    if (existing) { existing.output = msg.output; existing.status = msg.status; if (msg.status === 'completed') existing.expanded = true }
    else messages.value.push({ id: 't' + Date.now(), type: 'tool_call', call_id: msg.call_id, tool: msg.tool, input: msg.input, output: msg.output, status: msg.status, expanded: false, outputExpanded: false })
    nextTick(scrollToBottom)
  })

  onEvent('SubAgentCard', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    messages.value.push({ id: 'sa' + Date.now(), type: 'subagent', tool: msg.agent_id || 'Agent', input: msg.subagent_desc, status: 'completed', expanded: true, outputExpanded: false })
  })

  onEvent('session_status', (msg: any) => {
    if (msg.session_id === sessionId.value) { status.value = msg.status; if (msg.exit_reason) exitReason.value = msg.exit_reason; if (msg.exited_at) exitedAt.value = msg.exited_at }
  })

  onEvent('error', (msg: any) => {
    if (msg.session_id && msg.session_id !== sessionId.value) return
    messages.value.push({ id: 'e' + Date.now(), type: 'error', content: msg.error || '未知错误' })
  })
})
</script>

<style>
.session-layout { display: flex; flex: 1; height: calc(100vh - var(--topbar-h)); overflow: hidden; }

/* Session Panel */
.session-panel { width: 300px; background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); display: flex; flex-direction: column; flex-shrink: 0; transition: background var(--transition), border-color var(--transition); }
.session-panel-header { padding: 16px; border-bottom: 1px solid var(--sidebar-border); display: flex; align-items: center; justify-content: space-between; }
.session-panel-header h3 { font-size: 14px; font-weight: 600; color: var(--fg); }
.session-list { flex: 1; overflow-y: auto; padding: 8px; }
.session-list-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.1s; margin-bottom: 2px; }
.session-list-item:hover { background: var(--surface-hover); }
.session-list-item.active { background: var(--sidebar-active); }
.session-list-item .sl-info { flex: 1; min-width: 0; }
.session-list-item .sl-title { font-size: 13px; font-weight: 500; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-list-item .sl-title.mono { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.session-list-item .sl-meta { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; }

/* Chat Area */
.chat-area { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--bg); transition: background var(--transition); }

/* Toolbar */
.chat-toolbar { height: 52px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 20px; gap: 12px; background: var(--surface); transition: background var(--transition), border-color var(--transition); }
.chat-toolbar .session-label { font-size: 14px; font-weight: 600; color: var(--fg); flex: 1; display: flex; align-items: center; gap: 8px; }
.chat-toolbar .session-label .daemon-name { font-size: 12px; color: var(--fg-tertiary); font-weight: 400; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.status-pill.running { background: var(--success-bg); color: var(--success); }
.status-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse-green 1.5s infinite; }

/* Messages */
.chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; position: relative; }
.scroll-to-bottom { position: absolute; bottom: 16px; right: 24px; width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg); font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow-sm); transition: background 0.15s; z-index: 10; }
.scroll-to-bottom:hover { background: var(--surface-hover); }

.msg { max-width: 75%; animation: fade-in 0.2s ease; }
.msg-user { align-self: flex-end; background: var(--user-bubble); color: #fff; padding: 10px 16px; border-radius: 16px 16px 4px 16px; font-size: 14px; line-height: 1.6; }
.msg-agent { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); color: var(--fg); padding: 10px 16px; border-radius: 16px 16px 16px 4px; font-size: 14px; line-height: 1.6; }
.msg-error { align-self: flex-start; background: var(--error-bg); color: var(--error); padding: 10px 16px; border-radius: 16px 16px 16px 4px; font-size: 13px; line-height: 1.6; }

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

/* Tool Cards */
.tool-card { align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); width: 90%; max-width: 560px; overflow: hidden; animation: fade-in 0.2s ease; cursor: pointer; }
.tool-card .tool-header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
.tool-card .tool-icon { font-size: 16px; flex-shrink: 0; }
.tool-card .tool-name { font-weight: 600; font-size: 13px; color: var(--accent); flex: 1; }
.tool-card .tool-args { font-size: 12px; color: var(--fg-tertiary); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.tool-card .tool-status { flex-shrink: 0; }
.tool-card .tool-status .check { color: var(--success); font-size: 14px; }
.tool-card .tool-status .spinner { width: 14px; height: 14px; border: 2px solid transparent; border-top-color: var(--fg-secondary); border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
.tool-card .tool-chevron { color: var(--fg-tertiary); font-size: 12px; transition: transform 0.15s; flex-shrink: 0; }
.tool-card.expanded .tool-chevron { transform: rotate(180deg); }
.tool-card .tool-body { border-top: 1px solid var(--border); display: none; }
.tool-card.expanded .tool-body { display: block; }
.tool-body .tool-section { padding: 8px 16px 0; }
.tool-body .tool-label { font-size: 11px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.tool-body .tool-input { background: var(--code-bg); padding: 8px 16px; font-family: var(--font-mono); font-size: 12px; color: var(--success); border-radius: 4px; margin: 0 12px; white-space: pre-wrap; }
.tool-body .tool-output { background: var(--code-bg); padding: 8px 16px; font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); border-radius: 4px; margin: 8px 12px; max-height: 300px; overflow: auto; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.tool-body .tool-output.collapsed { max-height: 120px; overflow: hidden; }
.tool-body .toggle-expand { background: none; border: none; color: var(--accent); font-size: 12px; padding: 4px 16px 8px; cursor: pointer; font-family: var(--font-body); }

/* Chat Input */
.chat-input-area { border-top: 1px solid var(--border); padding: 12px 20px; background: var(--surface); display: flex; gap: 10px; align-items: center; transition: background var(--transition), border-color var(--transition); }
.chat-input-area.ended { display: flex; align-items: center; justify-content: center; padding: 14px 20px; }
.ended-text { color: var(--fg-tertiary); font-size: 13px; }
.chat-input-wrap { flex: 1; display: flex; align-items: center; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-xl); padding: 0 16px; min-height: 42px; transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-wrap:focus-within { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted); }
.chat-input-wrap input { flex: 1; background: none; border: none; color: var(--fg); font-size: 14px; font-family: var(--font-body); outline: none; padding: 8px 0; }
.chat-input-wrap input::placeholder { color: var(--fg-tertiary); }
.chat-input-wrap input:disabled { opacity: 0.5; }
.send-btn { width: 36px; height: 36px; border-radius: 50%; background: var(--accent); border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.send-btn svg { width: 16px; height: 16px; fill: var(--bg); }

@media (max-width: 1024px) { .session-layout { height: calc(100vh - var(--topbar-h)); } }
@media (max-width: 768px) { .session-panel { display: none; } .msg { max-width: 90%; } }
</style>
