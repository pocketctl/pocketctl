<template>
  <div class="zcode-quota" :class="variant">
    <button class="zcode-quota-entry" :class="{ low: !stale && hasLow, old: stale }" type="button" aria-haspopup="dialog" @click="open=true">
      <span class="entry-copy"><strong>{{ variant==='agent' ? t('zcode_quota.remaining_title') : t('zcode_quota.plan') }}<small v-if="stale"> · {{ t('codex_quota.previous') }}</small></strong>
        <span class="entry-windows"><span v-for="w in windows" :key="w.id">{{ t(w.id==='five_hour'?'zcode_quota.five_short':'zcode_quota.week_short') }} <b :class="{warning:!stale && isLow(w)}">{{ percent(w.remaining_percent) }}</b></span></span>
        <small v-if="notice">{{ notice }}</small>
      </span><span aria-hidden="true">›</span>
    </button>
    <CodexQuotaDialog v-if="open" :title="t('zcode_quota.title')" inert-background @close="open=false">
      <div class="zq-panel">
        <div class="zq-plan"><div><strong>{{ t('zcode_quota.plan') }}</strong><p>{{ t('zcode_quota.personal') }}</p></div><span v-if="snapshot?.level" class="zq-level">{{ snapshot.level.toUpperCase() }}</span></div>
        <p v-if="notice" class="zq-notice" :class="{warning:!stale&&hasLow}" role="status">{{ notice }}</p>
        <h3>{{ t(stale?'zcode_quota.previous_title':'zcode_quota.remaining') }}</h3>
        <div class="zq-group"><section v-for="w in windows" :key="w.id" class="zq-window">
          <div class="zq-window-title"><span>{{ t(w.id==='five_hour'?'zcode_quota.five':'zcode_quota.week') }}</span><strong :class="{warning:!stale&&isLow(w),muted:stale}">{{ percent(w.remaining_percent) }}<small>{{ t(w.remaining_percent===null?'zcode_quota.unknown':stale?'codex_quota.previous_remaining':'codex_quota.remaining') }}</small></strong></div>
          <div v-if="w.remaining_percent!==null" class="zq-track" aria-hidden="true"><i :class="{warning:!stale&&isLow(w),muted:stale}" :style="{width:w.remaining_percent+'%'}" /></div>
          <small class="zq-reset">{{ resetLabel(w.resets_at) }}</small>
        </section></div>
        <p class="zq-note">{{ t('zcode_quota.shared_note') }}</p>
        <h3>{{ t('codex_quota.source') }}</h3><dl class="zq-group"><div><dt>{{ t('codex_quota.host') }}</dt><dd>{{ hostname || daemonId }}</dd></div><div><dt>{{ t('zcode_quota.account') }}</dt><dd>{{ t('zcode_quota.current_account') }}</dd></div><div><dt>{{ t('zcode_quota.source') }}</dt><dd>{{ t('zcode_quota.official') }}</dd></div></dl>
        <p class="zq-note">{{ t('zcode_quota.reset_note') }}</p>
        <button class="zq-refresh" :disabled="loading||!online" @click="refresh">{{ t(!online?'codex_quota.offline':loading?'codex_quota.loading':'codex_quota.refresh') }}</button>
        <p class="zq-fresh" role="status">{{ snapshot ? t('codex_quota.updated')+' '+formatDate(snapshot.observed_at) : t('codex_quota.no_data') }}</p>
      </div>
    </CodexQuotaDialog>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useZcodeQuota, type ZcodeQuotaWindow } from '../../composables/useZcodeQuota'
