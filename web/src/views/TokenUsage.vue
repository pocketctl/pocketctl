<script setup lang="ts">
import {formatUsageTokens as token, formatUsageShare as percent, formatUsageWithShare, hasChartableComposition, dashboardComposition} from '../utils/usageTokenFormat'
import {computed,onMounted,onBeforeUnmount,ref,nextTick,watch} from 'vue'
import {useRoute} from 'vue-router'
import {useUsageText} from '../composables/useUsageText'
import {usePersonalUsage} from '../composables/usePersonalUsage'
import UsageHeatmap from '../components/usage/UsageHeatmap.vue'
import UsagePeriodPopover from '../components/usage/UsagePeriodPopover.vue'
import UsageTrend from '../components/usage/UsageTrend.vue'
import '../components/usage/usage.css'
const tr=useUsageText()
const route=useRoute(),u=usePersonalUsage(typeof route.query.daemon==='string'?route.query.daemon:'all')
const {daemon,range,tab,category,page,search,dashboard:d,hosts,summary,meta,calls,sessions,loading,error}=u
const panelMeta = computed(() => {
  if (tab.value === 'tokens') return d.value?.meta
  return (tab.value === 'calls' ? calls.value : sessions.value)?.meta
})
const displayedError = computed(() => ['personal_usage_not_enabled', 'upgrade_required'].includes(error.value)
  ? tr('服务需升级或开启个人用量统计') : error.value)
const periodPopover=ref<InstanceType<typeof UsagePeriodPopover>|null>(null)
function openPeriod(bucket: any, event: Event, type = 'tokens') {
  ++modalSequence
  u.cancelDetail()
  periodPopover.value?.open(bucket, event, type, hostName.value)
}
const dimension=ref('host'),dialog=ref<HTMLDialogElement|null>(null),detail=ref<any>(null),detailTitle=ref(''),hostOpen=ref(false);let trigger:HTMLElement|null=null;let modalSequence=0
const panel=ref<HTMLElement|null>(null),panelHeight=ref(0);let panelObserver:ResizeObserver|undefined
watch(panel,el=>{panelObserver?.disconnect();if(el&&typeof ResizeObserver!=='undefined'){panelObserver=new ResizeObserver(()=>{panelHeight.value=Math.max(panelHeight.value,el.scrollHeight)});panelObserver.observe(el)}});onBeforeUnmount(()=>panelObserver?.disconnect())
const ranges=computed(()=>[['today',tr('今日')],['7d',tr('近7天')],['14d',tr('近14天')],['30d',tr('近30天')],['all',tr('全部（近365天）')]])
const hostName=computed(()=>daemon.value==='all'?tr('全部主机'):hosts.value?.find(h=>h.daemon_id===daemon.value)?.name??daemon.value)
const fmt=(n:any)=>n===null||n===undefined?'—':BigInt(n).toLocaleString()
const coverageLabel=(v:string)=>({complete:tr('完整覆盖'),partial:tr('部分覆盖'),not_collected:tr('尚未采集'),unknown:tr('覆盖未知')} as Record<string,string>)[v]??v
const composition = computed(() => d.value ? dashboardComposition(d.value.analysis, d.value.composition) : { rows: [], chartable: false })
const compositionGradient = computed(() => {
  const total = d.value?.analysis.total
  if (!total || !composition.value.chartable) return null
  let sum = 0n
  const stops = composition.value.rows.map(({ key, value }) => {
    const start = sum
    sum += BigInt(value!)
    return `${colors[key]} ${Number(start) / Number(total) * 100}% ${Number(sum) / Number(total) * 100}%`
  })
  return `conic-gradient(${stops.join(', ')})`
})
const colors:Record<string,string>={input:'var(--accent)',output:'#a0b6ec',cache_read:'#16805e',cache_create:'#7caa8c',unknown_total:'var(--muted)'}
const labels=computed<Record<string,string>>(()=>({input:tr('输入'),output:tr('输出'),cache_read:tr('缓存读取'),cache_create:tr('缓存写入'),unknown_total:tr('未确认构成'),total:tr('总量'),requests:tr('模型请求'),tools:tr('工具调用'),mcp:tr('MCP调用'),skills:tr('Skill执行'),success:tr('成功'),failure:tr('失败'),unknown:tr('结果未知'),count:tr('次数'),sessions:tr('相关会话')}))
async function show(title: string, value: any, anchor: HTMLElement | null = null) {
  const sequence = ++modalSequence
  u.cancelDetail()
  trigger = anchor ?? document.activeElement as HTMLElement | null
  detailTitle.value = title
  detail.value = value
  await nextTick()
  if (sequence === modalSequence && !dialog.value?.open) dialog.value?.showModal()
}

