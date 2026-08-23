<template>
  <section class="install-guide" data-state="daemon-install-guide">
    <div class="install-visual" aria-hidden="true">
      <span class="signal-ring ring-one"></span>
      <span class="signal-ring ring-two"></span>
      <div class="terminal-mark">
        <svg viewBox="0 0 24 24">
          <path d="m5 7 5 5-5 5M12 17h7" />
        </svg>
      </div>
      <span class="install-status-dot"></span>
    </div>

    <div class="install-heading">
      <span class="install-kicker">REMOTE RUNTIME</span>
      <h2>连接你的开发主机</h2>
      <p>暂未查询到会话记录。在 Mac 或 Linux 主机完成下面两步，之后终端和 Web 创建的会话都会出现在这里。</p>
    </div>

    <div class="install-steps">
      <div class="install-step">
        <span class="step-index">01</span>
        <div class="step-copy">
          <strong>安装 Daemon</strong>
          <small>下载 pocketctl 并注册后台服务</small>
        </div>
        <code>{{ installCommand }}</code>
      </div>
      <div class="step-connector" aria-hidden="true"><span></span></div>
      <div class="install-step">
        <span class="step-index">02</span>
        <div class="step-copy">
          <strong>启动服务</strong>
          <small>建立主机与控制台的安全连接</small>
        </div>
        <code>pocketctl daemon start</code>
      </div>
    </div>

    <div class="install-actions">
      <button class="copy-setup" type="button" data-action="copy-setup" @click="copySetup">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
        {{ copied ? '已复制' : '复制完整命令' }}
      </button>
      <button class="create-web-session" type="button" @click="$emit('create')">
        创建 Web 会话
        <span aria-hidden="true">→</span>
      </button>
    </div>

    <p class="install-footnote">
      <span></span>
      Daemon 连接后，会话列表将自动刷新
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  installCommand: string
}>()

defineEmits<{
  create: []
}>()

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copySetup() {
  const commands = `${props.installCommand}\npocketctl daemon start`
  try {
    await navigator.clipboard.writeText(commands)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    copied.value = false
  }
}
</script>

<style scoped>
.install-guide {
  position: relative;
  max-width: 620px;
  margin: 30px auto;
  overflow: hidden;
  padding: 34px;
  border: 1px solid var(--border, #21262d);
  border-radius: 18px;
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--accent, #58a6ff) 7%, transparent), transparent 42%),
    var(--surface, #161b22);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .18);
}
.install-guide::before {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
  background-size: 24px 24px;
  content: "";
  mask-image: linear-gradient(to bottom, black, transparent 55%);
}
.install-visual { position: relative; width: 66px; height: 66px; margin-bottom: 22px; }
.terminal-mark {
  position: absolute;
  inset: 7px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent, #58a6ff) 35%, var(--border, #30363d));
  border-radius: 15px;
  background: var(--bg, #0d1117);
  color: var(--accent, #58a6ff);
  box-shadow: inset 0 0 18px color-mix(in srgb, var(--accent, #58a6ff) 9%, transparent);
}
.terminal-mark svg { width: 28px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
.signal-ring { position: absolute; border: 1px solid color-mix(in srgb, var(--accent, #58a6ff) 26%, transparent); border-radius: 18px; }
.ring-one { inset: 2px; }
.ring-two { inset: -5px; opacity: .45; }
.install-status-dot { position: absolute; right: 3px; bottom: 4px; width: 11px; height: 11px; border: 2px solid var(--surface, #161b22); border-radius: 50%; background: var(--warning, #d29922); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning, #d29922) 15%, transparent); }
.install-heading { position: relative; }
.install-kicker { color: var(--accent, #58a6ff); font: 650 10px/1 var(--font-mono, ui-monospace, monospace); letter-spacing: .17em; }
.install-heading h2 { margin: 9px 0 8px; color: var(--fg, #e6edf3); font-size: 24px; font-weight: 700; letter-spacing: -.025em; }
.install-heading p { max-width: 520px; margin: 0; color: var(--fg-secondary, #c9d1d9); font-size: 13px; line-height: 1.65; }
.install-steps { position: relative; display: grid; gap: 0; margin-top: 26px; }
.install-step {
  display: grid;
  grid-template-columns: 38px minmax(120px, .65fr) minmax(220px, 1.35fr);
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--border, #30363d);
  border-radius: 11px;
  background: color-mix(in srgb, var(--bg, #0d1117) 84%, transparent);
}
.step-index { color: var(--accent, #58a6ff); font: 650 11px var(--font-mono, ui-monospace, monospace); }
.step-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.step-copy strong { color: var(--fg, #e6edf3); font-size: 13px; }
.step-copy small { color: var(--fg-tertiary, #8b949e); font-size: 10px; }
.install-step code { overflow: hidden; color: var(--success, #3fb950); font: 11px/1.45 var(--font-mono, ui-monospace, monospace); text-overflow: ellipsis; white-space: nowrap; }
.step-connector { height: 10px; padding-left: 32px; }
.step-connector span { display: block; width: 1px; height: 100%; background: var(--border-light, #30363d); }
.install-actions { position: relative; display: flex; gap: 10px; margin-top: 22px; }
.install-actions button { display: inline-flex; min-height: 42px; align-items: center; justify-content: center; gap: 8px; padding: 9px 15px; border-radius: 9px; font-size: 12px; font-weight: 650; cursor: pointer; }
.copy-setup { border: 1px solid var(--border-light, #30363d); background: var(--surface-raised, #21262d); color: var(--fg-secondary, #c9d1d9); }
.copy-setup svg { width: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.create-web-session { border: 1px solid var(--accent, #58a6ff); background: var(--accent, #238636); color: white; }
.create-web-session span { font-size: 16px; transition: transform .15s; }
.create-web-session:hover span { transform: translateX(2px); }
.install-footnote { position: relative; display: flex; align-items: center; gap: 7px; margin: 18px 0 0; color: var(--fg-tertiary, #8b949e); font-size: 10px; }
.install-footnote span { width: 6px; height: 6px; border-radius: 50%; background: var(--warning, #d29922); }
@media (max-width: 768px) {
  .install-guide { margin: 12px 0 24px; padding: 24px 18px; border-radius: 15px; }
  .install-visual { width: 58px; height: 58px; margin-bottom: 18px; }
  .install-heading h2 { font-size: 21px; }
  .install-step { grid-template-columns: 32px minmax(0, 1fr); padding: 13px 12px; }
  .install-step code { grid-column: 2; padding-top: 5px; white-space: normal; word-break: break-all; }
  .step-connector { padding-left: 27px; }
  .install-actions { flex-direction: column; }
  .install-actions button { width: 100%; min-height: 46px; }
}
@media (prefers-reduced-motion: reduce) {
  .create-web-session span { transition: none; }
}
</style>
