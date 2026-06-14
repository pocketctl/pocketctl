<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>帮助与反馈</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="section">
          <h4>安装 Daemon</h4>
          <p>在你的 Mac 或 Linux 开发机上运行以下命令，安装并启动 Daemon 守护进程：</p>
          <div class="code-block">
            <code># 1. 安装 Daemon</code>
            <code>curl -fsSL {{ installURL }} -o /tmp/install-daemon.sh</code>
            <code>sudo bash /tmp/install-daemon.sh</code>
            <code></code>
            <code># 登录（使用 App 注册的手机号）</code>
            <code>pocketctl login</code>
            <code></code>
            <code># 启动守护进程</code>
            <code>pocketctl daemon start</code>
            <code></code>
            <code># 查看状态</code>
            <code>pocketctl daemon status</code>
          </div>
          <button class="btn btn-copy" @click="copyCommands">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            {{ copied ? '已复制' : '复制命令' }}
          </button>
        </div>

        <div class="divider"></div>

        <div class="section">
          <h4>意见反馈</h4>
          <p>遇到问题或有建议？欢迎通过邮件联系我们：</p>
          <a href="mailto:james_2001_2001@163.com?subject=pocketctl%20反馈" class="email-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 4L12 13 2 4"/></svg>
            james_2001_2001@163.com
          </a>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

defineEmits<{ close: [] }>()

const copied = ref(false)

const relayWs = computed(() => {
  return localStorage.getItem('pocketctl_relay_url') || (window as any).__RELAY_WS__ || 'ws://localhost/ws'
})

const installURL = computed(() => {
  try {
    const u = new URL(relayWs.value)
    return u.origin.replace(/^ws/, 'http') + '/install-daemon.sh'
  } catch {
    return 'https://pocketctl.me/install-daemon.sh'
  }
})

const fullCommands = computed(() => {
  return `curl -fsSL ${installURL.value} -o /tmp/install-daemon.sh
sudo bash /tmp/install-daemon.sh
pocketctl login
pocketctl daemon start`
})

async function copyCommands() {
  try {
    await navigator.clipboard.writeText(fullCommands.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
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
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade-in 0.15s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; width: 560px; max-width: 90vw; max-height: 80vh; overflow-y: auto; animation: slide-up 0.2s ease; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.modal-header h3 { font-size: 18px; font-weight: 700; color: var(--fg); margin: 0; }
.close-btn { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; transition: color 0.15s; }
.close-btn:hover { color: var(--fg); }

.modal-body { font-size: 14px; color: var(--fg-secondary); }
.section h4 { font-size: 16px; font-weight: 600; color: var(--fg); margin: 0 0 8px; }
.section p { margin: 0 0 12px; line-height: 1.6; }

.code-block { background: var(--code-bg, var(--bg)); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.code-block code { display: block; font-family: var(--font-mono); font-size: 12px; color: var(--success); line-height: 1.8; }

.btn-copy { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--accent); font-size: 14px; cursor: pointer; transition: all 0.15s; }
.btn-copy:hover { background: var(--accent-muted); border-color: var(--accent); }

.divider { height: 1px; background: var(--border); margin: 20px 0; }

.email-link { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); text-decoration: none; font-size: 15px; }
.email-link:hover { text-decoration: underline; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); max-height: 90vh; }
}
</style>
