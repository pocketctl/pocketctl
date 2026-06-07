<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <h1 class="logo">pocketctl</h1>
        <p class="subtitle">Your coding agents, in your pocket.</p>
      </div>
      <div class="tabs">
        <button :class="['tab', { active: mode === 'login' }]" @click="mode = 'login'">登录</button>
        <button :class="['tab', { active: mode === 'register' }]" @click="mode = 'register'">注册</button>
      </div>
      <form @submit.prevent="handleSubmit">
        <div class="field">
          <label>Email</label>
          <input v-model="email" type="email" placeholder="user@example.com" required />
        </div>
        <div class="field">
          <label>密码</label>
          <input v-model="password" type="password" :placeholder="mode === 'register' ? '至少 6 位' : '输入密码'" required />
        </div>
        <div v-if="mode === 'register'" class="field">
          <label>显示名称（可选）</label>
          <input v-model="displayName" type="text" placeholder="你的名字" />
        </div>
        <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
        <button type="submit" class="btn primary" :disabled="loading">
          {{ loading ? '请稍候...' : (mode === 'login' ? '登录' : '注册') }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const router = useRouter()
const { login, register } = useAuth()

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const displayName = ref('')
const errorMsg = ref('')
const loading = ref(false)

async function handleSubmit() {
  errorMsg.value = ''
  loading.value = true

  const err = mode.value === 'login'
    ? await login(email.value.trim(), password.value)
    : await register(email.value.trim(), password.value, displayName.value.trim() || undefined)

  if (err) {
    errorMsg.value = err
    loading.value = false
  } else {
    router.push('/')
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 400px;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 12px;
  padding: 32px 28px;
}
.login-header { text-align: center; margin-bottom: 24px; }
.logo { font-size: 28px; font-weight: 800; color: #58a6ff; margin-bottom: 4px; }
.subtitle { color: #8b949e; font-size: 14px; }
.tabs { display: flex; gap: 0; margin-bottom: 20px; background: #0d1117; border-radius: 8px; padding: 3px; }
.tab {
  flex: 1; padding: 8px; border: none; background: transparent;
  color: #8b949e; font-size: 14px; font-weight: 600; cursor: pointer; border-radius: 6px;
}
.tab.active { background: #21262d; color: #e6edf3; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 5px; }
.field input {
  width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d;
  border-radius: 6px; color: #e6edf3; font-size: 15px; outline: none; -webkit-appearance: none;
}
.field input:focus { border-color: #58a6ff; }
.field input::placeholder { color: #484f58; }
.error-msg {
  background: #3d1214; border: 1px solid #da3633; color: #f85149;
  padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px;
}
.btn {
  width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #30363d;
  background: #21262d; color: #e6edf3; cursor: pointer; font-size: 15px; font-weight: 600; min-height: 44px;
}
.btn.primary { background: #238636; border-color: #238636; }
.btn.primary:hover:not(:disabled) { background: #2ea043; }
.btn:disabled { opacity: 0.6; cursor: not-allowed; }
@media (max-width: 768px) {
  .login-card { padding: 24px 20px; }
  .logo { font-size: 24px; }
}
</style>
