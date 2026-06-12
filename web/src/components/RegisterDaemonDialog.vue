<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h3>注册主机</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <p class="dialog-subtitle">在你的开发机上运行以下命令安装 Daemon</p>

      <div class="steps">
        <div class="step">
          <div class="step-number">1</div>
          <div class="step-content">
            <div class="step-label">安装 Daemon</div>
            <div class="code-block">
              <code>curl -fsSL {{ installURL }} -o /tmp/install-daemon.sh</code>
              <code>sudo bash /tmp/install-daemon.sh</code>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <div class="step-content">
            <div class="step-label">登录账号</div>
            <div class="code-block">
              <code>pocketctl login</code>
            </div>
          </div>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <div class="step-content">
            <div class="step-label">启动 Daemon</div>
            <div class="code-block">
              <code>pocketctl daemon start --relay {{ relayWs }}</code>
            </div>
          </div>
        </div>
      </div>

      <div class="dialog-actions">
        <button class="btn btn-copy" @click="copyCommands">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          {{ copied ? '已复制' : '复制命令' }}
        </button>
        <button class="btn btn-close" @click="$emit('close')">完成</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

defineEmits<{ close: [] }>()

const copied = ref(false)

const relayWs = computed(() => {
  return localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || 'ws://localhost:8080/ws'
})

const installURL = computed(() => {
  try {
    const u = new URL(relayWs.value)
    return u.origin.replace(/^ws/, 'http') + '/install-daemon.sh'
  } catch {
    return 'https://pocketctl.com/install-daemon.sh'
  }
})

const fullCommands = computed(() => {
  return `curl -fsSL ${installURL.value} -o /tmp/install-daemon.sh
sudo bash /tmp/install-daemon.sh
pocketctl login
pocketctl daemon start --relay ${relayWs.value}`
})

async function copyCommands() {
  try {
    await navigator.clipboard.writeText(fullCommands.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // Fallback
    const ta = document.createElement('textarea')
    ta.value = fullCommands.value
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fade-in 0.15s ease;
}

.dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 520px;
  max-width: 90vw;
  animation: slide-up 0.2s ease;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.dialog-header h3 {
  font-size: 18px;
  font-weight: 700;
  color: var(--fg);
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: var(--fg-tertiary);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  display: flex;
  transition: color 0.15s, background 0.15s;
}
.close-btn:hover {
  color: var(--fg);
  background: var(--surface-hover);
}

.dialog-subtitle {
  font-size: 14px;
  color: var(--fg-secondary);
  margin: 0 0 24px 0;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}

.step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.step-number {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--accent-muted);
  color: var(--accent);
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.step-content {
  flex: 1;
  min-width: 0;
}

.step-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 6px;
}

.code-block {
  background: var(--code-bg, var(--bg));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.code-block code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--success);
  word-break: break-all;
  line-height: 1.6;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn {
  padding: 10px 18px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s;
}

.btn-copy {
  background: var(--surface);
  color: var(--accent);
}
.btn-copy:hover {
  background: var(--accent-muted);
  border-color: var(--accent);
}

.btn-close {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.btn-close:hover {
  opacity: 0.9;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-up {
  from { transform: translateY(12px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

/* Mobile: fullscreen */
@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .dialog {
    width: 100%;
    max-width: 100%;
    border-radius: 16px 16px 0 0;
    padding: 20px 16px;
    padding-bottom: max(20px, env(safe-area-inset-bottom));
  }
  .btn { min-height: 44px; }
}
</style>
