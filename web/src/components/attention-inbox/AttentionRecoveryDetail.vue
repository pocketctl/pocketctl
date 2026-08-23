<template>
  <section class="recovery-detail" data-testid="attention-recovery-detail" aria-live="polite">
    <header>
      <span class="tag">{{ t('attention.kind_recovery') }} · HOST</span>
      <button v-if="mobile" type="button" :aria-label="t('common.back')" @click="$emit('close')">×</button>
    </header>
    <div class="radar" aria-hidden="true"><i></i></div>
    <h2>{{ t('attention.recovery_title', { name: item.daemon.display_name }) }}</h2>
    <p class="host-id">{{ item.daemon.id }}</p>
    <p class="summary">{{ t('attention.recovery_copy') }}</p>
    <dl>
      <div><dt>{{ t('attention.recovery_status') }}</dt><dd>{{ t(`attention.state_${item.state}`) }}</dd></div>
      <div><dt>{{ t('attention.recovery_last_seen') }}</dt><dd>{{ lastSeen }}</dd></div>
      <div><dt>{{ t('attention.recovery_source') }}</dt><dd>{{ t('attention.recovery_source_relay') }}</dd></div>
    </dl>
    <div class="boundary"><span>i</span><p>{{ t('attention.recovery_boundary') }}</p></div>
    <div class="actions">
      <button type="button" class="primary" data-testid="attention-open-host" :disabled="busy" @click="$emit('open-host')">{{ t('attention.open_host') }}</button>
      <button v-if="item.state === 'open'" type="button" data-testid="attention-recovery-snooze" :disabled="busy" @click="$emit('snooze')">{{ t('attention.snooze') }}</button>
      <button v-if="item.state === 'snoozed'" type="button" data-testid="attention-recovery-restore" :disabled="busy" @click="$emit('restore')">{{ t('attention.restore') }}</button>
    </div>
    <footer>{{ t('attention.recovery_auto_resolve') }}</footer>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AttentionRecoveryItem } from '../../types/attentionInbox'
const props = defineProps<{ item: AttentionRecoveryItem; mobile?: boolean; busy?: boolean }>()
defineEmits<{
  (event: 'snooze' | 'restore' | 'open-host' | 'close'): void
}>()
const { t } = useLocale()
const lastSeen = computed(() => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'medium',
}).format(new Date(props.item.last_seen_at)))
</script>

<style scoped>
.recovery-detail { min-width: 0; min-height: 100%; display: flex; flex-direction: column; align-items: flex-start; padding: 27px; color: var(--fg); }.recovery-detail header { width: 100%; display: flex; justify-content: space-between; }.tag { padding: 5px 9px; border: 1px solid var(--warning); border-radius: var(--radius-full); color: var(--warning); font: 700 10px var(--font-mono); letter-spacing: .06em; text-transform: uppercase; }.recovery-detail header button { width: 32px; height: 32px; border: 0; border-radius: 50%; color: var(--fg-secondary); background: var(--surface-hover); font-size: 21px; }
.radar { position: relative; width: 76px; height: 76px; display: grid; place-items: center; margin: 33px 0 2px; border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border)); border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--warning) 10%, transparent), transparent 62%); }.radar::before,.radar::after { position: absolute; border: 1px solid color-mix(in srgb, var(--warning) 27%, transparent); border-radius: 50%; content: ''; }.radar::before { width: 48px; height: 48px; }.radar::after { width: 24px; height: 24px; }.radar i { width: 7px; height: 7px; border-radius: 50%; background: var(--warning); box-shadow: 0 0 18px var(--warning); }
h2 { margin: 20px 0 7px; font-size: clamp(22px,2.3vw,30px); line-height: 1.16; letter-spacing: -.035em; }.host-id { margin: 0; color: var(--fg-tertiary); font: 10px var(--font-mono); }.summary { max-width: 540px; margin: 18px 0 0; color: var(--fg-secondary); font-size: 13px; line-height: 1.65; }
dl { width: 100%; display: grid; gap: 1px; margin: 23px 0 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--border); }dl div { display: grid; grid-template-columns: 148px minmax(0,1fr); gap: 16px; padding: 12px 14px; background: var(--bg); }dt { color: var(--fg-tertiary); font-size: 10px; text-transform: uppercase; }dd { margin: 0; color: var(--fg); font: 11px var(--font-mono); overflow-wrap: anywhere; }
.boundary { display: flex; gap: 10px; margin-top: 17px; padding: 11px 12px; border-radius: var(--radius-sm); color: var(--fg-secondary); background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 12px; line-height: 1.5; }.boundary span { flex: 0 0 auto; display: grid; width: 18px; height: 18px; place-items: center; border: 1px solid var(--accent); border-radius: 50%; color: var(--accent); font: 700 10px serif; }.boundary p { margin: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }.actions button { min-height: 40px; padding: 0 14px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg); background: var(--surface-hover); font-size: 12px; font-weight: 680; cursor: pointer; }.actions .primary { border-color: var(--accent); color: var(--bg); background: var(--accent); }.actions button:disabled { opacity: .45; }footer { margin-top: auto; padding-top: 24px; color: var(--fg-tertiary); font-size: 11px; }
@media (max-width:820px) { .recovery-detail { min-height: calc(100dvh - 24px); padding: 20px 17px max(24px,env(safe-area-inset-bottom)); }dl div { grid-template-columns: 110px minmax(0,1fr); } }
</style>
