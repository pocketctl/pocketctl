<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>关于</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="about-content">
        <div class="about-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        </div>
        <h2 class="about-name">pocketctl</h2>
        <div class="about-version">v1.0.1</div>
        <div class="about-tagline">远程掌控你的 AI 编程助手</div>
        <div class="about-server" v-if="relayUrl">
          <span class="status-dot" :class="connected ? 'online' : 'offline'"></span>
          <span class="server-text">服务器: {{ relayUrl }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

defineEmits<{ close: [] }>()

const relayUrl = ref('')
const connected = ref(false)

onMounted(() => {
  relayUrl.value = localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || ''
  try {
    const u = new URL(relayUrl.value)
    relayUrl.value = u.host
  } catch {}
  connected.value = true
})
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade-in 0.15s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; width: 420px; max-width: 90vw; animation: slide-up 0.2s ease; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.modal-header h3 { font-size: 18px; font-weight: 700; color: var(--fg); margin: 0; }
.close-btn { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; transition: color 0.15s; }
.close-btn:hover { color: var(--fg); }

.about-content { text-align: center; padding: 20px 0; }
.about-icon { color: var(--accent); margin-bottom: 16px; }
.about-name { font-size: 24px; font-weight: 700; color: var(--accent); margin: 0 0 8px; }
.about-version { font-size: 14px; color: var(--fg-secondary); margin-bottom: 8px; }
.about-tagline { font-size: 15px; color: var(--fg-secondary); margin-bottom: 20px; }
.about-server { display: flex; align-items: center; justify-content: center; gap: 6px; }
.about-server .status-dot { width: 8px; height: 8px; border-radius: 50%; }
.about-server .status-dot.online { background: var(--success); }
.about-server .status-dot.offline { background: var(--error); }
.about-server .server-text { font-family: var(--font-mono); font-size: 12px; color: var(--fg-tertiary); }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); }
}
</style>
