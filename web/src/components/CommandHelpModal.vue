<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>可用命令</h3>
        <button class="close-btn" @click="$emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div v-for="c in commands" :key="c.name" :class="['cmd-row', `is-${c.kind}`]">
          <span class="cmd-icon" v-html="commandIcon(c)"></span>
          <span class="cmd-name">/{{ c.name }}</span>
          <span class="cmd-arg" v-if="c.arg_hint">{{ c.arg_hint }}</span>
          <span class="cmd-desc" v-if="c.description">{{ c.description }}</span>
          <span class="cmd-source" v-if="c.source === 'plugin'">{{ c.namespace }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommandItem } from '../composables/useWebSocket'

defineProps<{
  commands: CommandItem[]
}>()

defineEmits<{ close: [] }>()

// SVG icons (lucide, stroke-width 2, 14×14) — same set as CommandPopover.
const ICONS: Record<string, string> = {
  terminal: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  sparkles: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  folder:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  user:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  package:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
}

function commandIcon(c: CommandItem): string {
  if (c.kind === 'command') return ICONS.terminal
  switch (c.source) {
    case 'builtin': return ICONS.sparkles
    case 'project': return ICONS.folder
    case 'user':    return ICONS.user
    case 'plugin':  return ICONS.package
    default:        return ICONS.sparkles
  }
}
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; animation: fade-in 0.15s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; width: 600px; max-width: 90vw; max-height: 80vh; overflow-y: auto; animation: slide-up 0.2s ease; }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.modal-header h3 { font-size: 18px; font-weight: 700; color: var(--fg); margin: 0; }
.close-btn { background: none; border: none; color: var(--fg-tertiary); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; transition: color 0.15s; }
.close-btn:hover { color: var(--fg); }

.modal-body { display: flex; flex-direction: column; gap: 2px; }
.cmd-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: var(--radius-md); }
.cmd-row:hover { background: var(--surface-hover); }
.cmd-icon { flex-shrink: 0; color: var(--fg-tertiary); display: flex; }
.cmd-name { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--accent); flex-shrink: 0; }
.cmd-arg { font-family: var(--font-mono); font-size: 11px; color: var(--fg-tertiary); flex-shrink: 0; }
.cmd-desc { font-size: 12.5px; color: var(--fg-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.cmd-source { font-size: 10px; color: var(--fg-tertiary); background: var(--bg); padding: 1px 6px; border-radius: var(--radius-full); flex-shrink: 0; }

@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes slide-up { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .modal { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); max-height: 90vh; }
}
</style>
