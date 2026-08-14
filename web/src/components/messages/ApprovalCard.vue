<template>
  <div class="approval-card-wrap">
    <div class="approval-card" :class="resultClass">
      <div class="approval-header">
        <span class="approval-icon" aria-hidden="true">⚠</span>
        <span class="approval-tag">{{ t('approval.title') }}</span>
        <span v-if="isPending" class="approval-waiting">{{ message.submitting ? t('approval.submitting') : t('approval.waiting') }}</span>
      </div>

      <div class="approval-body">
        <span class="approval-tool">{{ message.permissionName || message.tool || 'Tool' }}</span>
        <span v-if="message.inputDesc" class="approval-args">{{ message.inputDesc }}</span>
      </div>

      <div v-if="supportsActions && hasDetails" class="approval-details">
        <div v-if="message.patterns?.length" class="detail-row">
          <span>{{ t('approval.patterns') }}</span>
          <code v-for="pattern in message.patterns" :key="pattern">{{ pattern }}</code>
        </div>
        <div v-if="message.always?.length" class="detail-row">
          <span>{{ t('approval.save_rules') }}</span>
          <code v-for="rule in message.always" :key="rule">{{ rule }}</code>
        </div>
        <details v-if="metadataText" class="approval-metadata">
          <summary>{{ t('approval.metadata') }}</summary>
          <pre>{{ metadataText }}</pre>
        </details>
      </div>

      <div v-if="message.error" class="approval-error">{{ message.error }}</div>
      <div v-if="isPending && disabledReason" class="interaction-readiness" role="status">
        <span>{{ disabledReason }}</span>
        <button v-if="message.resultUnknown" type="button" @click.stop="$emit('resync')">{{ t('interaction.resync') }}</button>
      </div>
      <div class="approval-actions">
        <template v-if="isPending">
          <button v-if="allowedActions.includes('once')" class="approval-btn once" :disabled="actionsDisabled" @click.stop="respond('once')">{{ supportsActions || hasExplicitDecisions ? t('approval.once') : t('approval.allow') }}</button>
          <button v-if="allowedActions.includes('always')" class="approval-btn always" :disabled="actionsDisabled || (supportsActions && !hasExplicitDecisions && !message.always?.length)" @click.stop="respond('always')">{{ t('approval.always') }}</button>
          <button v-if="allowedActions.includes('reject')" class="approval-btn reject" :disabled="actionsDisabled" @click.stop="respond('reject')">{{ t('approval.deny') }}</button>
          <button v-if="allowedActions.includes('cancel')" class="approval-btn cancel" :disabled="actionsDisabled" @click.stop="respond('cancel')">{{ t('common.cancel') }}</button>
        </template>
        <span v-else :class="['approval-result', resolvedResultClass]">{{ resolvedLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { trustedApprovalActions } from '../../utils/trustedApprovalActions'

type ApprovalAction = 'once' | 'always' | 'reject' | 'cancel'

const { t } = useLocale()
const props = withDefaults(defineProps<{ message: any; supportsActions?: boolean; trustedPolicy?: boolean; disabled?: boolean; disabledReason?: string }>(), {
  supportsActions: false,
  trustedPolicy: false,
  disabled: false,
  disabledReason: '',
})
const emit = defineEmits<{
  (event: 'respond', message: any, action: ApprovalAction): void
  (event: 'resync'): void
}>()

const isPending = computed(() => props.message.status === 'pending')
const actionsDisabled = computed(() => props.disabled || !!props.message.submitting)
const availableDecisions = computed<string[]>(() => Array.isArray(props.message.availableDecisions) ? props.message.availableDecisions : [])
const hasExplicitDecisions = computed(() => availableDecisions.value.length > 0)
const allowedActions = computed(() => trustedApprovalActions(props.message, props.supportsActions, props.trustedPolicy))
const resolvedAction = computed<ApprovalAction>(() => {
  if (props.message.action === 'always' || props.message.action === 'once' || props.message.action === 'reject' || props.message.action === 'cancel') return props.message.action
  return props.message.status === 'allowed' ? 'once' : 'reject'
})
const resultClass = computed(() => `result-${isPending.value ? 'pending' : resolvedAction.value}`)
const resolvedElsewhere = computed(() => props.message.reason === 'resolved_elsewhere')
const neutralReasons = new Set([
  'timed_out', 'daemon_restarted', 'hook_disconnected', 'session_drained', 'server_shutdown',
  'claude_result_unconfirmed', 'result_unknown', 'channel_disconnected', 'channel_write_failed',
])
const neutralResolution = computed(() => neutralReasons.has(props.message.reason))
const resolvedResultClass = computed(() => resolvedElsewhere.value || neutralResolution.value ? 'elsewhere' : resolvedAction.value)
const resolvedLabel = computed(() => {
  if (resolvedElsewhere.value) return t('approval.resolved_elsewhere')
  if (props.message.reason === 'claude_result_unconfirmed') return t('approval.submitted_unconfirmed')
  if (props.message.reason === 'result_unknown' || props.message.reason === 'channel_write_failed') return t('approval.result_unknown')
  if (neutralResolution.value) return t('approval.closed')
  if (resolvedAction.value === 'always') return t('approval.always_resolved')
  if (resolvedAction.value === 'once') return t('approval.allowed')
  return t('approval.denied')
})
const metadataText = computed(() => {
  const metadata = props.message.metadata
  if (!metadata) return ''
  try {
    const text = typeof metadata === 'string' ? metadata : JSON.stringify(metadata, null, 2)
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  } catch { return '' }
})
const hasDetails = computed(() => !!(props.message.patterns?.length || props.message.always?.length || metadataText.value))

function respond(action: ApprovalAction) {
  if (!isPending.value || actionsDisabled.value || !allowedActions.value.includes(action)) return
  emit('respond', props.message, action)
}
</script>

<style scoped>
.approval-card-wrap { width: 100%; animation: fade-in .2s ease; }
.approval-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--warning, #f59e0b); border-radius: var(--radius-lg); }
.approval-card.result-once, .approval-card.result-always { border-left-color: var(--success, #10b981); }
.approval-card.result-reject { border-left-color: var(--error, #ef4444); }
.approval-header, .approval-body, .approval-actions { display: flex; align-items: center; gap: 8px; }
.approval-icon, .approval-tag { color: var(--warning, #f59e0b); }
.approval-tag { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px; }
.approval-waiting { margin-left: auto; font-size: 11px; color: var(--fg-tertiary); }
.approval-tool { font: 600 12px var(--font-mono); color: var(--accent); background: var(--accent-muted); padding: 2px 8px; border-radius: var(--radius-sm); }
.approval-args { min-width: 0; max-width: 100%; color: var(--fg-secondary); font: 12px var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-details { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; background: var(--bg); border-radius: var(--radius-md); }
.detail-row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 5px; font-size: 11px; color: var(--fg-tertiary); }
.detail-row code { color: var(--fg-secondary); background: var(--surface); padding: 2px 5px; border-radius: 4px; overflow-wrap: anywhere; }
.approval-metadata summary { cursor: pointer; color: var(--fg-tertiary); font-size: 11px; }
.approval-metadata pre { max-height: 180px; overflow: auto; margin: 6px 0 0; color: var(--fg-secondary); font: 11px/1.45 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.approval-error { color: var(--error, #ef4444); font-size: 11px; }
.interaction-readiness { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--warning); font-size: 12px; }
.interaction-readiness button { padding: 5px 9px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-active); color: var(--fg); cursor: pointer; }
.approval-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-active); color: var(--fg-secondary); font-size: 12px; font-weight: 600; cursor: pointer; }
.approval-btn.once, .approval-btn.allow { color: #fff; border-color: var(--success, #10b981); background: var(--success, #10b981); }
.approval-btn.always { color: var(--accent); border-color: var(--accent); background: var(--accent-muted); }
.approval-btn.reject:hover:not(:disabled), .approval-btn.deny:hover:not(:disabled), .approval-btn.cancel:hover:not(:disabled) { color: var(--error, #ef4444); border-color: var(--error, #ef4444); }
.approval-btn:disabled { cursor: not-allowed; opacity: .45; }
.approval-result { padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.approval-result.once, .approval-result.always { color: var(--success, #10b981); background: rgba(16,185,129,.12); }
.approval-result.reject { color: var(--error, #ef4444); background: rgba(239,68,68,.12); }
.approval-result.elsewhere { color: var(--fg-secondary); background: var(--surface-active); }
@keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
</style>
