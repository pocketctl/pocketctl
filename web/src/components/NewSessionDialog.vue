<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-dialog">
      <div class="modal-header">
        <h2 class="modal-title">新建会话</h2>
        <button class="modal-close" @click="$emit('close')" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <!-- Host Selector -->
        <div class="field-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20"/></svg>
          选择目标主机
        </div>
        <div class="host-selector">
          <div v-if="!daemons || daemons.length === 0" class="host-empty">暂无可用主机</div>
          <div v-for="d in daemons" :key="d.daemon_id"
            :class="['host-option', { selected: form.daemonId === d.daemon_id, disabled: !d.daemon_online }]"
            @click="selectHost(d)">
            <div class="host-radio"></div>
            <div class="host-icon">
              <svg v-if="d.daemon_online" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg>
            </div>
            <div class="host-info">
              <div class="host-name">
                {{ d.daemon_alias || d.hostname || d.daemon_id?.slice(0, 8) }}
                <span v-if="d.daemon_alias" class="host-alias-tag">别名</span>
              </div>
              <div class="host-meta">{{ d.ip && d.ip !== 'unknown' ? d.ip + ' · ' : '' }}{{ d.os || 'unknown' }}</div>
            </div>
            <div class="host-status">
              <span :class="['chip', d.daemon_online ? 'chip-online' : 'chip-offline']">{{ d.daemon_online ? '在线' : '离线 · 不可用' }}</span>
            </div>
          </div>
        </div>

        <!-- Agent Type Pills -->
        <div class="field-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20"/><path d="M2 12h20"/></svg>
          Agent 类型
        </div>
        <div class="agent-pills">
          <button :class="['agent-pill', { selected: form.agent === 'claude-code' }]" @click="form.agent = 'claude-code'">Claude Code</button>
          <button :class="['agent-pill', { selected: form.agent === 'codex' }]" @click="form.agent = 'codex'">
            Codex
            <span class="coming-badge">即将开通</span>
          </button>
        </div>

        <!-- Codex Notice -->
        <div v-if="form.agent === 'codex'" class="codex-notice">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6M12 18h.01"/></svg>
          Codex 代理即将开通，敬请期待
        </div>

        <!-- Working Directory -->
        <div class="form-group">
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            工作目录
          </div>
          <div class="dir-input">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            <input type="text" v-model="form.cwd" placeholder="输入项目路径，如 ~/projects/my-app" />
          </div>
        </div>

        <!-- Initial Prompt -->
        <div class="form-group">
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            初始提示
          </div>
          <textarea class="prompt-area" v-model="form.prompt" placeholder="描述你想让 AI 完成的任务…&#10;例如：帮我重构用户认证模块，从 JWT 迁移到 OAuth 2.0" maxlength="500" @input="updateCharCount" />
          <div class="char-count">{{ charCount }} / 500</div>
        </div>

        <!-- Error Banner (设计稿 .modal-error) -->
        <div v-if="errorTitle" class="modal-error visible">
          <svg class="err-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <div class="err-body">
            <div class="err-title">{{ errorTitle }}</div>
            <div v-if="errorDesc" class="err-desc">{{ errorDesc }}</div>
          </div>
          <button class="err-close" @click="hideError">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        <!-- Footer Actions -->
        <div class="modal-footer">
          <button class="btn btn-cancel" :disabled="creating" @click="$emit('close')">取消</button>
          <button class="btn btn-start" :class="{ 'is-loading': creating }" :disabled="!canStart || creating" @click="startSession">
            <span class="btn-content">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
              开始会话
            </span>
            <span v-if="creating" class="btn-loading">
              <span class="spinner"></span>
              {{ phase === 'connecting' ? '正在连接主机…' : '正在创建…' }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'

const props = defineProps<{ daemons?: any[] }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const { connect, send, onEvent } = useWebSocket()

const form = reactive({
  daemonId: '',
  agent: 'claude-code',
  cwd: localStorage.getItem('pocketctl_default_cwd') || '',
  prompt: '',
})
const creating = ref(false)
const phase = ref<'submitting' | 'connecting'>('submitting')
const errorTitle = ref('')
const errorDesc = ref('')
const charCount = ref(0)
const selectedDaemonName = computed(() => {
  const d = props.daemons?.find((x: any) => x.daemon_id === form.daemonId)
  return d?.daemon_alias || d?.hostname || '主机'
})

const canStart = computed(() => !!(form.daemonId && form.agent === 'claude-code'))
const isAgentAvailable = computed(() => form.agent === 'claude-code')

function selectHost(d: any) {
  if (!d.daemon_online) return
  form.daemonId = form.daemonId === d.daemon_id ? '' : d.daemon_id
}

function updateCharCount() {
  charCount.value = form.prompt.length
}

function hideError() {
  errorTitle.value = ''
  errorDesc.value = ''
}

function showError(reason: string, err?: string) {
  const map: Record<string, { title: string; desc: string }> = {
    no_cli: { title: `无法在「${selectedDaemonName.value}」上创建会话`, desc: '主机未安装 Claude Code CLI，请在主机上安装后重试' },
    bad_cwd: { title: `无法在「${selectedDaemonName.value}」上创建会话`, desc: `工作目录不可用：${form.cwd || '/'}，请检查路径与权限` },
    start_fail: { title: `无法在「${selectedDaemonName.value}」上创建会话`, desc: `Agent 进程启动失败：${err || '未知错误'}` },
    timeout: { title: `无法在「${selectedDaemonName.value}」上创建会话`, desc: '主机连接超时：daemon 未在 15 秒内完成会话初始化。请确认主机在线、daemon 与 claude CLI 运行正常后重试' },
    daemon_offline: { title: `无法在「${selectedDaemonName.value}」上创建会话`, desc: '主机离线或无可用的 daemon，请确认主机在线后重试' },
  }
  const e = map[reason] || { title: '创建失败', desc: err || '未知错误' }
  errorTitle.value = e.title
  errorDesc.value = e.desc
}

let cleanupFns: (() => void)[] = []
let timeoutTimer: ReturnType<typeof setTimeout> | null = null
let pendingSessionId = ''
let done = false

function startSession() {
  if (!canStart.value || creating.value) return
  creating.value = true
  phase.value = 'submitting'
  hideError()
  done = false

  // Save working directory for next time
  if (form.cwd) localStorage.setItem('pocketctl_default_cwd', form.cwd)

  // ① session_created(pending): 切 CONNECTING 态，不跳转
  cleanupFns.push(onEvent('session_created', (msg: any) => {
    if (done) return
    phase.value = 'connecting'
    pendingSessionId = msg.session_id
  }))

  // ② session_id_changed(real): 跳转到真实 ID
  cleanupFns.push(onEvent('session_id_changed', (msg: any) => {
    if (done) return
    if (msg.old_session_id && msg.old_session_id !== pendingSessionId) return
    done = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    creating.value = false
    router.push(`/session/${msg.session_id}`)
    emit('close')
  }))

  // ③ session_create_failed: 显示失败 banner
  cleanupFns.push(onEvent('session_create_failed', (msg: any) => {
    if (done) return
    done = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    creating.value = false
    showError(msg.reason || 'start_fail', msg.error)
  }))

  // ④ error (兜底): 显示失败
  cleanupFns.push(onEvent('error', (msg: any) => {
    if (done || !creating.value) return
    done = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    creating.value = false
    showError('start_fail', msg.error)
  }))

  // Send create command with daemon_id
  send({
    type: 'session_create',
    daemon_id: form.daemonId,
    agent: form.agent,
    cwd: form.cwd || undefined,
    prompt: form.prompt || undefined,
  })

  // Timeout 15s: abort + show failure
  timeoutTimer = setTimeout(() => {
    if (done) return
    done = true
    creating.value = false
    // 发送 abort_create 清理 daemon 上已启动的 claude 进程
    if (pendingSessionId) send({ type: 'abort_create', session_id: pendingSessionId })
    showError('timeout')
  }, 15000)
}

onMounted(() => {
  connect()
  // Close on Escape
  const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') emit('close') }
  document.addEventListener('keydown', escHandler)
  cleanupFns.push(() => document.removeEventListener('keydown', escHandler))
})

onUnmounted(() => {
  for (const fn of cleanupFns) fn()
  if (timeoutTimer) clearTimeout(timeoutTimer)
})
</script>

<style scoped>
/* Overlay */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(1, 4, 9, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 100;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  animation: fade-in 0.2s ease;
}
[data-theme="light"] .modal-overlay { background: rgba(31, 35, 40, 0.3); }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

/* Dialog */
.modal-dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-2xl, 16px);
  width: 100%; max-width: 520px; max-height: 90vh;
  overflow-y: auto;
  animation: slide-up 0.25s ease;
  box-shadow: var(--shadow-lg);
  transition: background var(--transition), border-color var(--transition);
}
@keyframes slide-up { from { opacity: 0; transform: translateY(24px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* Header */
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px 0; }
.modal-title { font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--fg); }
.modal-close {
  width: 32px; height: 32px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--surface-hover);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--fg-secondary);
  transition: background 0.15s, color 0.15s;
}
.modal-close:hover { background: var(--surface-active); color: var(--fg); }

