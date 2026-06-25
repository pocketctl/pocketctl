<template>
  <!--
    Tool-use approval card — rendered inline in the chat stream when the daemon
    surfaces a PreToolUse approval request (non-bypass sessions). Shows the tool
    and its arguments, with Allow / Deny buttons. After the user answers the
    buttons disable and a result chip replaces them.
  -->
  <div class="approval-card-wrap">
    <div class="approval-card" :class="resultClass">
      <!-- Header -->
      <div class="approval-header">
        <span class="approval-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </span>
        <span class="approval-tag">{{ t('approval.title') }}</span>
        <span v-if="isPending" class="approval-waiting">{{ t('approval.waiting') }}</span>
      </div>

      <!-- Tool + args -->
      <div class="approval-body">
        <span class="approval-tool">{{ message.tool || 'Tool' }}</span>
        <span v-if="message.inputDesc" class="approval-args">{{ message.inputDesc }}</span>
      </div>

      <!-- Actions / result -->
      <div class="approval-actions">
        <template v-if="isPending">
          <button class="approval-btn allow" @click.stop="respond(true)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            {{ t('approval.allow') }}
          </button>
          <button class="approval-btn deny" @click.stop="respond(false)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            {{ t('approval.deny') }}
          </button>
        </template>
        <span v-else :class="['approval-result', message.status]">
          {{ message.status === 'allowed' ? t('approval.allowed') : t('approval.denied') }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'

const { t } = useLocale()
const props = defineProps<{ message: any }>()
const emit = defineEmits<{ (e: 'respond', message: any, approved: boolean): void }>()

const isPending = computed(() => props.message.status === 'pending')
const resultClass = computed(() => `result-${props.message.status}`)

function respond(approved: boolean) {
  // Optimistically flip the card so the UI feels instant; the daemon's
  // session_status running event (sent on resolution) reconciles state.
  props.message.status = approved ? 'allowed' : 'denied'
  emit('respond', props.message, approved)
}
</script>

<style scoped>
.approval-card-wrap { width: 100%; animation: fade-in 0.2s ease; }

.approval-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning, #F59E0B);
  border-radius: var(--radius-lg);
}
.approval-card.result-allowed { border-left-color: var(--success, #10B981); }
.approval-card.result-denied { border-left-color: var(--error, #EF4444); }

.approval-header { display: flex; align-items: center; gap: 6px; }
.approval-icon { color: var(--warning, #F59E0B); display: flex; }
.approval-tag {
  font-size: 11px; font-weight: 700; color: var(--warning, #F59E0B);
  text-transform: uppercase; letter-spacing: 0.6px;
}
.approval-waiting {
  margin-left: auto; font-size: 11px; color: var(--fg-tertiary);
  display: flex; align-items: center; gap: 5px;
}
.approval-waiting::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warning, #F59E0B); animation: pulse 1.2s ease-in-out infinite;
}

.approval-body {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 13px;
}
.approval-tool {
  font-family: var(--font-mono); font-weight: 600; color: var(--accent);
  background: var(--accent-muted); padding: 2px 8px; border-radius: var(--radius-sm);
}
.approval-args {
  font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary);
  white-space: pre-wrap; word-break: break-all; max-width: 100%;
}

.approval-actions { display: flex; align-items: center; gap: 8px; }
.approval-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 14px; border-radius: var(--radius-md);
  font-size: 13px; font-weight: 600; cursor: pointer;
  border: 1px solid transparent; transition: all 0.15s;
}
.approval-btn.allow { background: var(--success, #10B981); color: #fff; }
.approval-btn.allow:hover { filter: brightness(1.08); }
.approval-btn.deny { background: var(--surface-active); color: var(--fg-secondary); border-color: var(--border); }
.approval-btn.deny:hover { color: var(--error, #EF4444); border-color: var(--error, #EF4444); }

.approval-result {
  font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: var(--radius-full);
}
.approval-result.allowed { color: var(--success, #10B981); background: var(--success-muted, rgba(16,185,129,0.12)); }
.approval-result.denied { color: var(--error, #EF4444); background: var(--error-muted, rgba(239,68,68,0.12)); }

@keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
