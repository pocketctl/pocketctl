<template>
  <footer class="reply-footer" :data-reply-status="status">
    <span class="reply-state" role="status"><i :class="status" />{{ label }}<span v-if="duration" class="status-timer"> · {{ duration }}</span><span v-if="usage"> · {{ usage }}</span></span>
    <div class="reply-actions">
      <button v-if="content" type="button" @click="copy" :aria-label="t(status === 'completed' ? 'session.reply_copy' : 'session.reply_copy_partial')">{{ copied ? t('common.copied') : t(status === 'completed' ? 'session.reply_copy' : 'session.reply_copy_partial') }}</button>
      <button v-if="canRetry" type="button" @click="$emit('retry')">{{ t('common.retry') }}</button>
    </div>
    <span v-if="endedAt" class="status-ended-at">{{ endedAt }}</span>
  </footer>
</template>
<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { useLocale } from '../../composables/useLocale'
const props = defineProps<{status: string; content: string; duration?: string; endedAt?: string; usage?: string; canRetry?: boolean}>()
defineEmits<{retry: []}>()
const { t } = useLocale()
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
const label = computed(() => t(({completed:'session.completed',streaming:'session.reply_streaming',waiting:'session.reply_waiting',interrupted:'workspace.interrupted',failed:'session.execution_failed',abandoned:'workspace.abandoned'} as Record<string,string>)[props.status] || 'session.reply_recorded'))
async function copy() {
  try { await navigator.clipboard.writeText(props.content); copied.value = true; clearTimeout(timer); timer = setTimeout(() => copied.value = false, 2000) } catch { copied.value = false }
}
onBeforeUnmount(() => clearTimeout(timer))
</script>
<style scoped>
.reply-footer{display:flex;align-items:center;flex-wrap:wrap;gap:6px 16px;margin-top:22px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-secondary)}
.reply-state{display:flex;align-items:center;gap:7px;min-height:36px}.reply-state i{width:6px;height:6px;border-radius:50%;background:var(--fg-tertiary)}.reply-state i.completed{background:var(--success,var(--accent))}.reply-state i.streaming{background:var(--accent)}.reply-state i.failed,.reply-state i.interrupted,.reply-state i.waiting{background:var(--warning,var(--accent))}
.status-ended-at{flex-basis:100%;font-size:11px;color:var(--fg-tertiary)}.reply-actions{display:flex;gap:8px;margin-left:auto}.reply-actions button{font:inherit;color:var(--fg-secondary);background:none;border:0;border-radius:6px;min-height:36px;padding:8px;cursor:pointer}.reply-actions button:hover{background:var(--surface-hover);color:var(--accent)}.reply-actions button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:760px){.reply-actions button{min-height:44px}}
</style>
