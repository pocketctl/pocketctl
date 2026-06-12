<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <button class="header-btn" @click="$emit('close')">取消</button>
        <h3>绑定邮箱</h3>
        <button class="header-btn primary" @click="save" :disabled="saving || !email.trim()">{{ saving ? '保存中...' : '保存' }}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>邮箱地址</label>
          <input v-model="email" type="email" placeholder="请输入邮箱地址" @keydown.enter="save" />
        </div>

        <div class="hint">绑定邮箱后可用于登录和接收通知</div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuth } from '../composables/useAuth'

const emit = defineEmits<{ close: []; saved: [email: string] }>()
const { user } = useAuth()

const currentEmail = user.value?.email || ''
const email = ref(currentEmail.startsWith('1') ? '' : currentEmail)
const saving = ref(false)
const error = ref('')

async function save() {
  const val = email.value.trim().toLowerCase()
  if (!val || !val.includes('@')) {
    error.value = '请输入有效的邮箱地址'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const token = localStorage.getItem('pocketctl_access_token')
    const res = await fetch(`/api/user/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: val }),
    })
    const data = await res.json()
    if (!res.ok) {
      error.value = data.error || '绑定失败'
      return
    }
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
