<template>
  <div class="attention-inbox-view" :class="{ 'is-mobile': isMobile }">
    <div v-if="!store.isAvailable.value" class="attention-disabled" data-testid="attention-disabled">
      <div class="empty-mark">P</div>
      <h1>{{ t('attention.unavailable_title') }}</h1>
      <p>{{ t('attention.unavailable_copy') }}</p>
    </div>
    <template v-else>
      <header v-if="!isMobile || !selectedEntry" class="inbox-head">
        <div>
          <p class="overline">{{ t('attention.overline') }}</p>
          <h1>{{ t('attention.title') }}</h1>
          <p>{{ scopeCopy }}</p>
        </div>
        <div class="head-count"><span>{{ t('attention.needs_attention') }}</span><strong>{{ store.attentionCount(scope) }}</strong></div>
      </header>

      <div v-if="!isMobile || !selectedEntry" class="filter-deck">
        <div class="lifecycle-tabs" role="tablist" :aria-label="t('attention.lifecycle_filters')">
          <button v-for="value in lifecycleOptions" :key="value" type="button"
            :class="{ active: lifecycle === value }" :data-testid="`attention-lifecycle-${value}`"
            @click="setLifecycle(value)">{{ lifecycleLabel(value) }}</button>
        </div>
        <div class="kind-tabs">
          <button type="button" :class="{ active: kind === 'all' }" data-testid="attention-kind-all" @click="kind = 'all'">{{ t('common.all') }}</button>
          <button type="button" :class="{ active: kind === 'approval' }" data-testid="attention-kind-approval" @click="kind = 'approval'">{{ t('attention.kind_approval') }}</button>
          <button type="button" :class="{ active: kind === 'question' }" data-testid="attention-kind-question" @click="kind = 'question'">{{ t('attention.kind_question') }}</button>
          <button type="button" :class="{ active: kind === 'recovery' }" data-testid="attention-kind-recovery" @click="kind = 'recovery'">{{ t('attention.kind_recovery') }}</button>
        </div>
      </div>

      <div class="inbox-stage" :class="{ 'detail-only': isMobile && selectedEntry }">
        <section v-if="!isMobile || !selectedEntry" class="queue-panel" :aria-label="t('attention.queue')">
          <header><strong>{{ queueTitle }}</strong><span>{{ t('attention.risk_sorted') }}</span></header>
          <div v-if="visibleEntries.length" class="queue-list">
            <template v-for="entry in visibleEntries" :key="entry.key">
              <AttentionInboxItemRow v-if="entry.type === 'item'" :item="entry.item"
                :selected="selectedKey === entry.key" @select="selectItem(entry.item)" />
              <AttentionRecoveryItemRow v-else :item="entry.item"
                :selected="selectedKey === entry.key" @select="selectRecovery(entry.item)" />
            </template>
          </div>
          <div v-else class="queue-empty"><span>✓</span><strong>{{ t('attention.empty') }}</strong><small>{{ t('attention.empty_copy') }}</small></div>
          <button v-if="hasMoreHint" type="button" class="load-more" @click="store.loadMore(scope)">{{ t('attention.load_more') }}</button>
        </section>

        <section v-if="!isMobile && !selectedEntry" class="detail-placeholder">
          <span>⌁</span><strong>{{ t('attention.select_item') }}</strong><small>{{ t('attention.select_item_copy') }}</small>
        </section>
        <AttentionInboxDetail v-else-if="selectedItem" :item="selectedItem" :actions="store.allowedActions(selectedItem)"
          :read-only="store.capabilities.value.mode === 'observe'" :mobile="isMobile" :busy="busy"
          @submit="submit" @snooze="snooze" @restore="restore" @open-session="openSession" @close="selectedKey = ''" />
        <AttentionRecoveryDetail v-else-if="selectedRecovery" :item="selectedRecovery" :mobile="isMobile" :busy="busy"
          @snooze="snoozeRecovery" @restore="restoreRecovery" @open-host="openHost" @close="selectedKey = ''" />
      </div>
      <p v-if="store.errorMessage.value" class="inbox-error" role="status">{{ store.errorMessage.value }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AttentionInboxDetail from '../components/attention-inbox/AttentionInboxDetail.vue'
import AttentionInboxItemRow from '../components/attention-inbox/AttentionInboxItemRow.vue'
import AttentionRecoveryDetail from '../components/attention-inbox/AttentionRecoveryDetail.vue'
import AttentionRecoveryItemRow from '../components/attention-inbox/AttentionRecoveryItemRow.vue'
import { useAttentionInbox, type AttentionInboxStore, type AttentionLifecycleFilter } from '../composables/useAttentionInbox'
import { useLocale } from '../composables/useLocale'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import type { AttentionActionID, AttentionInboxDisplayKind, AttentionInboxItem, AttentionInboxScope, AttentionRecoveryItem } from '../types/attentionInbox'

const props = defineProps<{ store?: AttentionInboxStore }>()
const store = props.store ?? useAttentionInbox()
const route = useRoute()
const router = useRouter()
const { t } = useLocale()
const { isMobile } = useResponsiveLayout()
const lifecycle = ref<AttentionLifecycleFilter>('active')
const kind = ref<'all' | AttentionInboxDisplayKind>('all')
const selectedKey = ref('')
const busy = ref(false)
const lifecycleOptions: AttentionLifecycleFilter[] = ['active', 'snoozed', 'handled']

const scope = computed<AttentionInboxScope>(() => typeof route.query.daemon_id === 'string' && route.query.daemon_id
  ? { type: 'daemon', daemonId: route.query.daemon_id, daemonName: typeof route.query.daemon_name === 'string' ? route.query.daemon_name : undefined }
  : { type: 'global' })
const scopeCopy = computed(() => scope.value.type === 'daemon'
  ? t('attention.daemon_scope', { name: scope.value.daemonName || scope.value.daemonId })
  : t('attention.global_scope'))
const visibleEntries = computed(() => {
  const entries: Array<
    | { type: 'item'; key: string; item: AttentionInboxItem }
    | { type: 'recovery'; key: string; item: AttentionRecoveryItem }
  > = []
  if (kind.value !== 'recovery') {
    entries.push(...store.itemsFor(scope.value, lifecycle.value)
      .filter(item => kind.value === 'all' || item.kind === kind.value)
      .map(item => ({ type: 'item' as const, key: `item:${item.item_id}`, item })))
  }
  if (kind.value === 'all' || kind.value === 'recovery') {
    entries.push(...store.recoveryItemsFor(scope.value, lifecycle.value)
      .map(item => ({ type: 'recovery' as const, key: `recovery:${item.recovery_id}`, item })))
  }
  return entries
})
const selectedItem = computed(() => selectedKey.value.startsWith('item:')
  ? store.itemById(selectedKey.value.slice(5)) : undefined)
const selectedRecovery = computed(() => selectedKey.value.startsWith('recovery:')
  ? store.recoveryById(selectedKey.value.slice(9)) : undefined)
const selectedEntry = computed(() => selectedItem.value ?? selectedRecovery.value)
const queueTitle = computed(() => lifecycle.value === 'active' ? t('attention.needs_action') : lifecycleLabel(lifecycle.value))
const hasMoreHint = computed(() => store.hasMore(scope.value))

function lifecycleLabel(value: AttentionLifecycleFilter): string {
  return t(`attention.lifecycle.${value}`)
}
function setLifecycle(value: AttentionLifecycleFilter): void {
  lifecycle.value = value
  kind.value = 'all'
  selectedKey.value = ''
}
async function selectItem(item: AttentionInboxItem): Promise<void> {
  selectedKey.value = `item:${item.item_id}`
  if (!item.seen_at) await store.markSeen(item.item_id)
}
async function selectRecovery(item: AttentionRecoveryItem): Promise<void> {
  selectedKey.value = `recovery:${item.recovery_id}`
  if (!item.seen_at) await store.markRecoverySeen(item.recovery_id)
}
async function submit(actionID: AttentionActionID, answers?: string[][]): Promise<void> {
  if (!selectedItem.value) return
  busy.value = true
  await store.submit(selectedItem.value.item_id, actionID, answers)
  busy.value = false
}
async function snooze(): Promise<void> {
  if (!selectedItem.value) return
  busy.value = true
  const ok = await store.snooze(selectedItem.value.item_id, new Date(Date.now() + 30 * 60_000))
  busy.value = false
  if (ok) selectedKey.value = ''
}
async function restore(): Promise<void> {
  if (!selectedItem.value) return
  busy.value = true
  const ok = await store.restore(selectedItem.value.item_id)
  busy.value = false
  if (ok) selectedKey.value = ''
}
async function snoozeRecovery(): Promise<void> {
  if (!selectedRecovery.value) return
  busy.value = true
  const ok = await store.snoozeRecovery(selectedRecovery.value.recovery_id, new Date(Date.now() + 30 * 60_000))
  busy.value = false
  if (ok) selectedKey.value = ''
}
async function restoreRecovery(): Promise<void> {
  if (!selectedRecovery.value) return
  busy.value = true
  const ok = await store.restoreRecovery(selectedRecovery.value.recovery_id)
  busy.value = false
  if (ok) selectedKey.value = ''
}
function openSession(): void {
  if (selectedItem.value) void router.push(`/session/${encodeURIComponent(selectedItem.value.session.id)}`)
}
function openHost(): void {
  if (selectedRecovery.value) {
    void router.push({ path: '/hosts', query: { daemon_id: selectedRecovery.value.navigation.daemon_id } })
  }
}

watch(visibleEntries, entries => {
  const selectedIsVisible = selectedKey.value && entries.some(entry => entry.key === selectedKey.value)
  if (!selectedIsVisible) selectedKey.value = !isMobile.value && entries.length ? entries[0].key : ''
})
watch(scope, async nextScope => {
  selectedKey.value = ''
  await store.refresh(nextScope)
  if (!isMobile.value && visibleEntries.value.length) selectedKey.value = visibleEntries.value[0].key
})
onMounted(async () => {
  await store.refresh(scope.value)
  if (!isMobile.value && visibleEntries.value.length) selectedKey.value = visibleEntries.value[0].key
})
</script>

<style scoped>
.attention-inbox-view { width: min(1280px, calc(100% - 48px)); min-height: calc(100dvh - 118px); margin: 0 auto; padding: 31px 0 44px; color: var(--fg); }
.inbox-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 21px; }
.overline { margin: 0 0 8px; color: var(--accent); font: 750 10px var(--font-mono); letter-spacing: .16em; text-transform: uppercase; }
.overline::before { display: inline-block; width: 21px; height: 1px; margin: 0 8px 3px 0; background: currentColor; content: ''; }
.inbox-head h1 { margin: 0; font-size: clamp(32px, 4vw, 52px); font-weight: 680; line-height: 1; letter-spacing: -.055em; }
.inbox-head > div > p:last-child { margin: 12px 0 0; color: var(--fg-secondary); font-size: 13px; }
.head-count { display: flex; align-items: baseline; gap: 9px; color: var(--fg-tertiary); font-size: 11px; }
.head-count strong { color: var(--warning); font: 680 34px/1 var(--font-display, var(--font-body)); }
.filter-deck { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.lifecycle-tabs, .kind-tabs { display: flex; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); }
.filter-deck button { min-height: 31px; padding: 0 12px; border: 0; border-radius: var(--radius-full); color: var(--fg-tertiary); background: transparent; font-size: 11px; font-weight: 650; cursor: pointer; }
.filter-deck button.active { color: var(--accent); background: var(--accent-muted); }
.inbox-stage { min-height: 586px; display: grid; grid-template-columns: minmax(340px, .84fr) minmax(420px, 1.16fr); overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: 0 28px 70px rgba(0,0,0,.18); }
.queue-panel { min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 90%, var(--bg)); }
.queue-panel > header { display: flex; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--border); }
.queue-panel > header strong { font-size: 12px; }.queue-panel > header span { color: var(--fg-tertiary); font-size: 10px; }
.queue-list { display: grid; gap: 2px; padding: 6px; }
.queue-empty, .detail-placeholder, .attention-disabled { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; min-height: 360px; color: var(--fg-tertiary); text-align: center; }
.queue-empty > span, .detail-placeholder > span { display: grid; width: 42px; height: 42px; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--success); background: var(--surface-hover); }
.queue-empty strong, .detail-placeholder strong { color: var(--fg-secondary); font-size: 13px; }.queue-empty small, .detail-placeholder small { max-width: 280px; }
.load-more { margin: auto 14px 14px; padding: 9px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface-hover); }
.detail-placeholder { min-height: 100%; }.attention-disabled { min-height: 70dvh; }.empty-mark { display: grid; width: 54px; height: 54px; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 16px; color: var(--accent); background: var(--accent-muted); font-size: 23px; font-weight: 800; }
.attention-disabled h1 { margin: 10px 0 0; color: var(--fg); }.attention-disabled p { max-width: 420px; margin: 0; }
.inbox-error { margin: 12px 0 0; color: var(--error); font-size: 12px; }
@media (max-width: 820px) {
  .attention-inbox-view { width: 100%; min-height: 100dvh; padding: 18px 14px max(28px, env(safe-area-inset-bottom)); }
  .inbox-head { align-items: flex-start; }.inbox-head h1 { font-size: 31px; }.head-count { flex-direction: column; align-items: flex-end; gap: 3px; }
  .filter-deck { align-items: stretch; flex-direction: column; }.lifecycle-tabs { display: grid; grid-template-columns: repeat(3, 1fr); border-radius: var(--radius-md); }.kind-tabs { display: grid; grid-template-columns: repeat(4, 1fr); border-radius: var(--radius-md); }
  .filter-deck button { border-radius: var(--radius-sm); }
  .inbox-stage { min-height: calc(100dvh - 245px); display: block; border-radius: var(--radius-md); }
  .inbox-stage.detail-only { min-height: calc(100dvh - 36px); }.queue-panel { min-height: inherit; border-right: 0; }
}
</style>
