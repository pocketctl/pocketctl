<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <button class="header-btn" @click="close">取消</button>
        <h3>绑定邮箱</h3>
        <button class="header-btn primary" data-test="confirm" @click="confirm" :disabled="saving || !codeSent || code.length !== 6">{{ saving ? '保存中...' : '确认绑定' }}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>邮箱地址</label>
          <div class="email-row">
            <input v-model="email" type="email" placeholder="请输入邮箱地址" :disabled="codeSent" />
            <button class="send-btn" data-test="send-code" :disabled="sending || cooldown > 0 || !emailValid" @click="sendCode">
              {{ sendButtonText }}
            </button>
          </div>
        </div>

        <div v-if="codeSent" class="field">
          <label>验证码</label>
          <input v-model="code" inputmode="numeric" maxlength="6" data-test="code" placeholder="6 位邮箱验证码" @keydown.enter="confirm" />
        </div>

        <div class="hint">{{ codeSent ? '验证码已发送到该邮箱，10 分钟内有效' : '绑定前需要验证该邮箱的所有权：输入邮箱后先获取验证码' }}</div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useAuth } from '../composables/useAuth'

const emit = defineEmits<{ close: []; saved: [email: string] }>()
const { user, accessToken } = useAuth()

const currentEmail = user.value?.email || ''
const email = ref(currentEmail.startsWith('1') ? '' : currentEmail)
const code = ref('')
const codeSent = ref(false)
const sending = ref(false)
const saving = ref(false)
const error = ref('')
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const emailValid = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()))
const sendButtonText = computed(() => {
  if (cooldown.value > 0) return `重新获取 (${cooldown.value}s)`
  if (sending.value) return '发送中...'
  return codeSent.value ? '重新获取验证码' : '获取验证码'
})

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
}

function startCooldown() {
  cooldown.value = 60
  stopCooldown()
  cooldownTimer = setInterval(() => {
    cooldown.value -= 1
    if (cooldown.value <= 0) stopCooldown()
  }, 1000)
}

function close() {
  stopCooldown()
  emit('close')
}

onBeforeUnmount(stopCooldown)

async function sendCode() {
  const val = email.value.trim().toLowerCase()
  if (!emailValid.value) {
    error.value = '请输入有效的邮箱地址'
    return
  }
  sending.value = true
  error.value = ''
  try {
    const token = accessToken.value
    const res = await fetch(`/api/user/email/send-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: val }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      error.value = data.error || '验证码发送失败'
      return
    }
    codeSent.value = true
    startCooldown()
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    sending.value = false
  }
}

async function confirm() {
  const val = email.value.trim().toLowerCase()
  if (!codeSent.value) {
    error.value = '请先获取验证码'
    return
  }
  if (!/^\d{6}$/.test(code.value)) {
    error.value = '请输入 6 位验证码'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const token = accessToken.value
    const res = await fetch(`/api/user/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: val, code: code.value }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      error.value = data.error || '绑定失败'
      return
    }
    stopCooldown()
    emit('saved', val)
  } catch {
    error.value = '网络错误，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade-in 0.15s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); width: 440px; max-width: 90vw; animation: slide-up 0.2s ease; overflow: hidden; }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.modal-header h3 { font-size: 16px; font-weight: 600; color: var(--fg); margin: 0; }
.header-btn { background: none; border: none; font-size: 15px; color: var(--fg-secondary); cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: color 0.15s; }
.header-btn:hover { color: var(--fg); }
.header-btn.primary { color: var(--accent); font-weight: 600; }
.header-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }

.modal-body { padding: 24px 20px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; font-weight: 500; color: var(--fg-secondary); margin-bottom: 6px; }
.field input { width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 15px; color: var(--fg); outline: none; transition: border-color 0.15s; box-sizing: border-box; }
.field input:focus { border-color: var(--accent); }
.field input:disabled { opacity: 0.7; }

.email-row { display: flex; gap: 8px; }
.email-row input { flex: 1; }
.send-btn { flex-shrink: 0; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg); color: var(--accent); font-size: 13px; cursor: pointer; white-space: nowrap; }
.send-btn:disabled { color: var(--fg-tertiary); cursor: not-allowed; }

.hint { font-size: 13px; color: var(--fg-tertiary); margin-bottom: 8px; }
.error-msg { font-size: 13px; color: var(--error); margin-top: 8px; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; }
  .field input { font-size: 16px; min-height: 44px; }
}
</style>
