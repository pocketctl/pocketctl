<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,shallowRef,watch} from 'vue'
import {useLocale} from '../composables/useLocale'
import {useAuth} from '../composables/useAuth'
import {getRelayOrigin} from '../composables/useEnv'
import {usePlatformStatisticsAccess} from '../composables/usePlatformStatisticsAccess'
import {getPlatformStatistics,exportPlatformStatistics,PlatformStatisticsError} from '../services/platformStatistics'
import {dateRange,validDateRange,shanghaiToday,metricValue,comparison} from '../components/statistics/statisticsModel'
import StatisticsChart from '../components/statistics/StatisticsChart.vue'
import type {PlatformStatistics,StatisticsCoreMetricKey,StatisticsMetricKey,StatisticsMetric,StatisticsRange} from '../types/platformStatistics'
import '../components/statistics/statistics.css'
const {t}=useLocale(),auth=useAuth(),access=usePlatformStatisticsAccess()
const data=shallowRef<PlatformStatistics|null>(null),loading=ref(false),failed=ref(false),stale=ref(false),exporting=ref(false),exportError=ref(false)
const selected=ref<StatisticsCoreMetricKey>('activeUsers'),period=ref<1|7|30|'custom'>(7),custom=ref(false),range=ref<StatisticsRange>(dateRange(7)),draft=ref({...range.value}),dateError=ref(false),dailyOpen=ref(false),defsOpen=ref(false)
const keys:StatisticsCoreMetricKey[]=['newUsers','activeUsers','sessions','memory']
const definitionKeys:StatisticsMetricKey[]=[...keys,'memoryUsers','readRequests']
const sources=['automatic','manual','unclassified'] as const
const chartCompare=computed(()=>!!data.value?.comparisonAvailable&&data.value.metrics[selected.value].status==='complete'&&data.value.previous[selected.value].status==='complete')
const serverCodes=["configured_test_service_users", "configured_memory_installation_scopes", "shared_creation_owner_not_inferred", "active_users_v1_explicit_business_whitelist", "exclude_login_page_open_heartbeat_sync_replay", "exclude_candidate_shadow_projection_migration", "materialization_pending", "collector_interrupted"].concat(['source_coverage_unknown','before_forward_coverage','coverage_gap','source_cutoff_incomplete','memory_source_unavailable','memory_actor_limit_exceeded','memory_actor_owner_unknown','memory_human_source_unavailable'])
function sourceText(value:string){
 if(serverCodes.includes(value))return t('stats.reason.'+value)
 if(value==='Explicitly configured test/service user IDs are excluded.')return t('stats.excludeAccounts')
 if(value==='Explicitly configured Memory installation scopes are excluded; shared creation ownership is not inferred.')return t('stats.excludeScopes')
 return t('stats.sourceLimitation')
}
function timestamp(value:string){const date=new Date(value);if(!Number.isFinite(date.getTime()))return value;return new Date(date.getTime()+8*3600000).toISOString().slice(0,16).replace('T',' ')+' +08:00'}
let generation=0,controller:AbortController|undefined,exportController:AbortController|undefined,origin=getRelayOrigin(),timer:ReturnType<typeof setInterval>|undefined
const identity=()=>`${auth.user.value?.id}|${auth.accessToken.value}|${getRelayOrigin()}`
let lastIdentity=identity()
function clear(){generation++;controller?.abort();exportController?.abort();data.value=null;stale.value=false;failed.value=false;exportError.value=false;loading.value=false;exporting.value=false}
function checkIdentity(){access.syncIdentity();const next=identity();if(lastIdentity!==next){lastIdentity=next;origin=getRelayOrigin();clear();return false}return true}
watch([auth.accessToken,()=>auth.user.value?.id],()=>{checkIdentity();void load(true)},{flush:'sync'})
watch(access.allowed,value=>{if(!value)clear()},{flush:'sync'})
const denied=computed(()=>access.status.value==='denied')
async function load(checkAccess=false){
 if(!checkIdentity())checkAccess=true
 const requestIdentity=identity(),turn=++generation
 controller?.abort();controller=new AbortController();loading.value=true;failed.value=false;exportError.value=false
 try{
  if(checkAccess||!access.allowed.value){if(!await access.refresh()){if(turn===generation){failed.value=!denied.value;loading.value=false}return}}
  if(turn!==generation||requestIdentity!==identity())return
  const result=await getPlatformStatistics({...range.value},controller.signal)
  if(turn!==generation||requestIdentity!==identity()||!access.allowed.value)return
  data.value=result;stale.value=false
 }catch(error){if(turn!==generation||requestIdentity!==identity())return
  if(error instanceof PlatformStatisticsError&&[401,403].includes(error.status)){clear();access.invalidate()}
  else{failed.value=true;stale.value=!!data.value}
 }finally{if(turn===generation)loading.value=false}
}
function selectPeriod(value:1|7|30|'custom'){
 custom.value=value==='custom';dateError.value=false;if(value==='custom'){draft.value={...range.value};return}
 period.value=value;range.value=dateRange(value);clear();void load()
}
function applyDates(){if(!validDateRange(draft.value)){dateError.value=true;return}period.value='custom';range.value={...draft.value};dateError.value=false;clear();void load()}
const statusText=(m:StatisticsMetric)=>m.status==='partial'?t(m.value===null?'stats.partial':'stats.observedPartial'):m.status==='unavailable'?t(m.reason?.includes('fail')?'stats.readFailed':'stats.unavailable'):t('stats.complete')
function periodStatus(m:StatisticsMetric){
 if(m.status==='partial'&&m.value!==null&&m.reason==='before_forward_coverage'&&m.coverageStart){
  return t('stats.observedSince',{time:timestamp(m.coverageStart)})
 }
 return statusText(m)
}
function change(key:StatisticsCoreMetricKey){if(!data.value)return '';const result=comparison(data.value.metrics[key],data.value.previous[key],data.value.comparisonAvailable);return t(result.key,result.params)}
async function exportCSV(){
 if(!data.value||!checkIdentity()||!access.allowed.value||exporting.value)return
 const displayedRange={...data.value.range},bound=identity(),turn=generation;exportController?.abort();exportController=new AbortController();exporting.value=true;exportError.value=false
 try{const blob=await exportPlatformStatistics(displayedRange,exportController.signal);if(bound!==identity()||turn!==generation||exportController.signal.aborted||!access.allowed.value)return
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`pocketctl-statistics-${displayedRange.from}-${displayedRange.to}.csv`;link.click();URL.revokeObjectURL(url)
 }catch(error){if(bound!==identity()||turn!==generation)return;if(error instanceof PlatformStatisticsError&&[401,403].includes(error.status)){clear();access.invalidate()}else exportError.value=true}
 finally{if(bound===identity()&&turn===generation)exporting.value=false}
}
function focus(){if(!checkIdentity())void load(true);else void load(true)}
onMounted(()=>{void load(true);window.addEventListener('focus',focus);timer=setInterval(()=>{if(origin!==getRelayOrigin()){checkIdentity();void load(true)}},1000)})
onBeforeUnmount(()=>{clear();window.removeEventListener('focus',focus);if(timer)clearInterval(timer)})
</script>
<template>
 <main class="ps-page" data-testid="platform-statistics">
  <header class="ps-heading"><div><h1>{{t('stats.title')}}</h1><p>{{t('stats.subtitle')}}</p></div><div class="ps-actions"><span class="ps-private">{{t('stats.private')}}</span><button class="ps-btn" data-refresh :disabled="loading" @click="load(true)">{{t('stats.refresh')}}</button></div></header>
  <section v-if="denied" class="ps-state" role="alert"><h2>{{t('stats.denied')}}</h2><p>{{t('stats.deniedDescription')}}</p><RouterLink class="ps-btn" to="/">{{t('stats.back')}}</RouterLink></section>
  <template v-else>
   <div class="ps-filter"><div class="ps-segments" role="group" :aria-label="t('stats.dateRange')"><button v-for="p in ([1,7,30,'custom'] as const)" :key="p" class="ps-btn" :aria-pressed="p==='custom'?custom:period===p&&!custom" @click="selectPeriod(p)">{{t('stats.period'+p)}}</button></div><span class="ps-time">Asia/Shanghai · {{t('stats.beijingTime')}}</span></div>
   <div v-if="custom" class="ps-custom"><form @submit.prevent="applyDates"><label>{{t('stats.from')}}<input v-model="draft.from" type="date" :max="shanghaiToday()" required></label><label>{{t('stats.to')}}<input v-model="draft.to" type="date" :max="shanghaiToday()" required></label><button class="ps-btn" type="submit">{{t('stats.apply')}}</button></form><p v-if="dateError" class="ps-field-error" role="alert">{{t('stats.invalidDates')}}</p></div>
   <div class="ps-period"><span>{{data?.range.from??range.from}} — {{data?.range.to??range.to}} · {{t((data?.range.to??range.to)===shanghaiToday()?'stats.unfinishedDay':'stats.completeDays')}}</span><span v-if="data">{{t('stats.dataThrough')}} {{timestamp(data.dataThrough)}}</span></div>
   <p v-if="stale&&data" class="ps-notice is-warning" role="status" data-stale>{{t('stats.stale',{time:timestamp(data.dataThrough)})}}</p>
   <section v-if="!data&&loading" role="status" :aria-label="t('stats.loading')"><div class="ps-kpis"><div v-for="key in keys" :key="key" class="ps-skeleton"/></div><div class="ps-skeleton chart"/><p class="ps-muted">{{t('stats.loading')}}</p></section>
   <section v-else-if="!data" class="ps-state" role="alert"><h2>{{t('stats.loadFailed')}}</h2><p>{{t('stats.loadFailedDescription')}}</p><button class="ps-btn" @click="load(true)">{{t('stats.retry')}}</button></section>
   <template v-else>
    <p v-for="warning in data.warnings" :key="warning" class="ps-notice is-warning">{{sourceText(warning)}}</p>
    <section class="ps-kpis" :aria-label="t('stats.coreMetrics')"><button v-for="key in keys" :key="key" class="ps-kpi" :data-metric="key" :aria-pressed="selected===key" @click="selected=key"><span class="ps-kpi-label"><span>{{t('stats.'+key)}}</span><span>{{t('stats.unit.'+key)}} ↗</span></span><strong class="ps-value">{{metricValue(data.metrics[key])}}</strong><span class="ps-change">{{data.metrics[key].status==='complete'?change(key):periodStatus(data.metrics[key])}}</span><span class="ps-caption">{{t('stats.caption.'+key)}}</span></button></section>
    <section class="ps-panel"><header class="ps-panel-head"><div><h2>{{t('stats.'+selected)}}{{t('stats.trend')}}</h2><p>{{t('stats.daily')}} · {{chartCompare?`${data.previousRange.from} — ${data.previousRange.to}`:t('stats.notComparable')}}</p></div><div class="ps-legend"><span><i/>{{t('stats.current')}}</span><span v-if="chartCompare" class="previous"><i/>{{t('stats.previousAligned')}}</span></div></header><StatisticsChart :daily="data.daily" :previous="data.previousDaily" :metric="selected" :compare="chartCompare"/><p class="ps-chart-note">{{t(['activeUsers','sessions'].includes(selected)?'stats.nonadditive':'stats.firstOccurrence')}} {{t('stats.gaps')}}</p></section>
    <h2 class="ps-memory-title">{{t('stats.memorySection')}}</h2><div class="ps-memory"><section class="ps-panel"><header class="ps-panel-head"><div><h2>{{t('stats.formalKnowledge')}}</h2><p>{{t('stats.sameMemoryDefinition')}}</p></div></header><div class="ps-panel-body"><div class="ps-output-total"><strong>{{metricValue(data.metrics.memory)}}</strong><span>{{statusText(data.metrics.memory)}}</span></div><div v-if="data.metrics.memory.status==='complete'&&data.metrics.memory.value" class="ps-meter" aria-hidden="true"><i v-for="source in sources" :key="source" :style="{width:`${(data.memorySources[source].value??0)/data.metrics.memory.value*100}%`}"/></div><dl><div v-for="source in sources" :key="source" class="ps-fact"><dt>{{t('stats.'+source)}}</dt><dd>{{metricValue(data.memorySources[source])}} <small v-if="data.memorySources[source].status!=='complete'">{{statusText(data.memorySources[source])}}</small></dd></div></dl><p class="ps-muted">{{t('stats.memoryExclusions')}}</p></div></section><section class="ps-panel"><header class="ps-panel-head"><div><h2>{{t('stats.memoryUsage')}}</h2><p>{{t('stats.separateUsage')}}</p></div></header><div class="ps-panel-body"><dl><div v-for="key in (['memoryUsers','readRequests'] as const)" :key="key" class="ps-fact"><dt>{{t('stats.'+key)}}</dt><dd>{{metricValue(data.metrics[key])}} <small v-if="data.metrics[key].status!=='complete'">{{statusText(data.metrics[key])}}</small></dd></div><div class="ps-fact"><dt>{{t('stats.actualUse')}}</dt><dd class="ps-unconfirmed">{{t('stats.unconfirmed')}}</dd></div></dl><p class="ps-muted">{{t('stats.useCaveat')}}</p></div></section></div>
    <details class="ps-details" :open="dailyOpen" @toggle="dailyOpen=($event.target as HTMLDetailsElement).open"><summary>{{t('stats.dailyDetails')}}<span>{{t('stats.dailyDetailsCaption')}}</span></summary><div class="ps-table-wrap"><table class="ps-table"><caption class="sr-only">{{t('stats.tableCaption')}}</caption><thead><tr><th scope="col">{{t('stats.date')}}</th><th v-for="key in keys" :key="key" scope="col">{{t('stats.'+key)}} ({{t('stats.unit.'+key)}})</th></tr></thead><tbody><tr v-for="row in data.daily" :key="row.date"><th scope="row">{{row.date}}</th><td v-for="key in keys" :key="key" :title="statusText(row[key])">{{row[key].value===null?statusText(row[key]):metricValue(row[key])}}<small v-if="row[key].value!==null&&row[key].status!=='complete'"> · {{statusText(row[key])}}</small></td></tr></tbody></table></div><footer class="ps-data-foot"><span>{{t('stats.nonadditive')}}</span><button class="ps-btn" data-export :disabled="exporting||loading" @click="exportCSV">{{t(exporting?'stats.exporting':'stats.export')}}</button></footer><p v-if="exportError" class="ps-notice is-warning" role="alert">{{t('stats.exportFailed')}}</p></details>
    <details class="ps-details" :open="defsOpen" @toggle="defsOpen=($event.target as HTMLDetailsElement).open"><summary>{{t('stats.definitions')}}<span>{{t('stats.definitionsCaption')}}</span></summary><div class="ps-defs"><section v-for="key in definitionKeys" :key="key"><h3>{{t('stats.'+key)}}</h3><p>{{t('stats.definition.'+key)}}</p><p>{{statusText(data.metrics[key])}} · {{t('stats.coverageStart')}} {{data.metrics[key].coverageStart?timestamp(data.metrics[key].coverageStart!):t('stats.unavailable')}}</p><p v-if="data.metrics[key].reason">{{sourceText(data.metrics[key].reason!)}}</p></section></div><div class="ps-coverage">{{data.definitionVersion}} · {{data.timezone}} · {{t('stats.dataThrough')}} {{timestamp(data.dataThrough)}}<p v-for="exclusion in data.exclusions" :key="exclusion">{{sourceText(exclusion)}}</p></div></details>
   </template>
  </template>
 </main>
</template>
