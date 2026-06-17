<template>
  <div class="cmd-popover" v-if="commands.length">
    <div
      v-for="(c, i) in commands"
      :key="c.name"
      :class="['cmd-item', { active: i === activeIndex, 'is-command': c.kind === 'command' }]"
      :title="c.kind === 'command' ? 'web 不支持，在终端使用' : undefined"
      @click="$emit('select', c)"
      @mouseenter="$emit('hover', i)"
    >
      <span class="cmd-icon" v-html="commandIcon(c)"></span>
      <span class="cmd-name">/{{ c.name }}</span>
      <span class="cmd-arg" v-if="c.arg_hint">{{ c.arg_hint }}</span>
      <span class="cmd-desc" v-if="c.description">{{ c.description }}</span>
      <span class="cmd-source" v-if="c.source === 'plugin'">{{ c.namespace }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommandItem } from '../composables/useWebSocket'

defineProps<{
  commands: CommandItem[]
  activeIndex: number
}>()

defineEmits<{
  (e: 'select', item: CommandItem): void
  (e: 'hover', index: number): void
}>()

// SVG icon paths (lucide/feather, stroke-width 2, 14×14) — slash-command-icons design
const ICONS: Record<string, string> = {
  terminal:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  sparkles:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  folder:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  user:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  package:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
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
.cmd-popover {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, 0 4px 16px rgba(0, 0, 0, 0.12));
  max-height: 240px;
  overflow-y: auto;
  z-index: 20;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.cmd-item:hover,
.cmd-item.active {
  background: var(--surface-hover);
}
.cmd-item.is-command {
  opacity: 0.4;
}
.cmd-item.is-command:hover {
  opacity: 0.7;
}
.cmd-icon {
  flex-shrink: 0;
  font-size: 14px;
}
.cmd-name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.cmd-arg {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-tertiary);
  flex-shrink: 0;
}
.cmd-desc {
  font-size: 12px;
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.cmd-source {
  font-size: 10px;
  color: var(--fg-tertiary);
  background: var(--bg);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}
</style>
