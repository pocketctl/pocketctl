<template>
  <section class="notification-detail queue-detail" data-testid="notification-detail">
    <button v-if="mobile" class="btn btn-secondary" type="button" @click="$emit('close')">← {{ t('attention.queue') }}</button>
    <small class="detail-tag">{{ t('attention.notification.system') }} · {{ t('attention.notification.no_action') }}</small>
    <h2>{{ t('attention.notification.title') }}</h2>
    <p>{{ t('attention.notification.subject_count', { count: count }) }} · {{ new Date(item.created_at).toLocaleString() }}</p>
    <div v-if="error" class="detail-error" role="alert"><p>{{ t(error) }}</p><button type="button" class="btn btn-secondary" @click="load(false)">{{ t('common.retry') }}</button></div>
    <template v-else>
      <p v-if="loading" role="status">{{ t('common.loading') }}</p>
      <ul class="subject-list">
        <li v-for="subject in subjects" :key="subject.subject_id">
          <button type="button" :disabled="loading" @click="open(subject)">
            <span><strong>{{ subject.title }}</strong><small>{{ subject.daemon_name }}</small>
              <small>{{ t('attention.notification.last_activity') }} · {{ formatDate(subject.last_activity_at) }}</small>
              <small>{{ t('attention.notification.reason') }} · {{ reasonLabel(subject) }}</small>
              <small>{{ t('attention.notification.processing') }} · {{ t(`attention.notification.processing.${subject.action}`) }}</small>
              <small v-if="subject.action !== 'purge' && subject.effective_purge_at">{{ t('attention.notification.effective_purge') }} · {{ formatDate(subject.effective_purge_at) }}</small></span>
            <span><b>{{ t(`attention.notification.action.${subject.action}`) }}</b><small>{{ t(`attention.notification.result.${subject.result}`) }}</small>
              <small v-for="(state,stage) in subject.stages" :key="stage">{{ t(`attention.notification.stage.${stage}`) }} · {{ t(`attention.notification.stage_state.${state}`) }}</small></span><span aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
      <button v-if="cursor" type="button" class="btn btn-secondary" data-testid="notification-subject-more" :disabled="loading" @click="load(true)">{{ t('attention.load_more') }}</button>
      <div v-if="selectedSummary" class="operation-summary" data-testid="notification-operation-summary">
        <h3>{{ selectedSummary.title }}</h3>
        <p>{{ t(selectedSummary.action === 'purge' && (selectedSummary.result === 'succeeded' || selectedSummary.stages?.database === 'succeeded') ? 'attention.notification.deleted' : 'attention.notification.operation_detail') }}</p>
        <dl><dt>{{ t('attention.notification.host') }}</dt><dd>{{ selectedSummary.daemon_name }}</dd>
          <dt>{{ t('attention.notification.last_activity') }}</dt><dd>{{ formatDate(selectedSummary.last_activity_at) }}</dd>
          <dt>{{ t('attention.notification.executed') }}</dt><dd>{{ formatDate(selectedSummary.executed_at) }}</dd>
          <dt>{{ t('attention.notification.reason') }}</dt><dd>{{ reasonLabel(selectedSummary) }}</dd>
          <dt>{{ t('attention.notification.processing') }}</dt><dd>{{ t(`attention.notification.processing.${selectedSummary.action}`) }}</dd>
          <dt>{{ t('attention.notification.result') }}</dt><dd>{{ t(`attention.notification.result.${selectedSummary.result}`) }}</dd>
          <template v-for="(state,stage) in selectedSummary.stages" :key="stage"><dt>{{ t(`attention.notification.stage.${stage}`) }}</dt><dd>{{ t(`attention.notification.stage_state.${state}`) }}</dd></template></dl>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { AttentionInboxApiError, getNotificationSubject, listNotificationSubjects } from '../../services/attentionInboxClient'
