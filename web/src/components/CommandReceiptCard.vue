<template>
  <div :class="['receipt-card', `receipt-${status}`]">
    <span class="receipt-icon">{{ icon }}</span>
    <span class="receipt-cmd">{{ command }}</span>
    <span v-if="message" class="receipt-msg">{{ message }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  command: string
  status: 'success' | 'failed' | 'unavailable'
  message?: string
}>()

const icon = computed(() => {
  switch (props.status) {
    case 'success': return '✓'
    case 'failed': return '✗'
    case 'unavailable': return '⊘'
    default: return '·'
  }
})
</script>

<style scoped>
.receipt-card {
  align-self: flex-start;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--fg-tertiary);
  border-radius: var(--radius-lg);
  padding: 10px 14px;
  max-width: 85%;
  animation: fade-in 0.2s ease;
  font-size: 13px;
}
.receipt-card.receipt-success { border-left-color: var(--success); }
.receipt-card.receipt-failed { border-left-color: var(--error); }
.receipt-card.receipt-unavailable { border-left-color: var(--fg-tertiary); }

.receipt-icon { flex-shrink: 0; font-weight: 700; font-size: 14px; }
.receipt-success .receipt-icon { color: var(--success); }
.receipt-failed .receipt-icon { color: var(--error); }
.receipt-unavailable .receipt-icon { color: var(--fg-tertiary); }

.receipt-cmd {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--accent);
  flex-shrink: 0;
}
.receipt-msg {
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>
