<template>
  <button v-if="variant==='agent'" ref="opener" class="codex-quota-entry" :class="{old:stale}" type="button" aria-haspopup="dialog" @click="show()">
    <span class="quota-entry-heading">{{ t('codex_quota.account') }}<span v-if="planLabel"> · {{ planLabel }}</span><span v-if="stale"> · {{ t('codex_quota.previous') }}</span><span class="chevron" aria-hidden="true">›</span></span>
    <span class="quota-entry-values"><span v-for="w in windows" :key="w.key">{{ w.shortLabel }} <b :class="{low:!stale&&w.remaining!==null&&w.remaining<=20}">{{ percent(w.remaining) }}</b></span><span v-if="showCards">{{ t('codex_quota.cards') }} <b>{{ cardCount===null?'—':t('codex_quota.card_count',{n:cardCount}) }}</b></span></span>
    <small v-if="notice">{{ notice }}</small>
  </button>
  <CodexQuotaDialog v-if="open" :title="title" inert-background @close="open=false">
    <div class="codex-quota-detail">
      <div class="quota-plan"><div><strong>Codex CLI</strong><p>{{ accountLabel || t('codex_quota.current_account') }}</p></div><span v-if="planLabel" class="quota-plan-label">{{ planLabel }}</span></div>
      <p v-if="notice" class="quota-notice" :class="{low:!stale&&hasLow,danger:!stale&&exhausted}" role="status">{{ notice }}</p>
      <h3>{{ t(stale?'codex_quota.previous':'codex_quota.windows') }}</h3>
      <div v-if="windows.length" class="quota-group">
        <section v-for="w in windows" :key="w.key" class="quota-window" :class="{old:stale,low:!stale&&w.remaining!==null&&w.remaining<=20}">
          <div class="quota-window-heading"><span>{{ w.label }}</span><strong>{{ percent(w.remaining) }}<small>{{ t(w.remaining===null?'zcode_quota.unknown':stale?'codex_quota.previous_remaining':'codex_quota.remaining') }}</small></strong></div>
          <progress v-if="w.remaining!==null" :value="w.remaining" max="100" :aria-label="w.label" />
          <small>{{ resetLabel(w.reset) }}</small>
        </section>
      </div><p v-else class="quota-note">{{ t('codex_quota.unavailable') }}</p>
      <template v-if="showCards">
        <h3>{{ t('codex_quota.cards') }}</h3>
        <section class="quota-group">
          <div class="quota-card-total"><span>{{ t(stale?'codex_quota.cards_previous':'codex_quota.cards_available') }}</span><strong>{{ cardCount===null?'—':t('codex_quota.card_count',{n:cardCount}) }}</strong></div>
          <p v-if="cardCount===null" class="quota-card-note">{{ t('codex_quota.cards_unknown') }}</p>
          <p v-else-if="!snapshot?.reset_credits?.credits" class="quota-card-note">{{ t('codex_quota.card_details_unknown') }}</p>
          <details v-else-if="snapshot.reset_credits.credits.length" class="quota-card-details"><summary>{{ t('codex_quota.card_expiries') }}</summary><div v-for="(c,i) in snapshot.reset_credits.credits" :key="i" class="quota-credit"><strong>{{ t('codex_quota.card_name') }}</strong><small>{{ c.expires_at===null?t('codex_quota.card_no_expiry'):t('codex_quota.card_expires')+' '+formatDate(c.expires_at*1000) }}</small></div></details>
          <p v-if="cardCount!==null&&snapshot?.reset_credits?.credits&&snapshot.reset_credits.credits.length<cardCount" class="quota-card-note">{{ t('codex_quota.card_details_partial',{n:snapshot.reset_credits.credits.length,total:cardCount}) }}</p>
        </section>
        <p class="quota-note">{{ t('codex_quota.cards_read_only') }}</p>
      </template>
      <h3>{{ t('codex_quota.source') }}</h3><dl class="quota-group quota-source"><div><dt>{{ t('codex_quota.host') }}</dt><dd>{{ hostname||daemonId }}</dd></div><div><dt>{{ t('codex_quota.account') }}</dt><dd>{{ accountLabel||selectedHomeLabel||t('codex_quota.current_account') }}</dd></div><div><dt>{{ t('zcode_quota.source') }}</dt><dd>{{ t('codex_quota.official') }}</dd></div></dl>
      <label v-if="!sessionId&&homes.length>1" class="quota-account-picker">{{ t('codex_quota.account') }}<select v-model="homeId"><option v-for="home in homes" :key="home.id" :value="home.id">{{ home.label }}</option></select></label>
      <p class="quota-note">{{ t('codex_quota.shared_note') }}</p>
      <button class="quota-refresh" :disabled="loading||!online" @click="refresh">{{ t(!online?'codex_quota.offline':loading?'codex_quota.loading':showCards?'codex_quota.refresh_with_cards':'codex_quota.refresh') }}</button>
      <p class="quota-note quota-fresh" role="status">{{ snapshot?t('codex_quota.updated')+' '+formatDate(snapshot.observed_at):t('codex_quota.no_data') }}</p>
    </div>
  </CodexQuotaDialog>