import type { AttentionInboxScope, LifecycleNotificationSubject, SystemNotification } from '../../types/attentionInbox'
const props = defineProps<{ item: SystemNotification; scope: AttentionInboxScope; mobile: boolean }>()
defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale(), router = useRouter()
const subjects = ref<LifecycleNotificationSubject[]>([]), count = ref(0), cursor = ref<string | null>(null)
const loading = ref(false), error = ref(''), selectedSummary = ref<LifecycleNotificationSubject | null>(null)
let generation = 0
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString() : '—' }
function reasonLabel(subject: LifecycleNotificationSubject) {
  if (subject.reason_code.startsWith('test_fixture')) return t('attention.notification.reason.fixture')
  switch (subject.reason_code) {
    case 'inactivity_60_days': case 'transfer_budget_reached': case 'cold_transfer_failed':
      return t('attention.notification.reason.archive')
    case 'inactivity_90_days': case 'external_cleanup_pending': case 'cloud_cleanup_completed': case 'database_purge_failed':
      return t('attention.notification.reason.purge')
    case 'business_activity': return t('attention.notification.reason.resumed')
    case 'user_requested_zombie_cleanup': return t('attention.notification.reason.zombie')
    case 'superseded': return t('attention.notification.reason.superseded')
    default: return t('attention.notification.reason.unknown')
  }
}
function fail(failure: unknown) {
  subjects.value = []; selectedSummary.value = null; cursor.value = null; count.value = 0
  error.value = failure instanceof AttentionInboxApiError && [401, 403, 404].includes(failure.status)
    ? 'attention.notification.unavailable' : 'attention.notification.load_failed'
}
async function load(append: boolean) {
  const run = generation
  if (append && (!cursor.value || loading.value)) return
  loading.value = true; error.value = ''
  try {
    const page = await listNotificationSubjects(props.item.notification_id, props.scope, append ? cursor.value : null)
    if (run !== generation) return
    const merged = new Map((append ? subjects.value : []).map(subject => [subject.subject_id, subject]))
    for (const subject of page.subjects) merged.set(subject.subject_id, subject)
    subjects.value = [...merged.values()]; cursor.value = page.next_cursor; count.value = page.subject_count
  } catch (failure) { if (run === generation) fail(failure) }
  finally { if (run === generation) loading.value = false }
}
async function open(subject: LifecycleNotificationSubject) {
  const run = generation; loading.value = true
  try {
    // Re-resolve navigation with current authorization and deletion status, never trust stale previews.
    const response = await getNotificationSubject(props.item.notification_id, subject.subject_id, props.scope)
    if (run !== generation) return
    if (response.subject.navigation.type === 'session') await router.push(`/session/${encodeURIComponent(response.subject.navigation.id)}`)
    else selectedSummary.value = response.subject
  } catch (failure) { if (run === generation) fail(failure) }
  finally { if (run === generation) loading.value = false }
}
watch(() => [props.item.notification_id, props.item.revision, JSON.stringify(props.scope)], () => {
  generation++; subjects.value = []; selectedSummary.value = null; cursor.value = null; void load(false)
}, { immediate: true })
onBeforeUnmount(() => { generation++; subjects.value = []; selectedSummary.value = null })
</script>
<style scoped>
.notification-detail { padding: clamp(20px, 4vw, 42px); min-width: 0; }.detail-tag { display: block; color: var(--accent); font-size: 11px; margin-top: 18px; }.notification-detail h2 { font-size: 23px; }.notification-detail p { color: var(--fg-secondary); font-size: 12px; line-height: 1.7; }
.subject-list { list-style: none; padding: 0; margin: 24px 0; }.subject-list li { border-bottom: 1px solid var(--border); }.subject-list button { display: flex; gap: 12px; align-items: center; text-align: left; width: 100%; padding: 16px 0; border: 0; background: transparent; color: var(--fg); cursor: pointer; }.subject-list button > span:first-child { flex: 1; min-width: 0; }.subject-list strong { display: block; overflow-wrap: anywhere; font-size: 13px; }.subject-list small { display: block; margin-top: 6px; font-size: 11px; color: var(--fg-tertiary); }.subject-list b { font-size: 11px; font-weight: 500; }
.operation-summary { padding: 18px; background: var(--surface-hover); border: 1px solid var(--border); border-radius: var(--radius-md); }.operation-summary dl { display: grid; grid-template-columns: auto 1fr; gap: 10px; font-size: 12px; }.operation-summary dt { color: var(--fg-tertiary); }.operation-summary dd { margin: 0; overflow-wrap: anywhere; }.detail-error { color: var(--error); }
</style>
