<template>
  <div class="cmd-popover" v-if="commands.length">
    <div
      v-for="(c, i) in commands"
      :key="c.name"
      :class="['cmd-item', { active: i === activeIndex }]"
      @click="$emit('select', c)"
      @mouseenter="$emit('hover', i)"
    >
      <span class="cmd-icon">{{ c.kind === 'skill' ? '📘' : '🔧' }}</span>
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