function close() {
  ++modalSequence
  u.cancelDetail()
  periodPopover.value?.close()
  if (dialog.value?.open) {
    dialog.value.close()
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  trigger = null
  detailTitle.value = ''
  detail.value = null
}

async function showDetail(
  path: string,
  event: Event,
  present: (data: any) => { title: string; value: any } | undefined,
) {
  const sequence = ++modalSequence
  const anchor = event.currentTarget as HTMLElement | null
  try {
    const data = await u.detail(path)
    if (sequence !== modalSequence) return
    const modal = present(data)
    if (modal) await show(modal.title, modal.value, anchor)
  } catch {
    // The composable reports failures only while the request is current.
  }
}

function sessionDetail(row: any, event: Event) {
  return showDetail('/api/tokens/session/' + encodeURIComponent(row.session_id) + '/trend', event, data => {
    const session = data.sessions[0]
    if (session) return { title: session.title ?? session.session_id, value: { session } }
  })
}
function callDetail(row: any, event: Event) {
  return showDetail('/api/usage/calls/' + row.object_id, event, data => ({
    title: data.object.name,
    value: {
      call: data.object,
      related: data.related_query,
      callType: category.value === 'skills' ? 'skills' : data.object.mcp_server ? 'mcp' : 'tools',
    },
  }))
}
function coverage(event: Event) {
  return showDetail('/api/usage/coverage', event, data => ({ title: tr('数据覆盖'), value: data }))
}

watch([daemon, range, tab, category, page, search, u.association], close)
watch(summary, (value, previous) => { if (!value && previous) close() })
watch(() => route.query.daemon, host => { daemon.value = typeof host === 'string' ? host : 'all' })
function related(){u.association.value=detail.value.related;tab.value='sessions';page.value=1;close()}
onMounted(u.load)
</script>
<template>
<div class="page-wrap design-surface content tokens-page pu">
  <div class="pu-filters">
    <label>{{tr('主机')}}
      <select v-model="daemon" :aria-label="tr('统计主机')">
        <option value="all">{{tr('全部主机')}}</option>
        <option v-for="h in hosts" :key="h.daemon_id" :value="h.daemon_id">{{h.name}}{{h.historical?tr(' · 历史'):''}}</option>
      </select>
    </label>
    <span class="pu-note">{{tr('个人账户 · UTC')}}</span>
  </div>
  <div v-if="error && !summary" role="alert" class="pu-banner">
    {{displayedError}}<button @click="u.load">{{tr('重试')}}</button>
  </div>
  <div v-if="loading && !summary" role="status">{{tr('正在加载用量…')}}</div>
  <template v-if="summary">
    <div class="pu-banner">
      {{tr('已确认小计，历史与采集缺口不视为0。')}}<button :disabled="!meta" @click="coverage">{{tr('数据覆盖')}}</button>
    </div>
    <div class="pu-overview">
      <article v-for="([key,title,sub]) in [['all',tr('总消耗'),tr('近365天')],['today',tr('今日消耗'),tr('今日00:00起 · UTC')],['7d',tr('近7天'),tr('含今日')],['30d',tr('近30天'),tr('含今日')]]" :key="key" class="pu-summary">
        <span>{{title}}</span><b>{{token(summary.overview[key]?.total)}}</b><small>{{sub}}</small>
      </article>
    </div>
    <UsageHeatmap :data="summary.heatmap" @select="(b,e)=>openPeriod(b,e)"/>
  </template>
  <template v-if="hosts">
    <nav class="pu-tabs" role="tablist">
      <button v-for="([key,label]) in [['tokens',tr('用量分析')],['calls',tr('调用统计')],['sessions',tr('会话明细')]]" :key="key"
        role="tab" :aria-selected="tab===key" :class="{active:tab===key}" @click="tab=key;page=1">{{label}}</button>
    </nav>
    <div class="pu-range">
      <div>
        <h2>{{hostName}}</h2>
        <small><template v-if="panelMeta">{{panelMeta.requested_from.slice(0,10)}} — {{panelMeta.as_of.slice(0,10)}} · UTC · {{coverageLabel(panelMeta.coverage)}}</template></small>
      </div>
      <select v-model="range" :aria-label="tr('分析时间范围')">
        <option v-for="[key,label] in ranges" :key="key" :value="key">{{label}}</option>
      </select>
    </div>
    <div ref="panel" :style="{minHeight:panelHeight+'px'}">
      <div v-if="error && summary" role="alert" class="pu-banner">
        {{displayedError}}<button @click="u.load">{{tr('重试')}}</button>
      </div>
      <p v-if="tab==='tokens' && summary && !d && !error" role="status" class="pu-pad">{{tr('正在加载用量…')}}</p>
<template v-if="tab==='tokens' && d"><section class="pu-box"><header class="pu-boxhead"><h3>{{range==='today'?tr('今日用量构成'):{day:tr('每日用量'),week:tr('每周用量'),month:tr('每月用量')}[d.analysis.granularity as string]}}</h3><small>{{tr('图表起点')}} {{d.meta.display_from.slice(0,10)}}</small></header><div class="pu-pad"><div class="pu-statline">
  <div v-for="part in composition.rows" :key="part.key">
    <span>{{labels[part.key]}}</span><b :title="fmt(part.value)">{{formatUsageWithShare(part.value,d.analysis.total)}}</b>
  </div>
  <div><span>{{labels.total}}</span><b>{{token(d.analysis.total)}}</b></div>
  <div><span>{{labels.requests}}</span><b>{{fmt(d.analysis.requests)}}</b></div>
</div><UsageTrend v-if="range!=='today'" :series="d.analysis.series" @select="(b,e)=>openPeriod(b,e)"/><template v-else><div v-if="compositionGradient" class="pu-composition-bar"><i v-for="part in composition.rows" :key="part.key" :style="{background:colors[part.key],width:(Number(part.value)/Number(d.analysis.total)*100)+'%'}"/></div><p class="pu-note">{{tr('UTC今日00:00至更新时刻，当日尚未结束。')}}</p></template></div></section><div class="pu-two"><section class="pu-box"><header class="pu-boxhead"><h3>{{tr('用量分布')}}</h3><div class="pu-segment"><button v-for="[key,label] in [['host',tr('主机')],['agent','Agent'],['model',tr('模型')]]" :key="key" :class="{active:dimension===key}" :aria-pressed="dimension===key" @click="dimension=key">{{label}}</button></div></header><div class="pu-pad"><div v-for="row in d.distributions[dimension]" :key="row.id" class="pu-kv"><button v-if="dimension==='host'" class="pu-reset" @click="daemon=row.id">{{hosts?.find(h=>h.daemon_id===row.id)?.name??row.name}} ›</button><span v-else>{{row.name==='unknown'?tr('未知 / 未归属'):row.name}}</span><div class="pu-track" style="flex:1;margin:0 15px"><i v-if="percent(row.total,d.analysis.total)" :style="{width:percent(row.total,d.analysis.total)}"/></div><b>{{formatUsageWithShare(row.total,d.analysis.total)}}</b></div><p class="pu-note">{{tr('所有分类均列出，包含未知项。未归属：')}}{{token(d.unattributed_total)}}</p></div></section><section class="pu-box"><header class="pu-boxhead"><h3>{{tr('Token构成')}}</h3><button class="pu-reset" @click="show(tr('统计说明'),{definitions:true},$event.currentTarget as HTMLElement)">{{tr('统计说明')}}</button></header><div class="pu-pad"><div v-if="compositionGradient" class="pu-donut" :style="{background: compositionGradient}">
  <div><b>{{token(d.analysis.total)}}</b><small>{{tr('所选区间')}}</small></div>
</div>
<div v-else class="pu-total pu-unconfirmed-composition">
  <span>{{tr('所选区间')}}</span><strong>{{token(d.analysis.total)}}</strong>
  <small v-if="!composition.rows.some(row => row.key==='unknown_total') && (d.analysis.total!=='0' || !composition.rows.length || composition.rows.some(row => row.value==null))">{{tr('未确认构成')}}</small>
</div>
<template v-if="composition.rows.length">
  <div v-for="part in composition.rows" :key="part.key" class="pu-kv">
    <span><i v-if="composition.chartable" class="pu-part-color" :style="{background:colors[part.key]}"/>{{labels[part.key]}}</span>
    <b :title="fmt(part.value)">{{formatUsageWithShare(part.value, d.analysis.total)}}</b>
  </div>
  <p class="pu-note">{{tr('未知组件保持 —；缓存已按来源归一化；不重复相加reasoning。')}}</p>
</template></div></section></div></template>
<template v-if="tab==='calls'"><template v-if="calls"><div class="pu-callcards" :data-category="calls.category"><button v-for="k in ['tools','mcp','skills']" :key="k" class="pu-callcard" :class="{active:category===k}" @click="category=k;page=1"><span>{{labels[k]}}</span><b>{{fmt(calls.summary[k])}}</b><small>{{k==='mcp'?tr('已包含在工具调用'):k==='skills'?tr('仅明确执行证据'):tr('含MCP；不与Skill求和')}}</small></button></div><section class="pu-box"><header class="pu-boxhead"><h3>{{range==='today'?tr('今日调用构成'):tr('调用次数趋势')}}</h3></header><div class="pu-pad"><UsageTrend v-if="range!=='today'" mode="calls" :series="calls.series" @select="(b,e)=>openPeriod(b,e,'calls')"/><template v-else><div v-if="['builtin','mcp','unclassified'].every(key => percent(calls.summary[key], calls.summary.tools))" class="pu-composition-bar" data-testid="today-call-composition"><i v-for="(k,i) in ['builtin','mcp','unclassified']" :key="k" :style="{width:percent(calls.summary[k],calls.summary.tools),background:['var(--accent)','#16805e','#999'][i]}"/></div><div v-for="k in ['builtin','mcp','unclassified','skills']" :key="k" class="pu-kv"><span>{{({builtin:tr('内置工具'),mcp:'MCP',unclassified:tr('未分类'),skills:tr('Skill（独立）')} as any)[k]}}</span><b>{{k==='skills'?fmt(calls.summary[k]):formatUsageWithShare(calls.summary[k],calls.summary.tools,fmt)}}</b></div><p class="pu-note">{{tr('更新时刻')}} {{calls.meta.as_of}} · {{tr('UTC今日00:00至更新时刻，当日尚未结束。')}}</p></template><p class="pu-note">{{coverageLabel(calls.coverage)}} · {{tr('没有连续覆盖证明时仅展示已确认小计。')}}</p></div></section><section class="pu-box"><button v-for="row in calls.ranking" :key="row.object_id" class="pu-listrow" @click="callDetail(row,$event)"><div><b>{{row.name}}</b><small>{{row.mcp_server}}</small></div><span>{{fmt(row.count)}} ›</span></button><p v-if="!calls.ranking.length" class="pu-pad">{{tr('尚未采集明确调用记录。')}}</p><div class="pu-pagination"><span>{{calls.total}} {{tr('个对象')}}</span><button :disabled="page===1" @click="page--">{{tr('上一页')}}</button><span>{{page}}</span><button :disabled="page*20>=calls.total" @click="page++">{{tr('下一页')}}</button></div></section></template><p v-else-if="summary && !error" role="status">{{tr('正在加载调用…')}}</p></template>
<template v-if="tab==='sessions'"><input v-model="search" @input="page=1" class="pu-search" :aria-label="tr('搜索会话')" :placeholder="tr('搜索会话')"/><button v-if="Object.keys(u.association.value).length" class="pu-reset" @click="u.association.value={}">{{tr('清除调用关联')}}</button><section class="pu-box"><template v-if="sessions"><table class="pu-table"><thead><tr><th>{{tr('会话')}}</th><th class="pu-wide">{{tr('主机')}} / Agent</th><th class="pu-wide">{{tr('模型')}}</th><th class="pu-wide">{{tr('状态')}}</th><th>{{tr('总量')}}</th><th class="pu-wide">{{tr('最后活跃')}}</th></tr></thead><tbody><tr v-for="s in sessions.sessions" :key="s.session_id"><td><button @click="sessionDetail(s,$event)"><b>{{s.title||s.session_id}}</b><small class="pu-narrow-meta">{{hosts?.find(h=>h.daemon_id===s.daemon_id)?.name??tr('历史主机')}} · {{s.agent_type}} · {{s.models.join(' / ')}} · {{s.archived?tr('已归档'):s.status}}</small></button></td><td class="pu-wide">{{hosts?.find(h=>h.daemon_id===s.daemon_id)?.name??tr('历史主机')}}<small>{{s.agent_type}}</small></td><td class="pu-wide">{{s.models.join(' / ')||tr('未知 / 未归属')}}</td><td class="pu-wide">{{s.archived?tr('已归档'):s.status}}</td><td class="pu-num">{{token(s.total)}}</td><td class="pu-wide">{{s.updated_at??'—'}}</td></tr></tbody></table><p v-if="!sessions.total" class="pu-pad">{{tr('所选范围无可归属会话。')}}</p><div class="pu-pagination"><span>{{tr('共')}} {{sessions.total}} {{tr('个会话')}}</span><button :disabled="page===1" @click="page--">{{tr('上一页')}}</button><span>{{page}}</span><button :disabled="page*20>=sessions.total" @click="page++">{{tr('下一页')}}</button></div></template><p v-else-if="summary && !error" role="status" class="pu-pad">{{tr('正在加载会话…')}}</p></section></template></div></template>
<dialog ref="dialog" class="pu-dialog pu-refined" :class="{'pu-dialog-wide':detail?.session}" aria-labelledby="usage-detail-title" @cancel.prevent="close" @click="($event.target===dialog)&&close()"><header class="pu-modal-head"><div><span class="pu-eyebrow">{{tr(detail?.definitions?'统计说明':detail?.session?'会话用量':detail?.call?'调用详情':'数据覆盖')}}</span><h2 id="usage-detail-title">{{detailTitle}}</h2></div><button class="pu-icon-close" :aria-label="tr('关闭')" @click="close">×</button></header><section class="pu pu-modal-body"><div class="pu-chips"><span>{{hostName}}</span><span>{{ranges.find(r=>r[0]===range)?.[1]}}</span><span>UTC</span></div><template v-if="detail?.definitions"><div class="pu-callout"><b>{{tr('统一计算口径')}}</b><p>{{tr('未采集不等于0。历史未知模型、组件和请求身份保持未知；模型请求数不以usage块数替代。')}}</p></div><section class="pu-modal-section"><h3>{{tr('Token 如何计算')}}</h3><div class="pu-formula"><strong>{{tr('总量')}}</strong><span>=</span><b>{{tr('输入')}}</b><span>+</span><b>{{tr('输出')}}</b><span>+</span><b>{{tr('缓存读取')}}</b><span>+</span><b>{{tr('缓存写入')}}</b></div><p>{{tr('总量 = 输入 + 输出 + 缓存读取 + 缓存写入。缓存包含在上游输入时先归一化；reasoning不重复加到output。')}}</p></section><section class="pu-modal-section"><h3>{{tr('时间与对比')}}</h3><p>{{tr('全部与总消耗限定最近365个UTC自然日含今日；热力图独立90天。概览只随主机筛选变化。')}}</p></section><section class="pu-modal-section"><h3>{{tr('调用次数单独统计')}}</h3><div class="pu-callout"><b>{{tr('MCP是工具调用的子集')}}</b><p>{{tr('MCP是工具子集，Skill独立计数；读取SKILL.md、安装、列出和文字提及均不算执行。启动已确认不等于完成。')}}</p></div></section></template><template v-else-if="detail?.call"><div class="pu-hero"><div><span>{{tr(detail.callType==='skills'?'Skill执行':detail.callType==='mcp'?'MCP调用':'工具调用')}}</span><strong>{{fmt(detail.call.count)}} <small>{{tr('次数')}}</small></strong></div><span class="pu-status neutral">{{tr(detail.callType==='skills'?'仅明确执行证据':detail.callType==='mcp'?'已包含在工具调用':'调用去重')}}</span></div><div v-if="detail.callType==='skills'" class="pu-callout"><b>{{tr('启动已确认，完成状态未确认')}}</b><p>{{tr('MCP是工具子集，Skill独立计数；读取SKILL.md、安装、列出和文字提及均不算执行。启动已确认不等于完成。')}}</p></div><section v-else class="pu-modal-section"><h3>{{tr('调用结果')}}</h3><div class="pu-outcomes"><div v-for="(k,i) in ['success','failure','unknown']" :key="k"><span class="pu-status" :class="['good','bad','neutral'][i]">{{labels[k]}}</span><strong>{{fmt(detail.call[k])}}</strong><small v-if="percent(detail.call[k],detail.call.count)">{{percent(detail.call[k],detail.call.count)}}</small></div></div></section><section class="pu-modal-section"><h3>{{tr('统计边界')}}</h3><dl class="pu-facts"><div><dt>Token</dt><dd>{{tr('未提供，不做分摊估算')}}</dd></div><div><dt>{{tr('统计范围')}}</dt><dd>{{tr('仅保留身份、名称、结果与计数。不提供工具或Skill独立Token分摊。')}}</dd></div></dl></section><section class="pu-modal-section"><h3>{{tr('相关会话')}}</h3><div class="pu-related-list"><button @click="related"><span><b>{{tr('查看相关会话 ›')}}</b><small>{{fmt(detail.call.sessions)}} {{tr('个会话')}}</small></span></button></div></section></template><template v-else-if="detail?.session"><dl class="pu-facts pu-session-meta"><div v-for="[label,value] in [[tr('主机'),hosts?.find(h=>h.daemon_id===detail.session.daemon_id)?.name??tr('历史主机')],['Agent',detail.session.agent_type??tr('未知 / 未归属')],[tr('模型'),detail.session.models?.join(' / ')||tr('未知 / 未归属')],[tr('状态'),detail.session.archived?tr('已归档'):detail.session.status??tr('未知 / 未归属')]]" :key="label"><dt>{{label}}</dt><dd>{{value}}</dd></div></dl><div class="pu-hero"><div><span>{{tr('所选区间')}}</span><strong>{{token(detail.session.total)}} <small>Token</small></strong></div><small>{{tr('最后活跃')}} {{detail.session.updated_at??'—'}}</small></div><section class="pu-modal-section"><h3>{{tr('用量构成')}}</h3><div v-if="hasChartableComposition(detail.session)" class="pu-composition-bar"><i v-for="k in ['input','output','cache_read','cache_create']" :key="k" :style="{background:colors[k],width:percent(detail.session[k],detail.session.total)}"/></div><div class="pu-kv" v-for="k in ['input','output','cache_read','cache_create','requests']" :key="k"><span>{{labels[k]}}</span><b>{{k==='requests'?fmt(detail.session[k]):token(detail.session[k])}}</b></div></section><div v-if="detail.session.archived" class="pu-callout"><b>{{tr('已归档')}}</b><p>{{tr('已归档，正文可能不可用')}}</p></div><section class="pu-modal-section"><h3>{{tr('Token趋势')}}</h3><UsageTrend :series="detail.session.series??[]" @select="(b,e)=>openPeriod(b,e)"/></section><details class="pu-subagents"><summary>{{tr('子Agent拆分（已包含）')}}</summary><div v-for="c in detail.session.children" :key="c.agent_id" class="pu-kv">{{c.agent_id}} {{token(c.total)}}</div><p v-if="!detail.session.children?.length">{{tr('无可用子Agent拆分')}}</p></details></template><template v-else-if="detail?.callPeriod"><p>{{detail.callPeriod.bucket_start}} — {{detail.callPeriod.end_exclusive}} · UTC · {{coverageLabel(detail.callPeriod.coverage)}}</p><div v-for="k in ['tools','mcp','skills']" :key="k" class="pu-kv"><span>{{labels[k]}}</span><b>{{fmt(detail.callPeriod[k])}}</b></div><p>{{tr('MCP已含在工具中；Skill独立。当前范围不变。')}}</p></template><template v-else-if="detail?.amount"><p>{{detail.amount.bucket_start??detail.amount.date}} — {{detail.amount.end_exclusive??''}} · UTC · {{coverageLabel(detail.amount.coverage)}}</p><div v-for="k in ['input','output','cache_read','cache_create','total','requests']" :key="k" class="pu-kv"><span>{{labels[k]}}</span><b>{{k==='requests'?fmt(detail.amount[k]):token(detail.amount[k])}}</b></div></template><template v-else><div class="pu-callout"><b>{{tr('已确认小计，历史与采集缺口不视为0。')}}</b><p>{{tr('只依据可靠源游标和连续覆盖记录判定完整。旧daemon、离线、重连、源时间缺失及不支持的Skill均可能留有缺口。')}}</p></div><section class="pu-modal-section"><h3>{{tr('同步与采集范围')}}</h3><div class="pu-coverage-list"><div v-for="(row,i) in detail?.coverage??[]" :key="i" class="pu-kv"><div><b>{{hosts?.find(h=>h.daemon_id===row.daemon_id)?.name??row.daemon_id}} · {{row.agent_type==='unknown'?tr('未知 / 未归属'):row.agent_type}} · {{tr(row.capability)}}</b><p>{{tr(row.reason)}}</p><small>{{tr('已观察记录起点')}} {{row.from_at??'—'}} · {{tr('最后同步')}} {{row.last_synced_at??'—'}}</small></div><span>{{coverageLabel(row.state)}}</span></div></div></section><p v-if="!detail?.coverage?.length">{{tr('尚无连续采集覆盖证明；已确认记录作为部分小计。')}}</p></template></section><footer class="pu-modal-footer"><span>{{tr('个人账户 · UTC')}}</span><button @click="close">{{tr('完成')}}</button></footer></dialog><UsagePeriodPopover ref="periodPopover"/></div></template>
<style scoped>.pu{--p-bg:var(--panel,var(--bg-card));--p-text:var(--text,var(--ink));--p-accent:var(--accent);--p-line:var(--border);--p-soft:var(--bg-secondary)}select{background:var(--panel);color:inherit;border:1px solid var(--border);padding:8px;border-radius:8px}.pu-modal-head h2{font-size:20px}.pu-modal-head button{margin-left:auto}.pu-summary b{font-size:clamp(17px,2vw,28px)}.pu-modal-body{color:inherit}.pu-listrow small{overflow-wrap:anywhere}.pu-boxhead h3{margin:0}.pu-part-color{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px}.pu-unconfirmed-composition{margin-bottom:16px}.pu-range small{display:block;min-height:1.4em}</style>