import { useLocale } from '../../composables/useLocale'
import CodexQuotaDialog from './CodexQuotaDialog.vue'
const props=withDefaults(defineProps<{daemonId:string;hostname?:string;daemonOnline?:boolean;variant?:'agent'|'session'}>(),{variant:'session',daemonOnline:true})
const {t}=useLocale(),open=ref(false)
const {snapshot,loading,failed,online,stale,refresh}=useZcodeQuota(computed(()=>({daemonId:props.daemonId,online:props.daemonOnline})))
const windows=computed<ZcodeQuotaWindow[]>(()=>['five_hour','week'].map(id=>snapshot.value?.windows.find(w=>w.id===id)??{id:id as ZcodeQuotaWindow['id'],remaining_percent:null,resets_at:null}))
const isLow=(w:ZcodeQuotaWindow)=>w.remaining_percent!==null&&w.remaining_percent<=20
const hasLow=computed(()=>windows.value.some(isLow))
const notice=computed(()=>{
  if(stale.value)return t(!online.value?'zcode_quota.offline_old':failed.value?'zcode_quota.failed_old':'zcode_quota.stale')
  if(!online.value)return t('codex_quota.offline')
  if(loading.value&&!snapshot.value)return t('codex_quota.loading')
  if(snapshot.value?.status==='not_configured')return t('zcode_quota.not_connected')
  if(snapshot.value?.status==='unsupported')return t('zcode_quota.unsupported')
  if(failed.value||!snapshot.value)return t('zcode_quota.unavailable')
  if(windows.value.some(w=>w.remaining_percent===null))return t('zcode_quota.partial')
  if(windows.value.some(w=>w.remaining_percent===0))return t('zcode_quota.zero')
  return hasLow.value?t('zcode_quota.low'):''
})
function percent(n:number|null){return n===null?'—':new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n)+'%'}
function formatDate(s:string){return new Date(s).toLocaleString()}
function resetLabel(n:number|null){return n===null?t('codex_quota.reset_unknown'):t('codex_quota.resets')+' '+new Date(n*1000).toLocaleString()}
watch(open,value=>{if(value)refresh()})
watch(()=>props.daemonId,()=>open.value=false)
watch(snapshot,(next,old)=>{if(old&&!next)open.value=false})
</script>
<style scoped>
.zcode-quota{width:100%;min-width:0;flex-shrink:0}.zcode-quota-entry{display:flex;gap:12px;align-items:center;justify-content:space-between;width:100%;min-height:52px;padding:10px 20px;border:0;border-bottom:1px solid var(--border);background:var(--surface);color:var(--fg);font:inherit;text-align:left;cursor:pointer}.entry-copy{min-width:0}.entry-copy>strong{font-size:13px;font-weight:500}.entry-copy small{font-weight:400}.entry-windows{display:flex;flex-wrap:wrap;gap:5px 18px;font-size:12px;margin-top:4px}.entry-windows b{font-weight:600;font-variant-numeric:tabular-nums;margin-left:4px}.entry-copy>small{display:block;font-size:12px;color:var(--muted);margin-top:4px}.warning{color:var(--warning,#996919)}.low{background:color-mix(in srgb,var(--warning,#996919) 8%,var(--surface))}.old b,.muted{color:var(--muted)}.agent .zcode-quota-entry{margin-top:12px;padding:12px 0 0;border-bottom:0;border-top:1px solid var(--border);background:transparent}.agent .entry-copy>strong{font-size:12px;color:var(--muted)}.zq-panel{line-height:1.6}.zq-plan{display:flex;justify-content:space-between;gap:12px}.zq-plan strong{font-size:16px}.zq-plan p,.zq-note,.zq-fresh{font-size:12px;color:var(--muted);margin:6px 0}.zq-level{font-size:11px;border:1px solid var(--border);padding:2px 8px;border-radius:6px;align-self:flex-start}.zq-notice{font-size:13px;border-radius:9px;padding:10px 12px;background:var(--bg);color:var(--muted);margin:14px 0}.zq-notice.warning{color:var(--warning,#996919)}h3{font-size:12px;font-weight:400;color:var(--muted);margin:16px 0 8px}.zq-group{border:1px solid var(--border);border-radius:12px;overflow:hidden;margin:0}.zq-window{padding:16px}.zq-window+.zq-window,.zq-group>div+div{border-top:1px solid var(--border)}.zq-window-title{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px}.zq-window-title>strong{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.zq-window-title small{font-size:11px;color:var(--muted);font-weight:400;margin-left:5px}.zq-track{height:5px;border-radius:4px;background:var(--border);margin:12px 0 8px;overflow:hidden}.zq-track i{display:block;height:100%;background:var(--accent);border-radius:4px}.zq-track i.warning{background:var(--warning,#996919)}.zq-track i.muted{background:var(--muted)}.zq-reset{font-size:12px;color:var(--muted);display:block;margin-top:8px}.zq-group>div{display:flex;justify-content:space-between;gap:20px;padding:10px 14px;font-size:12px}.zq-group dt{color:var(--muted)}.zq-group dd{margin:0;text-align:right;overflow-wrap:anywhere}.zq-refresh{width:100%;min-height:44px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--accent);font:inherit;font-size:14px;margin-top:18px;cursor:pointer}.zq-refresh:disabled{color:var(--muted)}.zq-fresh{text-align:center}.zcode-quota button:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}
</style>
