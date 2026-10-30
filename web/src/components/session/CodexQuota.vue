<template>
  <button ref="opener" class="codex-quota-strip" :class="tone" type="button" aria-haspopup="dialog" @click="open = true">
    <span aria-hidden="true">{{ tone === 'warning' || tone === 'danger' ? '⚠' : '◷' }}</span>
    <span class="quota-copy"><strong>{{ title }}</strong><small v-if="stale">{{ t('codex_quota.stale_note') }}</small><small v-else-if="!online">{{ t('codex_quota.offline') }}</small><small v-else-if="selected?.window.resets_at">{{ resetLabel(selected.window.resets_at) }}</small></span><span aria-hidden="true">›</span>
  </button>
  <CodexQuotaDialog v-if="open" @close="open = false">
    <div class="codex-quota-detail">
      <section class="quota-summary" :class="tone"><p>{{ stale ? t('codex_quota.previous') : t('codex_quota.account') }}</p><strong>{{ selected ? formatPercent(selected.window.remaining_percent) + '%' : '—' }}</strong><span> {{ t('codex_quota.remaining') }}</span><p>{{ title }}</p></section>
      <h3>{{ t('codex_quota.windows') }}</h3>
      <div v-if="snapshot?.buckets.length" class="quota-group">
        <template v-for="bucket in snapshot.buckets" :key="bucket.id">
          <div v-for="(window, index) in bucket.windows" :key="bucket.id + ':' + index" class="quota-row">
            <div><span>{{ bucket.name || bucket.id }} · {{ windowLabel(window.duration_minutes) }}</span><b>{{ formatPercent(window.remaining_percent) }}% {{ t(stale ? 'codex_quota.previous_remaining' : 'codex_quota.remaining') }}</b></div>
            <progress :value="window.remaining_percent" max="100" :aria-label="windowLabel(window.duration_minutes)" />
            <small>{{ resetLabel(window.resets_at) }}</small>
          </div>
          <p v-if="bucket.exhausted" class="quota-row">{{ bucket.name || bucket.id }} · {{ t('codex_quota.exhausted') }}</p>
        </template>
      </div>
      <p v-else>{{ t('codex_quota.unavailable') }}</p>
      <p class="quota-note">{{ t('codex_quota.shared_note') }}</p>
      <h3>{{ t('codex_quota.source') }}</h3><div class="quota-group"><div class="quota-row"><div><span>{{ t('codex_quota.host') }}</span><span>{{ hostname || daemonId }}</span></div></div><div class="quota-row"><div><span>{{ t('codex_quota.account') }}</span><span>{{ accountLabel || t('codex_quota.current_account') }}</span></div></div></div>
      <p class="quota-note">{{ t('codex_quota.reset_note') }}</p>
      <button class="quota-refresh" :disabled="loading || !online" @click="refresh">{{ t(!online ? 'codex_quota.offline' : loading ? 'codex_quota.loading' : 'codex_quota.refresh') }}</button>
      <p class="quota-note" role="status">{{ failed ? t('codex_quota.failed') : '' }} {{ snapshot ? t('codex_quota.updated') + ' ' + formatDate(snapshot.observed_at) : t('codex_quota.no_data') }}</p>
    </div>
  </CodexQuotaDialog>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import CodexQuotaDialog from './CodexQuotaDialog.vue'
import { useLocale } from '../../composables/useLocale'
import { useCodexQuota } from '../../composables/useCodexQuota'
const props = defineProps<{sessionId:string;daemonId:string;hostname?:string;accountLabel?:string;daemonOnline?:boolean}>()
const {t,locale}=useLocale()
const options=computed(()=>({sessionId:props.sessionId,daemonId:props.daemonId,online:props.daemonOnline}))
const {snapshot,loading,failed,online,stale,refresh}=useCodexQuota(options)
const open=ref(false),opener=ref<HTMLElement|null>(null)
const selected=computed(()=>snapshot.value?.buckets.flatMap(bucket=>bucket.windows.map(window=>({bucket,window}))).sort((a,b)=>a.window.remaining_percent-b.window.remaining_percent)[0])
const exhausted=computed(()=>snapshot.value?.exhausted || snapshot.value?.buckets.some(b=>b.exhausted))
const tone=computed(()=>stale.value || !online.value ? 'neutral' : exhausted.value ? 'danger' : selected.value && selected.value.window.remaining_percent<=20 ? 'warning' : 'neutral')
const formatPercent=(n:number)=>new Intl.NumberFormat(locale.value,{maximumFractionDigits:1}).format(n)
const formatDate=(date:string|number)=>new Date(date).toLocaleString(locale.value==='zh'?'zh-CN':'en-US')
const windowLabel=(minutes:number|null)=>minutes===10080?t('codex_quota.week'):minutes===null?t('codex_quota.window'):minutes%60===0?t('codex_quota.hours',{n:minutes/60}):t('codex_quota.minutes',{n:minutes})
const resetLabel=(value:number|null)=>value?t('codex_quota.resets')+' '+formatDate(value*1000):t('codex_quota.reset_unknown')
const title=computed(()=>stale.value?t('codex_quota.stale'):!online.value?t('codex_quota.offline'):loading.value&&!snapshot.value?t('codex_quota.loading'):exhausted.value?t('codex_quota.exhausted'):selected.value?`Codex · ${windowLabel(selected.value.window.duration_minutes)} · ${t('codex_quota.remaining')} ${formatPercent(selected.value.window.remaining_percent)}%`:t('codex_quota.unavailable'))
watch(()=>props.sessionId,()=>{open.value=false})
watch(snapshot,(next,old)=>{if(!next&&old)open.value=false})
</script>
<style scoped>
.codex-quota-strip{width:100%;flex-shrink:0;display:flex;align-items:center;gap:10px;padding:10px 16px;text-align:left;border:0;border-bottom:1px solid var(--border);background:var(--bg-secondary);color:var(--fg-secondary);font:inherit;cursor:pointer}.quota-copy{flex:1;min-width:0}.quota-copy strong{font-size:13px;font-weight:500;display:block}.quota-copy small{display:block;font-size:12px;margin-top:2px}.warning{color:var(--warning,#b78103);background:color-mix(in srgb,var(--warning,#b78103) 8%,var(--bg-secondary))}.danger{color:var(--error);background:color-mix(in srgb,var(--error) 8%,var(--bg-secondary))}.codex-quota-detail{font-size:13px;line-height:1.6}.quota-summary{padding:16px;border:1px solid var(--border);border-radius:12px}.quota-summary>strong{font-size:34px;font-variant-numeric:tabular-nums}.quota-summary p{margin:0 0 6px}.quota-summary>span,.quota-note,.quota-row small{color:var(--fg-secondary)}h3{font-size:12px;font-weight:500;color:var(--fg-secondary);margin:18px 0 8px}.quota-group{border:1px solid var(--border);border-radius:12px;overflow:hidden}.quota-row{padding:12px 14px}.quota-row+.quota-row{border-top:1px solid var(--border)}.quota-row>div{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.quota-row b{font-weight:600}progress{display:block;width:100%;height:5px;margin:10px 0;accent-color:var(--accent)}.quota-note{font-size:12px;margin:12px 0}.quota-refresh{width:100%;border:1px solid var(--border);background:var(--bg-secondary);color:var(--accent);border-radius:8px;padding:10px;font:inherit;cursor:pointer}.quota-refresh:disabled{opacity:.5;cursor:default}.codex-quota-strip:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
</style>