/* Body */
.modal-body { padding: 20px 24px 24px; }

/* Labels */
.field-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 600; color: var(--fg-secondary);
  margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.4px;
}
.field-label svg { color: var(--fg-tertiary); }

/* Host Selector */
.host-selector { display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }
.host-option {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  border: 2px solid var(--border); border-radius: var(--radius-lg);
  cursor: pointer; transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  background: var(--bg);
}
.host-option:hover { border-color: var(--border-light); background: var(--surface-hover); }
.host-option.selected { border-color: var(--accent); background: var(--accent-subtle, rgba(88,166,255,0.06)); box-shadow: 0 0 0 1px var(--accent-muted); }
.host-option.disabled { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
.host-radio {
  width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--border);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: border-color 0.15s, background 0.15s;
}
.host-option.selected .host-radio { border-color: var(--accent); background: var(--accent); }
.host-option.selected .host-radio::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #fff; }
.host-icon {
  width: 36px; height: 36px; border-radius: var(--radius-md);
  background: var(--surface-active); display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.host-icon svg { width: 18px; height: 18px; color: var(--fg-secondary); }
.host-info { flex: 1; min-width: 0; }
.host-name { font-size: 14px; font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 6px; }
.host-alias-tag { font-size: 10px; font-weight: 500; color: var(--accent); background: var(--accent-muted); padding: 1px 6px; border-radius: 4px; }
.host-meta { font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); margin-top: 2px; }
.host-status { flex-shrink: 0; }
.host-empty { text-align: center; padding: 16px; font-size: 13px; color: var(--fg-tertiary); }