</template>
<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted} from 'vue'
import CodexQuotaDialog from './CodexQuotaDialog.vue'
import {useLocale} from '../../composables/useLocale'
import {useCodexQuota} from '../../composables/useCodexQuota'
import {useWebSocket} from '../../composables/useWebSocket'
import {useAuth} from '../../composables/useAuth'
import {getRelayWs} from '../../composables/useEnv'
const props=withDefaults(defineProps<{sessionId?:string;daemonId:string;hostname?:string;accountLabel?:string;daemonOnline?:boolean;variant?:'agent'|'session'}>(),{variant:'agent'})
const {t,locale}=useLocale(),homeId=ref(''),homes=ref<{id:string;label:string}[]>([])
const {snapshot,loading,failed,online,stale,refresh}=useCodexQuota(computed(()=>({sessionId:props.sessionId,daemonId:props.daemonId,homeId:homeId.value,online:props.daemonOnline})))
const open=ref(false),opener=ref<HTMLElement|null>(null)
const cardCount=computed(()=>snapshot.value?.reset_credits?.available_count??null)
const showCards=computed(()=>cardCount.value!==0)
const title=computed(()=>t(showCards.value?'codex_quota.with_cards':'codex_quota.title'))
const planLabel=computed(()=>{const p=snapshot.value?.plan_type??'';return p==='plus'?'Plus':['pro','prolite','promax'].includes(p)?'Pro':p==='free'?'Free':['business','team'].includes(p)?'Business':['enterprise','edu','edu_plus','edu_pro'].includes(p)?p==='enterprise'?'Enterprise':'Edu':''})
const formatDate=(date:string|number)=>new Date(date).toLocaleString(locale.value==='zh'?'zh-CN':'en-US')
const percent=(n:number|null)=>n===null?'—':new Intl.NumberFormat(locale.value,{maximumFractionDigits:1}).format(n)+'%'
const windowLabel=(m:number|null)=>m===10080?t('codex_quota.week'):m===null?t('codex_quota.window'):m%60===0?t('codex_quota.hours',{n:m/60}):t('codex_quota.minutes',{n:m})
const windows=computed(()=>{
 const all=(snapshot.value?.buckets??[]).flatMap(b=>b.windows.map((w,i)=>({key:b.id+':'+i,label:(b.id==='codex'?'':(b.name||b.id)+' · ')+windowLabel(w.duration_minutes),shortLabel:windowLabel(w.duration_minutes),remaining:w.remaining_percent as number|null,reset:w.resets_at,minutes:w.duration_minutes}))).sort((a,b)=>(a.minutes??Number.MAX_SAFE_INTEGER)-(b.minutes??Number.MAX_SAFE_INTEGER))
 if(snapshot.value?.plan_type==='plus'&&snapshot.value.status==='ok'&&!all.some(w=>w.minutes===300))all.unshift({key:'missing-five-hour',label:windowLabel(300),shortLabel:windowLabel(300),remaining:null,reset:null,minutes:300})
 return all
})
const summary=computed(()=>[planLabel.value,...windows.value.map(w=>w.shortLabel+' '+percent(w.remaining)),...(showCards.value?[t('codex_quota.cards')+' '+(cardCount.value===null?'—':t('codex_quota.card_count',{n:cardCount.value}))]:[])].filter(Boolean).join(' · '))
const exhausted=computed(()=>snapshot.value?.exhausted||snapshot.value?.buckets.some(b=>b.exhausted))
const hasLow=computed(()=>windows.value.some(w=>w.remaining!==null&&w.remaining<=20))
const notice=computed(()=>stale.value?t(!online.value?'zcode_quota.offline_old':failed.value?'zcode_quota.failed_old':'zcode_quota.stale'):!online.value?t('codex_quota.offline'):loading.value&&!snapshot.value?t('codex_quota.loading'):snapshot.value?.status==='unauthenticated'?t('codex_quota.signed_out'):snapshot.value?.status==='unsupported'?t('codex_quota.unsupported'):failed.value||!snapshot.value?t('codex_quota.unavailable'):exhausted.value?t('codex_quota.exhausted'):windows.value.some(w=>w.remaining===null)?t('zcode_quota.partial'):hasLow.value?t('zcode_quota.low'):'')
const resetLabel=(n:number|null)=>n===null?t('codex_quota.reset_unknown'):t('codex_quota.resets')+' '+formatDate(n*1000)
const selectedHomeLabel=computed(()=>homes.value.find(h=>h.id===homeId.value)?.label)
function show(){open.value=true;refresh()}
defineExpose({show,title,summary})
const wire=useWebSocket(),{user}=useAuth()
let stop:(()=>void)|undefined,homeRequest=''
const identity=()=>`${user.value?.id??''}|${getRelayWs()}|${props.daemonId}`
function readHomes(){if(props.sessionId||!online.value)return;homeRequest=crypto.randomUUID();wire.send({type:'list_codex_homes',daemon_id:props.daemonId,request_id:homeRequest})}
onMounted(()=>{stop=wire.onEvent((msg:any)=>{if(msg.type!=='codex_home_list'||msg.request_id!==homeRequest||msg.daemon_id!==props.daemonId)return;homes.value=Array.isArray(msg.codex_homes)?msg.codex_homes.filter((h:any)=>typeof h?.id==='string'&&/^codex-home-[a-f0-9]{24}$/.test(h.id)&&typeof h.label==='string'&&h.label.length<=256).slice(0,32):[];if(!homeId.value&&homes.value.length)homeId.value=homes.value[0]!.id});readHomes()})
onUnmounted(()=>stop?.())
watch(identity,()=>{open.value=false;homeRequest='';homeId.value='';homes.value=[];readHomes()})
watch(online,value=>{if(value)readHomes()})
watch(homeId,()=>refresh())
watch(()=>props.sessionId,()=>open.value=false)
watch(snapshot,(next,old)=>{if(old&&(!next||old.scope_id!==next.scope_id))open.value=false})
</script>
<style scoped>
.codex-quota-entry{display:block;width:100%;min-height:64px;border:0;border-top:1px solid var(--border);margin-top:12px;padding:12px 0 0;text-align:left;background:transparent;color:var(--fg);font:inherit;cursor:pointer}.quota-entry-heading{display:block;font-size:12px;color:var(--fg-secondary)}.chevron{float:right}.quota-entry-values{display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12px;margin-top:7px}.quota-entry-values b{font-variant-numeric:tabular-nums;margin-left:4px}.codex-quota-entry>small{display:block;margin-top:5px;font-size:11px;color:var(--fg-secondary)}.low{color:var(--warning,#996919)}.danger{color:var(--error)}.codex-quota-detail{font-size:13px;line-height:1.6}.quota-plan{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.quota-plan strong{font-size:16px}.quota-plan p{font-size:12px;color:var(--fg-secondary);margin:3px 0}.quota-plan-label{border:1px solid var(--border);padding:2px 8px;border-radius:6px;font-size:11px;color:var(--fg-secondary)}.quota-notice{padding:10px 12px;border-radius:9px;background:var(--bg-secondary);color:var(--fg-secondary);font-size:12px}.quota-notice.low{color:var(--warning,#996919)}h3{font-size:12px;font-weight:400;color:var(--fg-secondary);margin:18px 0 8px}.quota-group{border:1px solid var(--border);border-radius:12px;overflow:hidden}.quota-window{padding:16px}.quota-window+.quota-window{border-top:1px solid var(--border)}.quota-window-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.quota-window-heading>strong{font-size:28px;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}.quota-window-heading small{font-size:11px;color:var(--fg-secondary);font-weight:400;margin-left:5px}.quota-window>small{font-size:12px;color:var(--fg-secondary)}.old{color:var(--fg-secondary)}progress{display:block;width:100%;height:5px;margin:12px 0 8px;accent-color:var(--accent)}.low progress{accent-color:var(--warning,#996919)}.old progress{accent-color:var(--fg-secondary)}.quota-card-total{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px}.quota-card-total>strong{font-size:24px;font-variant-numeric:tabular-nums}.quota-card-note,.quota-note{font-size:12px;color:var(--fg-secondary);line-height:1.65}.quota-card-note{padding:0 16px 12px;margin:0}.quota-card-details{border-top:1px solid var(--border)}summary{padding:12px 16px;color:var(--accent);min-height:44px;cursor:pointer}.quota-credit{padding:12px 16px;border-top:1px solid var(--border)}.quota-credit strong,.quota-credit small{display:block;font-size:12px}.quota-credit small{color:var(--fg-secondary);margin-top:3px}.quota-source{margin:0}.quota-source>div{display:flex;justify-content:space-between;gap:18px;padding:10px 14px;font-size:12px}.quota-source>div+div{border-top:1px solid var(--border)}dt{color:var(--fg-secondary)}dd{margin:0;overflow-wrap:anywhere;text-align:right}.quota-refresh{width:100%;min-height:44px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--accent);font:inherit;cursor:pointer}.quota-refresh:disabled{color:var(--fg-secondary);cursor:default}.quota-fresh{text-align:center}.quota-account-picker{display:flex;gap:12px;align-items:center;margin-top:12px;font-size:12px}.quota-account-picker select{max-width:70%;min-height:44px;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:6px}.codex-quota-entry:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
