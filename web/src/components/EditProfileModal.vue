<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <button class="header-btn" @click="$emit('close')">取消</button>
        <h3>编辑资料</h3>
        <button class="header-btn primary" @click="save" :disabled="saving">{{ saving ? '保存中...' : '保存' }}</button>
      </div>
      <div class="modal-body">
        <div class="avatar-section">
          <div class="avatar">{{ initial }}</div>
        </div>

        <div class="field">
          <label>昵称</label>
          <input v-model="displayName" type="text" placeholder="请输入昵称" maxlength="100" @keydown.enter="save" />
        </div>

        <div class="field">
          <label>手机号</label>
          <div class="field-static">{{ maskedPhone || '未绑定' }}</div>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuth } from '../composables/useAuth'

const emit = defineEmits<{ close: []; saved: [name: string] }>()
const { user, accessToken } = useAuth()

const displayName = ref(user.value?.display_name || '')
const saving = ref(false)
const error = ref('')

const initial = computed(() => {
  const name = displayName.value || user.value?.display_name || user.value?.phone || 'U'
  return name.charAt(0).toUpperCase()
})

const maskedPhone = computed(() => {
  const phone = user.value?.phone
  if (!phone) return ''
  return phone.slice(0, 3) + '****' + phone.slice(-4)
})

async function save() {
  const name = displayName.value.trim()
  if (!name) {
    error.value = '昵称不能为空'
    return
  }
  saving.value = true
  error.value = ''
  try {
    const token = accessToken.value
    const res = await fetch(`/api/user/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ display_name: name }),
      credentials: 'include',
    })
    const data = await res.json()
    if (!res.ok) {
      error.value = data.error || '保存失败'
      return
    }
    emit('saved', name)
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
.avatar-section { text-align: center; margin-bottom: 24px; }
.avatar { width: 72px; height: 72px; border-radius: 50%; background: var(--surface-active); border: 2px solid var(--border); display: inline-flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 600; color: var(--fg-secondary); }

.field { margin-bottom: 16px; }
.field label { display: block; font-size: 13px; font-weight: 500; color: var(--fg-secondary); margin-bottom: 6px; }
.field input { width: 100%; padding: 10px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 15px; color: var(--fg); outline: none; transition: border-color 0.15s; box-sizing: border-box; }
.field input:focus { border-color: var(--accent); }
.field-static { padding: 10px 14px; font-size: 15px; color: var(--fg-tertiary); background: var(--surface-hover); border-radius: var(--radius-md); }

.error-msg { font-size: 13px; color: var(--error); margin-top: 8px; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; }
  .field input { font-size: 16px; min-height: 44px; }
}
</style>