/* Agent Pills */
.agent-pills { display: flex; gap: 8px; margin-bottom: 24px; }
.agent-pill {
  flex: 1; padding: 11px 20px; border-radius: var(--radius-md);
  font-size: 14px; font-weight: 600; border: 2px solid var(--border);
  cursor: pointer; transition: all 0.15s; font-family: var(--font-body);
  text-align: center; background: var(--bg); color: var(--fg-secondary);
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.agent-pill:hover { border-color: var(--border-light); color: var(--fg); }
.agent-pill.selected { border-color: var(--accent); background: var(--accent-subtle, rgba(88,166,255,0.06)); color: var(--accent); }
.coming-badge { font-size: 10px; font-weight: 500; color: var(--warning, #d29922); background: rgba(210,153,34,0.15); padding: 1px 6px; border-radius: 4px; }

/* Codex Notice */
.codex-notice { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-secondary); padding: 10px 14px; background: var(--bg); border-radius: var(--radius-md); margin-bottom: 20px; border: 1px solid var(--border); }
.codex-notice svg { color: var(--warning, #d29922); flex-shrink: 0; }

/* Form */
.form-group { margin-bottom: 20px; }
.dir-input {
  display: flex; align-items: center; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 0 14px; gap: 10px; transition: border-color 0.15s, box-shadow 0.15s;
}
.dir-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.dir-input svg { flex-shrink: 0; color: var(--fg-tertiary); }
.dir-input input {
  flex: 1; background: none; border: none; color: var(--fg);
  font-family: var(--font-mono); font-size: 14px; padding: 12px 0; outline: none;
}
.dir-input input::placeholder { color: var(--fg-tertiary); }

.prompt-area {
  width: 100%; min-height: 100px; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 12px 14px; color: var(--fg); font-family: var(--font-body);
  font-size: 14px; outline: none; resize: vertical; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box;
}
.prompt-area:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.prompt-area::placeholder { color: var(--fg-tertiary); }
.char-count { text-align: right; font-size: 11px; color: var(--fg-tertiary); margin-top: 4px; }

/* Error Banner (设计稿 .modal-error) */
.modal-error { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px; border-radius: var(--radius-md); background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.35); margin-bottom: 16px; animation: fade-in 0.2s ease; }
[data-theme="light"] .modal-error { background: var(--error-bg); border-color: rgba(207,34,46,0.3); }
.modal-error .err-icon { color: var(--error); margin-top: 1px; flex-shrink: 0; }
.modal-error .err-body { flex: 1; min-width: 0; }
.modal-error .err-title { font-size: 13px; font-weight: 600; color: var(--error); }
.modal-error .err-desc { font-size: 12px; color: var(--fg-secondary); margin-top: 3px; line-height: 1.5; }
.modal-error .err-close { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 2px; flex-shrink: 0; }
.modal-error .err-close:hover { color: var(--fg); }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }

/* Footer */
.modal-footer { display: flex; gap: 10px; padding-top: 4px; }
.btn { padding: 12px; font-size: 15px; font-weight: 600; border-radius: var(--radius-md); cursor: pointer; border: none; font-family: var(--font-body); transition: background 0.15s; }
.btn-cancel { flex: 1; background: var(--surface-hover); color: var(--fg-secondary); border: 1px solid var(--border); }
.btn-cancel:hover:not(:disabled) { background: var(--surface-active); color: var(--fg); }
.btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-start {
  flex: 2; background: var(--primary-btn); color: #fff;
  display: flex; align-items: center; justify-content: center; gap: 6px;
}
.btn-start:hover:not(:disabled) { background: var(--primary-btn-hover); }
.btn-start:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-start.is-loading { opacity: 0.9; cursor: wait; background: var(--primary-btn-hover); }
.btn-content, .btn-loading { display: inline-flex; align-items: center; gap: 6px; }
.btn-start.is-loading .btn-content { display: none; }
.btn-start .btn-loading { display: none; }
.btn-start.is-loading .btn-loading { display: inline-flex; }
.spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Mobile */
@media (max-width: 768px) {
  .modal-overlay { padding: 0; align-items: flex-end; }
  .modal-dialog { max-width: 100%; border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom); animation: slide-up-mobile 0.3s ease; }
  @keyframes slide-up-mobile { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .modal-footer { flex-direction: column; }
}
</style>
