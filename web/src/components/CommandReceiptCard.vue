<template>
  <div :class="['receipt-card', `receipt-${status}`]">
    <svg class="receipt-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <component :is="iconPath" />
    </svg>
    <span class="receipt-cmd">{{ command }}</span>
    <span v-if="message" class="receipt-msg">{{ message }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'

const props = defineProps<{
  command: string
  status: 'success' | 'failed' | 'unavailable'
  message?: string
}>()

// Icon paths per status. success uses an info-style circle-check (neutral,
// not the loud green ✓), failed uses x-circle, unavailable uses minus-circle.
const iconPath = computed(() => {
  switch (props.status) {
    case 'success':
      // check-circle — neutral "done"
      return () => [
        h('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
        h('path', { d: 'M22 4L12 14.01l-3-3' }),
      ]
    case 'failed':
      // x-circle — error
      return () => [
        h('circle', { cx: '12', cy: '12', r: '10' }),
        h('path', { d: 'M15 9l-6 6' }),
        h('path', { d: 'M9 9l6 6' }),
      ]
    case 'unavailable':
      // minus-circle — not available
      return () => [
        h('circle', { cx: '12', cy: '12', r: '10' }),
        h('path', { d: 'M8 12h8' }),
      ]
    default:
      return () => [h('circle', { cx: '12', cy: '12', r: '10' })]
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

/* success: neutral info tone (accent blue) — "command completed, here's the
   result". Not a loud green ✓ that implies celebration. */
.receipt-card.receipt-success { border-left-color: var(--accent); }
.receipt-card.receipt-success .receipt-icon { color: var(--accent); }

/* failed: error tone (red) — only for genuine failures. */
.receipt-card.receipt-failed { border-left-color: var(--error); }
.receipt-card.receipt-failed .receipt-icon { color: var(--error); }

/* unavailable: muted tone (grey) — command not supported. */
.receipt-card.receipt-unavailable { border-left-color: var(--fg-tertiary); }
.receipt-card.receipt-unavailable .receipt-icon { color: var(--fg-tertiary); }

.receipt-icon { flex-shrink: 0; }

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
