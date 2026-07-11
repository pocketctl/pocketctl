<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-dialog">
      <div class="modal-header">
        <h2 class="modal-title">{{ t('new_session.title') }}</h2>
        <button class="modal-close" @click="$emit('close')" :title="t('common.close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <!-- Host Selector -->
        <div class="field-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20"/></svg>
          {{ t('new_session.select_host') }}
        </div>
        <div class="host-selector">
          <div v-if="!daemons || daemons.length === 0" class="host-empty">{{ t('new_session.no_hosts') }}</div>
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
                <span v-if="d.daemon_alias" class="host-alias-tag">{{ t('dashboard.alias_badge') }}</span>
              </div>
              <div class="host-meta">{{ d.ip && d.ip !== 'unknown' ? d.ip + ' · ' : '' }}{{ d.os || 'unknown' }}</div>
            </div>
            <div class="host-status">
              <span :class="['chip', d.daemon_online ? 'chip-online' : 'chip-offline']">{{ d.daemon_online ? t('dashboard.online') : t('dashboard.offline') + ' · ' + t('common.unavailable') }}</span>
            </div>
          </div>
        </div>

        <!-- Agent Type Pills -->
        <div class="field-label">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20"/><path d="M2 12h20"/></svg>
          {{ t('new_session.agent_label') }}
        </div>
        <div class="agent-pills">
          <button :class="['agent-pill', { selected: form.agent === 'claude-code' }]" @click="selectAgent('claude-code')">Claude Code</button>
          <button :class="['agent-pill', { selected: form.agent === 'codex' }]" @click="selectAgent('codex')">Codex</button>
          <button :class="['agent-pill', { selected: form.agent === 'opencode' }]" @click="selectAgent('opencode')">OpenCode</button>
        </div>

        <!-- Working Directory -->
        <div class="form-group">
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            {{ t('new_session.cwd_label') }}
          </div>
          <div class="dir-input">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
            <input type="text" v-model="form.cwd" :placeholder="t('new_session.cwd_placeholder')" />
          </div>
        </div>

        <!-- Agent-specific native permission configuration -->
        <div v-if="form.agent !== 'opencode'" class="form-group">
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            {{ t('new_session.permission_label') }}
          </div>
          <select v-model="permissionValue" class="input-field">
            <option v-for="option in creationPermissionOptions" :key="option.value" :value="option.value" :disabled="option.disabled">
              {{ t(option.titleKey) }} — {{ t(option.descriptionKey) }}
            </option>
          </select>
          <div v-if="codexPermission?.preset === 'custom'" class="permission-custom-grid">
            <select v-model="codexPermission.approval_policy" class="input-field">
              <option :value="undefined">{{ t('session.permission.inherit') }}</option>
              <option value="never">never</option>
            </select>
            <select v-model="codexPermission.sandbox_mode" class="input-field">
              <option :value="undefined">{{ t('session.permission.inherit') }}</option>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </div>
        </div>

        <!-- Model (dynamic: host's available models). All agents — including
             opencode — surface their models via list_models → model_list. -->
        <div>
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
            {{ t('new_session.model_label') }}
          </div>
          <select v-model="form.model" class="model-select">
            <option value="">{{ !modelsLoaded ? t('new_session.model_loading') : (models.length ? t('new_session.model_default') : t('new_session.model_none')) }}</option>
            <option v-for="m in models" :key="m.alias" :value="m.alias">{{ m.name }}</option>
          </select>
        </div>

        <!-- Initial Prompt -->
        <div class="form-group">
          <div class="field-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            {{ t('new_session.prompt_label') }}
          </div>
          <textarea class="prompt-area" v-model="form.prompt" :placeholder="t('new_session.prompt_placeholder')" maxlength="500" @input="updateCharCount" />
          <div class="char-count">{{ charCount }} / 500</div>
        </div>

        <!-- Advanced Options (Scheme A/C/D) -->
        <div class="advanced-section">
          <button type="button" class="advanced-toggle" @click="showAdvanced = !showAdvanced">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
              :style="{ transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s' }">
              <path d="M9 18l6-6-6-6"/>
            </svg>
            {{ t('new_session.advanced_options') }}
          </button>
          <div v-if="showAdvanced" class="advanced-body">
            <label class="advanced-option">
              <input type="checkbox" v-model="form.autoCreateDir" />
              <span class="option-text">
                <span class="option-label">{{ t('new_session.option_auto_create_dir') }}</span>
                <span class="option-hint">{{ t('new_session.option_auto_create_dir_hint') }}</span>
              </span>
            </label>
            <label class="advanced-option">
              <input type="checkbox" v-model="form.worktree" :disabled="form.agent === 'opencode'" />
              <span class="option-text">
                <span class="option-label">{{ t('new_session.option_worktree') }}</span>
                <span class="option-hint">{{ t('new_session.option_worktree_hint') }}</span>
              </span>
            </label>
          </div>
        </div>

        <!-- cwd_in_use confirmation (Scheme A) -->
        <div v-if="cwdInUse" class="cwd-in-use-confirm">
          <label class="advanced-option">
            <input type="checkbox" v-model="form.force" />
            <span class="option-text">
              <span class="option-label">{{ t('new_session.force_create_label') }}</span>
              <span class="option-hint">{{ t('new_session.force_create_hint') }}</span>
            </span>
          </label>
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
          <button class="btn btn-cancel" :disabled="creating" @click="$emit('close')">{{ t('common.cancel') }}</button>
          <button class="btn btn-start" :class="{ 'is-loading': creating }" :disabled="!canStart || creating" @click="startSession">
            <span class="btn-content">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
              {{ t('new_session.start_btn') }}
            </span>
            <span v-if="creating" class="btn-loading">
              <span class="spinner"></span>
              {{ phase === 'connecting' ? t('new_session.connecting_phase') : t('new_session.creating') }}
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import { useLocale } from '../composables/useLocale'
import { defaultPermission, expandCodexPreset, permissionOptions, type AgentType, type ClaudeMode, type CodexPreset, type PermissionConfig } from '../types/permission'

const props = defineProps<{ daemons?: any[]; preSelectedDaemonId?: string }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const { connect, send, onEvent } = useWebSocket()
const { t } = useLocale()

const form = reactive({
  daemonId: '',
  agent: 'claude-code',
  cwd: localStorage.getItem('pocketctl_default_cwd') || '~/',
  prompt: '',
  permission: defaultPermission('claude-code') as PermissionConfig | undefined,
  model: '',  // '' = follow host default | opus | sonnet | haiku alias
  // Scheme A/C/D advanced options
  autoCreateDir: true,   // 目录不存在时自动创建（默认开）
  worktree: false,       // Git worktree 隔离（默认关）
  force: false,          // 明知 cwd 被占用仍强制创建（cwd_in_use 错误后出现）
})
const showAdvanced = ref(false)  // 高级选项折叠状态
const cwdInUse = ref(false)      // 是否处于 cwd_in_use 确认状态
// Available models for the selected host (populated by list_models → model_list)
const models = ref<Array<{ alias: string; name: string }>>([])
const modelsLoaded = ref(false)  // true once model_list response received (even if empty)
const creating = ref(false)
const phase = ref<'submitting' | 'connecting'>('submitting')
const errorTitle = ref('')
const errorDesc = ref('')
const charCount = ref(0)
const selectedDaemonName = computed(() => {
  const d = props.daemons?.find((x: any) => x.daemon_id === form.daemonId)
  return d?.daemon_alias || d?.hostname || t('nav.hosts')
})

const canStart = computed(() => !!(form.daemonId && form.agent))
const creationPermissionOptions = computed(() => permissionOptions(form.agent as AgentType, true))
const codexPermission = computed(() => form.permission?.agent === 'codex' ? form.permission : undefined)
const permissionValue = computed({
  get: () => form.permission?.agent === 'claude-code' ? form.permission.mode : form.permission?.preset || '',
  set: (value: string) => {
    form.permission = form.agent === 'claude-code'
      ? { agent: 'claude-code', mode: value as ClaudeMode }
      : expandCodexPreset(value as CodexPreset)
  },
})
const isAgentAvailable = computed(() => form.agent === 'claude-code' || form.agent === 'codex' || form.agent === 'opencode')

function selectHost(d: any) {
  if (!d.daemon_online) return
  form.daemonId = form.daemonId === d.daemon_id ? '' : d.daemon_id
}

// selectAgent switches agent and re-queries that agent's available models for the
// selected host (Claude/Codex). opencode models come from its serve API and are
// not yet surfaced, so its picker stays hidden.
function selectAgent(agent: string) {
  if (form.agent === agent) return
  form.agent = agent
  form.permission = defaultPermission(agent as AgentType)
  models.value = []
  modelsLoaded.value = false
  form.model = ''
  if (form.daemonId) send({ type: 'list_models', daemon_id: form.daemonId, agent })
}

function updateCharCount() {
  charCount.value = form.prompt.length
}

function hideError() {
  errorTitle.value = ''
  errorDesc.value = ''
}

function showError(reason: string, err?: string) {
  const host = selectedDaemonName.value
  const map: Record<string, { title: string; desc: string }> = {
    no_cli: { title: t('new_session.error_title', { host }), desc: t('new_session.failed_no_cli_desc') },
    bad_cwd: { title: t('new_session.error_title', { host }), desc: err ? `${t('new_session.failed_bad_cwd_desc', { cwd: form.cwd || '/' })}\n${err}` : t('new_session.failed_bad_cwd_desc', { cwd: form.cwd || '/' }) },
    cwd_in_use: { title: t('new_session.error_title', { host }), desc: err || t('new_session.failed_cwd_in_use_desc', { cwd: form.cwd || '/' }) },
    start_fail: { title: t('new_session.error_title', { host }), desc: t('new_session.failed_start_desc', { error: err || t('dashboard.unknown_error') }) },
    timeout: { title: t('new_session.error_title', { host }), desc: t('new_session.failed_timeout_desc') },
    daemon_offline: { title: t('new_session.error_title', { host }), desc: t('new_session.failed_offline_desc') },
  }
  // Scheme A: cwd_in_use 进入"确认覆盖"状态，用户可勾选强制创建后重试
  if (reason === 'cwd_in_use') {
    cwdInUse.value = true
  }
  const e = map[reason] || { title: t('new_session.failed'), desc: err || t('dashboard.unknown_error') }
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
  cwdInUse.value = false
  done = false

  // Save working directory for next time
  if (form.cwd) localStorage.setItem('pocketctl_default_cwd', form.cwd)

  // ① session_created: redirect immediately, SessionDetail loading handles the wait
  cleanupFns.push(onEvent('session_created', (msg: any) => {
    if (done) return
    const sid = msg.session_id as string
    if (!sid || sid.startsWith('pending')) { phase.value = 'connecting'; return }
    done = true
    pendingSessionId = sid
    if (timeoutTimer) clearTimeout(timeoutTimer)
    creating.value = false
    const daemonId = msg.daemon_id || form.daemonId
    const query = daemonId ? { host: daemonId } : {}
    router.push({ path: `/session/${sid}`, query })
    emit('close')
  }))

  // ② session_id_changed(real): for discovered sessions
  cleanupFns.push(onEvent('session_id_changed', (msg: any) => {
    if (done) return
    if (msg.old_session_id && msg.old_session_id !== pendingSessionId) return
    done = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    creating.value = false
    const daemonId = msg.daemon_id || form.daemonId
    const query = daemonId ? { host: daemonId } : {}
    router.push({ path: `/session/${msg.session_id}`, query })
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
    permission: form.permission,
    model: form.model || undefined,
    worktree: form.worktree || undefined,
    auto_create_dir: form.autoCreateDir || undefined,
    force: form.force || undefined,
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

// Auto-select daemon: ① 若传入 preSelectedDaemonId（从某主机跳来带 host filter）则预选它；
// ② 否则当可选（在线）主机恰好一台时，自动选中它，省去手动点击。
// 用户手动切换/取消后（form.daemonId 非空），不再自动覆盖。
// immediate: 必须立即执行一次——弹窗打开时 props.daemons 往往已就绪，惰性 watch 不会触发。
let autoSelectDone = false
watch([() => props.daemons, () => props.preSelectedDaemonId], ([daemons, preId]) => {
  if (autoSelectDone || !daemons?.length) return
  if (form.daemonId) { autoSelectDone = true; return }  // 用户已选择则锁定
  const online = daemons.filter(d => d.daemon_online)
  if (preId) {
    const target = online.find(d => d.daemon_id === preId)
    if (target) { form.daemonId = preId; autoSelectDone = true }
    return
  }
  // 仅一台在线主机 → 自动选中
  if (online.length === 1) { form.daemonId = online[0].daemon_id; autoSelectDone = true }
}, { immediate: true })

// Fetch available models whenever the selected host changes
watch(() => form.daemonId, (id) => {
  models.value = []
  modelsLoaded.value = false
  form.model = ''
  if (id) send({ type: 'list_models', daemon_id: id, agent: form.agent })
})

onMounted(() => {
  connect()
  // Receive available models for the selected host (model picker)
  cleanupFns.push(onEvent('model_list', (msg: any) => {
    models.value = msg.models || []
    modelsLoaded.value = true
  }))
  if (form.daemonId) send({ type: 'list_models', daemon_id: form.daemonId, agent: form.agent })
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
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px 0; }
.modal-title { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--fg); }
.modal-close {
  width: 28px; height: 28px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--surface-hover);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--fg-secondary);
  transition: background 0.15s, color 0.15s;
}
.modal-close:hover { background: var(--surface-active); color: var(--fg); }

/* Body */
.modal-body { padding: 14px 20px 18px; }

/* Labels */
.field-label {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 600; color: var(--fg-secondary);
  margin-bottom: 7px; text-transform: uppercase; letter-spacing: 0.4px;
}
.field-label svg { color: var(--fg-tertiary); }

/* Host Selector */
.host-selector { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.host-option {
  display: flex; align-items: center; gap: 12px; padding: 9px 14px;
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
.agent-pills { display: flex; gap: 6px; margin-bottom: 16px; }
.model-select {
  width: 100%; padding: 9px 12px; margin-bottom: 16px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); color: var(--fg); font-size: 13px;
  cursor: pointer; transition: border-color 0.15s ease;
}
.model-select:hover { border-color: var(--border-light); }
.model-select:focus { outline: none; border-color: var(--accent); }
.agent-pill {
  flex: 1; padding: 9px 14px; border-radius: var(--radius-md);
  font-size: 13px; font-weight: 600; border: 2px solid var(--border);
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
.form-group { margin-bottom: 14px; }
.dir-input {
  display: flex; align-items: center; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 0 12px; gap: 10px; transition: border-color 0.15s, box-shadow 0.15s;
}
.dir-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.dir-input svg { flex-shrink: 0; color: var(--fg-tertiary); }
.dir-input input {
  flex: 1; background: none; border: none; color: var(--fg);
  font-family: var(--font-mono); font-size: 13px; padding: 9px 0; outline: none;
}
.dir-input input::placeholder { color: var(--fg-tertiary); }

.prompt-area {
  width: 100%; min-height: 80px; background: var(--bg);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 10px 12px; color: var(--fg); font-family: var(--font-body);
  font-size: 13px; outline: none; resize: vertical; line-height: 1.6;
  transition: border-color 0.15s, box-shadow 0.15s; box-sizing: border-box;
}
.prompt-area:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.prompt-area::placeholder { color: var(--fg-tertiary); }
.char-count { text-align: right; font-size: 11px; color: var(--fg-tertiary); margin-top: 4px; }
.permission-custom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }

/* Advanced Options (Scheme A/C/D) */
.advanced-section { margin-bottom: 16px; }
.advanced-toggle {
  display: flex; align-items: center; gap: 4px;
  background: none; border: none; cursor: pointer;
  font-size: 12px; font-weight: 600; color: var(--fg-secondary);
  text-transform: uppercase; letter-spacing: 0.4px;
  padding: 0; font-family: var(--font-body);
}
.advanced-toggle:hover { color: var(--fg); }
.advanced-toggle svg { color: var(--fg-tertiary); flex-shrink: 0; }
.advanced-body {
  margin-top: 8px; padding: 10px 12px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-md);
  display: flex; flex-direction: column; gap: 10px;
}
.advanced-option { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
.advanced-option input[type="checkbox"]:disabled { opacity: 0.4; cursor: not-allowed; }
.advanced-option:has(input[type="checkbox"]:disabled) { opacity: 0.6; cursor: not-allowed; }
.advanced-option input[type="checkbox"] {
  margin-top: 2px; width: 16px; height: 16px; accent-color: var(--accent);
  cursor: pointer; flex-shrink: 0;
}
.option-text { display: flex; flex-direction: column; gap: 2px; }
.option-label { font-size: 13px; font-weight: 500; color: var(--fg); }
.option-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.4; }
.cwd-in-use-confirm {
  margin-bottom: 16px; padding: 12px 14px;
  background: rgba(210,153,34,0.08); border: 1px solid rgba(210,153,34,0.3);
  border-radius: var(--radius-md);
}

/* Error Banner (设计稿 .modal-error) */
.modal-error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.35); margin-bottom: 12px; animation: fade-in 0.2s ease; }
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
.btn { padding: 10px; font-size: 14px; font-weight: 600; border-radius: var(--radius-md); cursor: pointer; border: none; font-family: var(--font-body); transition: background 0.15s; }
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
