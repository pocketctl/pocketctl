<template>
  <div class="page-wrap">
    <div class="page-header">
      <div>
        <h2 class="page-title">{{ t('token.title') }}</h2>
        <div class="page-subtitle">{{ t('token.recent_days', { n: dailySeries.length, host: hostLabel }) }}</div>
      </div>
      <div class="host-select-wrap">
        <button class="host-select-btn" @click="hostMenuOpen = !hostMenuOpen">
          {{ hostLabel }} <span class="chevron">▾</span>
        </button>
        <div class="host-select-menu" :class="{ open: hostMenuOpen }">
          <button :class="{ active: selectedHost === 'all' }" @click="selectHost('all')">{{ t('token.all_hosts') }}</button>
          <button v-for="d in byDaemon" :key="d.daemon_id" :class="{ active: selectedHost === d.daemon_id }" @click="selectHost(d.daemon_id)">
            {{ d.alias || d.hostname || d.daemon_id.slice(0, 8) }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="error" class="token-error">
      <div>
        <div class="token-error-msg">{{ error }}
          <a v-if="error === t('token.error_auth_expired')" href="/app/login" style="color:var(--accent);margin-left:8px;text-decoration:underline;">{{ t('token.relogin') }}</a>
        </div>
        <div v-if="errorDetail" class="token-error-detail">{{ errorDetail }}</div>
      </div>
      <button class="token-error-retry" @click="loadDashboard">{{ t('common.retry') }}</button>
    </div>

    <div v-if="loading" class="token-loading">{{ t('token.loading') }}</div>

    <template v-if="!error">

    <div class="token-summary">
      <div class="tk-item"><div class="tk-num">{{ fmt(totalTokens) }}</div><div class="tk-label">{{ t('token.total') }} <span class="tk-sub" :title="t('token.incl_subagent')">·{{ t('token.incl_subagent_short') }}</span></div></div>
      <div class="tk-item"><div class="tk-num">{{ fmt(summary.today) }}</div><div class="tk-label">{{ t('token.today') }}</div></div>
      <div class="tk-item"><div class="tk-num">{{ fmt(summary.thisWeek) }}</div><div class="tk-label">{{ t('token.last_7d') }}</div></div>
      <div class="tk-item"><div class="tk-num">{{ fmt(summary.thisMonth) }}</div><div class="tk-label">{{ t('token.last_30d') }}</div></div>
    </div>

    <div class="metric-grid">
      <div class="metric-card"><div class="mc-label">{{ t('token.input') }}</div><div class="mc-value">{{ fmt(totalInput) }}</div><div class="mc-sub">{{ t('token.with_cache', { n: fmt(totalCache) }) }}</div></div>
      <div class="metric-card"><div class="mc-label">{{ t('token.output') }}</div><div class="mc-value">{{ fmt(totalOutput) }}</div><div class="mc-sub">{{ t('token.per_request', { n: fmt(avgOutputPerReq) }) }}</div></div>
      <div class="metric-card"><div class="mc-label">{{ t('token.cache') }}</div><div class="mc-value">{{ fmt(totalCache) }}</div><div class="mc-sub">{{ t('token.cache_rate', { n: cacheRate }) }}</div></div>
      <div class="metric-card"><div class="mc-label">{{ t('token.requests') }}</div><div class="mc-value">{{ fmt(totalRequests) }}</div><div class="mc-sub">{{ t('token.daily_avg', { n: fmt(dailyAvgReq) }) }}</div></div>
      <div class="metric-card"><div class="mc-label">{{ t('token.hosts_count') }}</div><div class="mc-value">{{ byDaemon.length }}</div><div class="mc-sub">{{ t('token.hosts_usage') }}</div></div>
      <div class="metric-card"><div class="mc-label">{{ t('token.top_model') }}</div><div class="mc-value">{{ topModel?.model || '—' }}</div><div class="mc-sub">{{ t('token.share_pct', { n: topModel?.pct || 0 }) }}</div></div>
    </div>

    <div class="chart-section">
      <div class="chart-section-title">{{ t('token.daily_chart') }}
        <div class="chart-section-legend"><span class="le-dot" style="background:var(--accent);opacity:0.7;"></span> {{ t('token.input') }} <span class="le-dot" style="background:var(--success);opacity:0.7;"></span> {{ t('token.output') }}</div>
      </div>
      <div class="chart-container">
        <div class="bar-chart">
          <div v-for="d in barData" :key="d.date" class="bar-day" @mouseleave="tooltip = null">
            <div class="bar-col output" :style="{ height: barHeight(d.output) + 'px' }"
                 @mouseenter="showTooltip($event, { date: d.date, input: 0, output: d.output, cache_read: d.cache_read, requests: d.requests })"></div>
            <div class="bar-col input" :style="{ height: barHeight(d.input) + 'px' }"
                 @mouseenter="showTooltip($event, { date: d.date, input: d.input, output: 0, cache_read: d.cache_read, requests: d.requests })"></div>
          </div>
        </div>
        <div class="bar-label-row">
          <span v-for="(d, i) in barData" :key="d.date" :class="{ show: i % 7 === 0 || i === barData.length - 1 }">{{ labelDate(d.date) }}</span>
        </div>
      </div>
    </div>

    <div class="two-col">
      <div class="chart-section">
        <div class="chart-section-title">{{ t('token.model_dist') }}</div>
        <div class="chart-container">
          <div class="donut-wrap">
            <div class="donut-ring" :style="{ background: donutGradient }">
              <div class="donut-center"><div class="dc-total">{{ fmt(donutTotal) }}</div><div class="dc-label">{{ t('token.token_total') }}</div></div>
            </div>
            <div class="donut-legend">
              <div v-for="(m, i) in topModels" :key="m.model" class="dl-item">
                <span class="dl-swatch" :style="{ background: rankColor(i) }"></span>{{ m.model }} {{ m.pct }}%
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="chart-section">
        <div class="chart-section-title">{{ t('token.heatmap_title') }}</div>
        <div class="chart-container">
          <div class="heatmap-legend-bar"><span class="hm-label">{{ t('token.less') }}</span><div class="hm-gradient"><span></span><span></span><span></span><span></span><span></span></div><span class="hm-label">{{ t('token.more') }}</span></div>
          <div class="heatmap-wrap" @mouseleave="tooltip = null">
            <div v-for="col in heatmapCols" :key="col.key" class="heatmap-col">
              <div v-for="cell in col.cells" :key="cell.date || cell.key"
                   class="heatmap-cell" :class="cell.level ? 'l' + cell.level : ''"
                   :data-date="cell.date || null"
                   @mouseenter="cell.date && showTooltip($event, heatmapCellData(cell))"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="chart-section">
      <div class="chart-section-title">{{ selectedHost === 'all' ? t('token.host_dim') : t('token.session_detail') }}</div>
      <div v-if="selectedHost === 'all'" class="usage-table">
        <div class="usage-table-header"><span>{{ t('token.host') }}</span><span>{{ t('token.input') }}</span><span>{{ t('token.output') }}</span><span>{{ t('token.cache') }}</span><span>{{ t('token.requests') }}</span><span style="text-align:right;">{{ t('token.amount') }}</span></div>
        <div v-for="h in byDaemon" :key="h.daemon_id" class="usage-table-row">
          <span class="ut-host">{{ h.alias || h.hostname || h.daemon_id.slice(0, 8) }}</span>
          <span class="ut-num">{{ fmt(h.input) }}</span><span class="ut-num">{{ fmt(h.output) }}</span>
          <span class="ut-num">{{ fmt(h.cache_read) }}</span><span class="ut-num">{{ fmt(h.requests) }}</span>
          <span class="ut-total" style="text-align:right;">{{ fmt(h.total) }}</span>
        </div>
        <div v-if="!byDaemon.length" class="st-empty">{{ t('token.empty') }}</div>
      </div>
      <div v-else class="session-table">
        <div class="session-table-header"><span>{{ t('token.session') }}</span><span>{{ t('token.model') }}</span><span>{{ t('token.amount') }}</span><span>{{ t('token.in_out') }}</span><span style="text-align:right;">{{ t('token.time') }}</span></div>
        <template v-for="s in pagedSessions" :key="s.session_id">
          <div class="session-row" :class="{ expanded: expanded === s.session_id }" @click="toggleSession(s)">
            <span class="st-name"><span class="st-expand">▶</span>{{ s.title || s.session_id.slice(0, 8) }}<AgentBadge :agent="s.agent_type" size="sm" /></span>
            <span class="st-num"><span class="st-model-dot" :style="{ background: modelColor(s.model) }"></span>{{ s.model || '—' }}</span>
            <span class="st-total">{{ fmt(s.total_tokens) }}</span>
            <span class="st-num">{{ fmt(s.tok_input) }} / {{ fmt(s.tok_output) }}</span>
            <span class="st-num" style="text-align:right;">{{ formatDate(s.created_at) }}</span>
          </div>
          <div v-if="expanded === s.session_id" class="session-expand-row open">
            <div v-if="trendArchived" class="se-label" style="color:var(--fg-tertiary);">{{ t('token.archived') }}</div>
            <template v-else>
              <div class="se-detail-title">{{ t('token.session_detail_prefix') }} — <span :style="{ color: modelColor(s.model), fontWeight: 600 }">{{ s.model || '—' }}</span> · <AgentBadge :agent="s.agent_type" size="md" /> · {{ statusLabel(s.status) }} · {{ t('token.created_on') }} {{ formatDate(s.created_at) }}</div>
              <div class="se-grid">
                <div class="se-item"><span class="se-label">{{ t('token.input') }}</span><span class="se-val">{{ fmt(s.tok_input) }}</span></div>
                <div class="se-item"><span class="se-label">{{ t('token.output') }}</span><span class="se-val">{{ fmt(s.tok_output) }}</span></div>
                <div class="se-item"><span class="se-label">{{ t('token.in_out_ratio') }}</span><span class="se-val">{{ pct(s.tok_input, s.total_tokens) }}% / {{ pct(s.tok_output, s.total_tokens) }}%</span></div>
                <div class="se-item"><span class="se-label">{{ t('token.cache') }}</span><span class="se-val">{{ fmt(s.tok_cache_read) }}</span></div>
                <div class="se-item"><span class="se-label">{{ t('token.amount') }}</span><span class="se-val">{{ fmt(s.total_tokens) }}</span></div>
                <div class="se-item"><span class="se-label">{{ t('token.daily_avg_short') }}</span><span class="se-val">{{ fmt(Math.round((s.total_tokens || 0) / 30)) }}</span></div>
              </div>
              <!-- P1a: 子代理 token 拆分（父总额含子，此处展示各子代理明细） -->
              <div v-if="s.children && s.children.length" class="se-subagents">
                <div class="se-label">{{ t('token.subagent_breakdown') }}</div>
                <div class="se-sub-table">
                  <div class="se-sub-header"><span>{{ t('token.subagent_col') }}</span><span>{{ t('token.input') }}</span><span>{{ t('token.output') }}</span><span>{{ t('token.cache') }}</span></div>
                  <div v-for="c in s.children" :key="c.agentId" class="se-sub-row">
                    <span class="se-sub-name"><AgentBadge :agent="c.agentType" size="sm" /> {{ c.title || c.agentType || c.agentId.slice(0, 6) }}</span>
                    <span class="se-val">{{ fmt(c.tokenIn) }}</span>
                    <span class="se-val">{{ fmt(c.tokenOut) }}</span>
                    <span class="se-val">{{ fmt(c.tokenCache) }}</span>
                  </div>
                </div>
              </div>
              <div class="se-trend-label">{{ t('token.trend_30d') }}</div>
              <div class="se-mini-chart">
                <span v-for="(tr, i) in trendBars" :key="i" :style="{ height: Math.max(2, (tr.input / sessionTrendMax) * 36) + 'px' }" :title="tr.date + ': ' + fmt(tr.input)"></span>
              </div>
            </template>
          </div>
        </template>
        <div v-if="!sessions.length" class="st-empty">{{ t('token.empty_host') }}</div>
      </div>
      <div v-if="selectedHost !== 'all' && (totalPages > 1 || pageSize < sessions.length)" class="sess-pagination">
        <span class="page-total">{{ t('dashboard.page_total', { count: sessions.length }) }}</span>
        <span class="page-sep">·</span>
        <select v-model.number="pageSize" class="page-size-select" @change="currentPage = 1">
          <option v-for="n in pageSizes" :key="n" :value="n">{{ n }} {{ t('dashboard.page_size_unit') }}</option>
        </select>
        <div class="page-controls">
          <button class="st-page-btn" :disabled="currentPage === 1" @click="goPage(1)" :title="t('dashboard.page_first')">«</button>
          <button class="st-page-btn" :disabled="currentPage === 1" @click="goPage(currentPage - 1)">‹</button>
          <span class="st-page-info">{{ currentPage }} / {{ totalPages }}</span>
          <button class="st-page-btn" :disabled="currentPage === totalPages" @click="goPage(currentPage + 1)">›</button>
          <button class="st-page-btn" :disabled="currentPage === totalPages" @click="goPage(totalPages)" :title="t('dashboard.page_last')">»</button>
        </div>
      </div>
    </div>

    <div v-if="tooltip" class="chart-tooltip show" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
      <div class="ct-date">{{ tooltip.data.date }}</div>
      <div class="ct-row" v-if="tooltip.data.input"><span class="ct-label">{{ t('token.input') }}</span><span class="ct-val">{{ fmt(tooltip.data.input) }}</span></div>
      <div class="ct-row" v-if="tooltip.data.output"><span class="ct-label">{{ t('token.output') }}</span><span class="ct-val">{{ fmt(tooltip.data.output) }}</span></div>
      <div class="ct-row" v-if="tooltip.data.cache_read"><span class="ct-label">{{ t('token.cache') }}</span><span class="ct-val">{{ fmt(tooltip.data.cache_read) }}</span></div>
      <div class="ct-row" v-if="tooltip.data.requests"><span class="ct-label">{{ t('token.requests') }}</span><span class="ct-val">{{ tooltip.data.requests }}</span></div>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useLocale } from '../composables/useLocale'
import AgentBadge from '../components/AgentBadge.vue'

const { t } = useLocale()

// 柱状图单柱最大像素高度（双柱：input + output，需与 .bar-chart 容器高度协调）
const BAR_CHART_MAX_H = 90

const token = () => localStorage.getItem('pocketctl_access_token') || ''

async function apiGet(url: string) {
  const tok = token()
  if (!tok) throw new Error('no_token')
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } })
  if (!res.ok) {
    if (res.status === 401) throw new Error('auth_expired')
    throw new Error(`${res.status}`)
  }
  return res.json()
}

const loading = ref(false)
const error = ref('')
const errorDetail = ref('')
const summary = ref<any>({ total: 0, today: 0, thisWeek: 0, thisMonth: 0 })
const dailySeries = ref<any[]>([])
const byModel = ref<any[]>([])
const byDaemon = ref<any[]>([])
const sessions = ref<any[]>([])
const selectedHost = ref<string>('all')
const hostMenuOpen = ref(false)
const expanded = ref<string | null>(null)
const sessionTrend = ref<any[]>([])
const trendArchived = ref(false)
const tooltip = ref<{ x: number; y: number; data: any } | null>(null)

const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#f85149', '#39c5cf']
function modelColor(m: string) {
  const s = String(m ?? '')
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}
function fmt(n: number) {
  n = +n || 0
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return '' + n
}

async function loadDashboard() {
  loading.value = true; error.value = ''; errorDetail.value = ''
  try {
    const d = await apiGet(`/api/tokens/dashboard?daemon=${encodeURIComponent(selectedHost.value)}&days=270`)
    summary.value = d.summary || { total: 0, today: 0, thisWeek: 0, thisMonth: 0 }
    dailySeries.value = Array.isArray(d?.dailySeries) ? d.dailySeries : []
    byModel.value = Array.isArray(d?.byModel) ? d.byModel : []
    byDaemon.value = Array.isArray(d?.byDaemon) ? d.byDaemon : []
  } catch (e: any) {
    const msg = e?.message || ''
    if (msg === 'no_token') error.value = t('token.error_no_token')
    else if (msg === 'auth_expired') error.value = t('token.error_auth_expired')
    else error.value = t('token.error_load_failed')
    errorDetail.value = msg
    console.error('[TokenUsage] dashboard load failed', e)
  } finally { loading.value = false }
  if (selectedHost.value !== 'all') await loadSessions(selectedHost.value)
  else sessions.value = []
}
async function loadSessions(daemonId: string) {
  try {
    const d = await apiGet(`/api/tokens/by-daemon/${daemonId}`)
    sessions.value = d.sessions || []
  } catch (e) { sessions.value = [] }
}
function selectHost(id: string) {
  selectedHost.value = id; hostMenuOpen.value = false; expanded.value = null; currentPage.value = 1
  loadDashboard()
}
async function toggleSession(s: any) {
  if (expanded.value === s.session_id) { expanded.value = null; return }
  expanded.value = s.session_id; sessionTrend.value = []; trendArchived.value = false
  try {
    const r = await apiGet(`/api/tokens/session/${s.session_id}/trend`)
    sessionTrend.value = r.trend; trendArchived.value = r.archived
  } catch (e) { trendArchived.value = true }
}
function showTooltip(e: MouseEvent, data: any) {
  tooltip.value = { x: Math.min(e.clientX + 14, window.innerWidth - 180), y: e.clientY - 14, data }
}

const hostLabel = computed(() => {
  if (selectedHost.value === 'all') return t('token.all_hosts')
  const d = byDaemon.value.find((x) => x.daemon_id === selectedHost.value)
  return d?.alias || d?.hostname || selectedHost.value.slice(0, 8)
})
const totalTokens = computed(() => summary.value.total)
const totalInput = computed(() => dailySeries.value.reduce((s, d) => s + (+d.input || 0), 0))
const totalOutput = computed(() => dailySeries.value.reduce((s, d) => s + (+d.output || 0), 0))
const totalCache = computed(() => dailySeries.value.reduce((s, d) => s + (+d.cache_read || 0), 0))
const totalRequests = computed(() => dailySeries.value.reduce((s, d) => s + (+d.requests || 0), 0))
const avgOutputPerReq = computed(() => totalRequests.value ? Math.round(totalOutput.value / totalRequests.value) : 0)
const dailyAvgReq = computed(() => dailySeries.value.length ? Math.round(totalRequests.value / dailySeries.value.length) : 0)
// 命中率 = 缓存读取 / (缓存读取 + 新增输入)，cache_read 与 input 互斥，相加才构成完整输入侧 token
const cacheRate = computed(() => {
  const denom = totalCache.value + totalInput.value
  return denom ? Math.round((totalCache.value / denom) * 100) : 0
})
const topModel = computed(() => byModel.value[0])
const barData = computed(() => dailySeries.value.slice(-30))
// 按单日 input+output 之和的最大值缩放，保证堆叠双柱总高不超过图表高度
const barMax = computed(() => Math.max(1, ...barData.value.map((d) => (+d.input || 0) + (+d.output || 0))))
function barHeight(v: number) { return Math.max(2, ((+v || 0) / barMax.value) * BAR_CHART_MAX_H) }
function labelDate(d: string) { const dt = new Date(d); return (dt.getMonth() + 1) + '/' + dt.getDate() }
const donutTotal = computed(() => byModel.value.reduce((s, m) => s + (+m.total || 0), 0))
// 模型分布：用量前 6 单独显示并各配一种调色板颜色，其余合并为"其他"段（仅在饼图呈现用量）
const topModels = computed(() => [...byModel.value].sort((a, b) => (+b.total || 0) - (+a.total || 0)).slice(0, 6))
const otherTotal = computed(() => byModel.value.reduce((s, m) => s + (+m.total || 0), 0) - topModels.value.reduce((s, m) => s + (+m.total || 0), 0))
function rankColor(idx: number) { return PALETTE[idx % PALETTE.length] }
const donutGradient = computed(() => {
  let off = 0; const parts: string[] = []
  const total = donutTotal.value || 1
  topModels.value.forEach((m, i) => {
    const pct = (m.total / total) * 100
    parts.push(`${rankColor(i)} ${off}deg ${Math.round(off + pct * 3.6)}deg`)
    off += Math.round(pct * 3.6)
  })
  if (otherTotal.value > 0) {
    const pct = (otherTotal.value / total) * 100
    parts.push(`var(--surface-active) ${off}deg ${Math.round(off + pct * 3.6)}deg`)
  }
  return `conic-gradient(${parts.join(',')})`
})
const heatMax = computed(() => Math.max(1, ...dailySeries.value.map((d) => (+d.input || 0) + (+d.output || 0))))
function heatLevel(v: number) { const p = v / heatMax.value; return p > 0.75 ? 4 : p > 0.5 ? 3 : p > 0.25 ? 2 : p > 0 ? 1 : 0 }
// Normalize any date representation (Date object, "YYYY-MM-DD", or
// "YYYY-MM-DDT00:00:00.000Z" from Postgres) to a stable "YYYY-MM-DD" calendar
// string. Avoids reinterpreting the date through UTC, which previously broke the
// heatmap cell lookup (map keys never matched the grid keys).
function normDate(d: any): string { return String(d).slice(0, 10) }
function fmtLocalDate(dt: Date): string {
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
// Fixed ~9-month window (≈ 39 weeks) ending today, aligned to calendar weeks
// (Sun..Sat columns). Independent of how many days actually have data.
const HEATMAP_WEEKS = 39
const heatmapCols = computed(() => {
  const map = new Map(dailySeries.value.map((d) => [normDate(d.date), d]))
  const cols: any[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayDow = today.getDay() // 0 = Sunday
  const thisSunday = new Date(today)
  thisSunday.setDate(today.getDate() - todayDow)
  for (let w = HEATMAP_WEEKS - 1; w >= 0; w--) {
    const cells: any[] = []
    for (let d = 0; d < 7; d++) {
      const dt = new Date(thisSunday)
      dt.setDate(thisSunday.getDate() - w * 7 + d)
      const future = dt > today
      const ds = fmtLocalDate(dt)
      const day = !future ? map.get(ds) : undefined
      const value = day ? (+day.input + +day.output) : 0
      cells.push({ date: day ? ds : '', key: ds + w + d, value, level: day ? heatLevel(value) : 0, future })
    }
    cols.push({ key: 'col' + w, cells })
  }
  return cols
})
function heatmapCellData(cell: any) { return { date: cell.date, input: cell.value, output: 0, cache_read: 0, requests: 0 } }
const sessionTrendMax = computed(() => Math.max(1, ...sessionTrend.value.map((tr) => +tr.input || 0)))

// Pagination (single-host session detail)
const currentPage = ref(1)
const pageSize = ref(10)
const pageSizes = [10, 20, 50]
const totalPages = computed(() => Math.max(1, Math.ceil(sessions.value.length / pageSize.value)))
const pagedSessions = computed(() => sessions.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value))
const trendBars = computed(() => sessionTrend.value.slice(-30))
function goPage(n: number) { currentPage.value = Math.max(1, Math.min(totalPages.value, n)); expanded.value = null }
function formatDate(d: any) { if (!d) return ''; try { return new Date(d).toISOString().slice(0, 10) } catch { return '' } }
function statusLabel(s: string) { const k = 'session.status.' + (s || 'idle'); const v = t(k); return v === k ? (s || '—') : v }
function pct(a: number, b: number) { return b ? Math.round(((a || 0) / b) * 100) : 0 }

onMounted(loadDashboard)
</script>

<style scoped>
.page-wrap { padding: 24px 32px; max-width: 1280px; margin: 0 auto; }
.page-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 24px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--fg); }
.page-subtitle { font-size: 13px; color: var(--fg-tertiary); margin-top: 4px; }
.token-error { display: flex; align-items: center; gap: 12px; background: rgba(248,81,73,0.1); border: 1px solid rgba(248,81,73,0.3); border-radius: var(--radius-md); padding: 12px 16px; margin-bottom: 16px; }
.token-error-msg { font-size: 13px; color: var(--red); }
.token-error-detail { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; word-break: break-all; font-family: var(--font-mono); }
.token-error-retry { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 6px 14px; color: var(--accent); font-size: 12px; cursor: pointer; }
.token-error-retry:hover { background: var(--accent-muted); }
.token-loading { text-align: center; padding: 40px 20px; font-size: 14px; color: var(--fg-tertiary); }
.host-select-wrap { position: relative; }
.host-select-btn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 14px; color: var(--fg); font-size: 13px; cursor: pointer; }
.host-select-btn .chevron { color: var(--fg-tertiary); margin-left: 4px; }
.host-select-menu { position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-lg); min-width: 180px; padding: 4px; display: none; z-index: 20; }
.host-select-menu.open { display: block; }
.host-select-menu button { display: block; width: 100%; text-align: left; background: none; border: none; padding: 8px 10px; border-radius: var(--radius-sm); color: var(--fg-secondary); font-size: 13px; cursor: pointer; }
.host-select-menu button:hover { background: var(--surface-hover); }
.host-select-menu button.active { background: var(--accent); color: #fff; }

.token-summary { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: 24px; }
.token-summary .tk-item { padding: 18px 22px; border-left: 1px solid var(--border); }
.token-summary .tk-item:first-child { border-left: 0; }
.token-summary .tk-num { font-size: 26px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.token-summary .tk-label { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px; }
.token-summary .tk-sub { font-size: 10px; color: var(--fg-tertiary); opacity: 0.7; }

.metric-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; margin-bottom: 28px; }
.metric-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 16px 18px; }
.metric-card .mc-label { font-size: 11px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.metric-card .mc-value { font-size: 24px; font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; line-height: 1.1; }
.metric-card .mc-sub { font-size: 12px; color: var(--fg-tertiary); margin-top: 4px; }

.chart-section { margin-bottom: 32px; }
.chart-section-title { font-size: 13px; font-weight: 600; color: var(--fg-secondary); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
.chart-section-legend { margin-left: auto; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--fg-tertiary); text-transform: none; letter-spacing: 0; }
.chart-section-legend .le-dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.chart-container { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 18px; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 32px; }
.two-col .chart-section { margin-bottom: 0; }

.bar-chart { display: flex; align-items: flex-end; gap: 3px; height: 200px; padding: 0 2px; overflow: hidden; }
.bar-day { flex: 1; display: flex; flex-direction: column; gap: 2px; justify-content: flex-end; }
.bar-col { width: 100%; border-radius: 2px 2px 0 0; min-height: 2px; cursor: pointer; }
.bar-col.input { background: var(--accent); opacity: 0.7; }
.bar-col.output { background: var(--success); opacity: 0.7; }
.bar-col:hover { opacity: 1 !important; }
.bar-label-row { display: flex; margin-top: 8px; }
.bar-label-row span { flex: 1; text-align: center; font-size: 10px; color: var(--fg-tertiary); font-family: var(--font-mono); display: none; }
.bar-label-row span.show { display: block; }

.donut-wrap { display: flex; align-items: center; gap: 20px; justify-content: center; }
.donut-ring { width: 120px; height: 120px; border-radius: 50%; position: relative; flex-shrink: 0; }
.donut-center { position: absolute; inset: 22px; border-radius: 50%; background: var(--surface); display: flex; flex-direction: column; align-items: center; justify-content: center; }
.donut-center .dc-total { font-size: 16px; font-weight: 700; color: var(--fg); }
.donut-center .dc-label { font-size: 9px; color: var(--fg-tertiary); }
.donut-legend { display: flex; flex-direction: column; gap: 8px; }
.donut-legend .dl-item { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-secondary); }
.donut-legend .dl-swatch { width: 10px; height: 10px; border-radius: 2px; }

.heatmap-legend-bar { display: flex; align-items: center; width: 120px; margin-bottom: 14px; }
.heatmap-legend-bar .hm-label { font-size: 11px; color: var(--fg-tertiary); }
.heatmap-legend-bar .hm-gradient { display: flex; flex: 1; height: 10px; border-radius: 2px; overflow: hidden; margin: 0 10px; }
.heatmap-legend-bar .hm-gradient span { flex: 1; }
.heatmap-legend-bar .hm-gradient span:nth-child(1) { background: var(--surface-active); }
.heatmap-legend-bar .hm-gradient span:nth-child(2) { background: var(--accent); opacity: 0.22; }
.heatmap-legend-bar .hm-gradient span:nth-child(3) { background: var(--accent); opacity: 0.42; }
.heatmap-legend-bar .hm-gradient span:nth-child(4) { background: var(--accent); opacity: 0.66; }
.heatmap-legend-bar .hm-gradient span:nth-child(5) { background: var(--accent); opacity: 0.92; }
.heatmap-wrap { display: flex; gap: 3px; }
.heatmap-col { display: flex; flex-direction: column; gap: 3px; }
.heatmap-cell { width: 12px; height: 12px; border-radius: 2px; background: var(--surface-active); }
.heatmap-cell.l1 { background: var(--accent); opacity: 0.22; }
.heatmap-cell.l2 { background: var(--accent); opacity: 0.42; }
.heatmap-cell.l3 { background: var(--accent); opacity: 0.66; }
.heatmap-cell.l4 { background: var(--accent); opacity: 0.92; cursor: pointer; }
.heatmap-cell[data-date] { cursor: pointer; }

.session-table, .usage-table { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.session-table-header, .usage-table-header { padding: 10px 18px; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid var(--border); background: var(--surface-hover); display: grid; }
.session-table-header { grid-template-columns: 2fr 1fr 1fr 1fr 1fr; }
.usage-table-header { grid-template-columns: 1.5fr repeat(4, 1fr) 110px; }
.session-row, .usage-table-row { padding: 12px 18px; align-items: center; border-bottom: 1px solid var(--border); font-size: 13px; display: grid; }
.session-row { grid-template-columns: 2fr 1fr 1fr 1fr 1fr; cursor: pointer; }
.session-row:hover { background: var(--surface-hover); }
.usage-table-row { grid-template-columns: 1.5fr repeat(4, 1fr) 110px; }
.session-row:last-child, .usage-table-row:last-child { border-bottom: none; }
.session-row .st-name { color: var(--fg); font-weight: 500; display: flex; align-items: center; gap: 6px; }
.session-row .st-expand { display: inline-flex; width: 16px; align-items: center; justify-content: center; font-size: 10px; color: var(--fg-tertiary); transition: transform 0.2s; }
.session-row.expanded .st-expand { transform: rotate(90deg); }
.session-row .st-num, .usage-table-row .ut-num { font-family: var(--font-mono); color: var(--fg-secondary); font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 6px; }
.session-row .st-total, .usage-table-row .ut-total { font-family: var(--font-mono); font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.usage-table-row .ut-host { color: var(--fg); font-weight: 500; }
.st-model-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.st-empty { padding: 48px 16px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
.session-expand-row { padding: 12px 18px; background: var(--bg); border-bottom: 1px solid var(--border); }
.session-expand-row .se-detail-title { font-size: 12px; color: var(--fg-secondary); margin-bottom: 10px; }
.session-expand-row .se-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
.session-expand-row .se-item { display: flex; flex-direction: column; gap: 2px; }
.session-expand-row .se-label { font-size: 10px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
.session-expand-row .se-val { font-size: 13px; font-weight: 600; color: var(--fg); font-family: var(--font-mono); }
.session-expand-row .se-trend-label { font-size: 10px; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.05em; margin: 12px 0 4px; }
.session-expand-row .se-mini-chart { display: flex; align-items: flex-end; gap: 2px; height: 40px; margin-top: 6px; }
.session-expand-row .se-mini-chart span { flex: 1; background: var(--accent); opacity: 0.5; border-radius: 1px 1px 0 0; min-height: 2px; }
.session-expand-row .se-subagents { margin-top: 12px; }
.session-expand-row .se-sub-table { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 0; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.session-expand-row .se-sub-header { display: contents; }
.session-expand-row .se-sub-header span { background: var(--surface-hover); padding: 6px 10px; font-size: 10px; font-weight: 600; color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
.session-expand-row .se-sub-row { display: contents; }
.session-expand-row .se-sub-row .se-sub-name { padding: 6px 10px; color: var(--fg-secondary); display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--border); }
.session-expand-row .se-sub-row .se-val { padding: 6px 10px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fg); border-bottom: 1px solid var(--border); }

.sess-pagination { display: flex; align-items: center; gap: 10px; justify-content: flex-end; padding: 12px 18px; font-size: 12px; color: var(--fg-tertiary); }
.sess-pagination .page-total { font-family: var(--font-mono); }
.sess-pagination .page-size-select { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-secondary); padding: 3px 6px; font-size: 12px; }
.sess-pagination .page-controls { display: flex; align-items: center; gap: 4px; }
.sess-pagination .st-page-btn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-secondary); padding: 3px 8px; cursor: pointer; font-size: 12px; }
.sess-pagination .st-page-btn:disabled { opacity: 0.4; cursor: default; }
.sess-pagination .st-page-info { font-family: var(--font-mono); padding: 0 4px; }

.chart-tooltip { position: fixed; z-index: 100; pointer-events: none; background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-md); padding: 12px 14px; box-shadow: var(--shadow-lg); font-size: 13px; line-height: 1.7; min-width: 150px; }
.chart-tooltip .ct-date { font-size: 11px; color: var(--fg-tertiary); margin-bottom: 6px; font-family: var(--font-mono); }
.chart-tooltip .ct-row { display: flex; justify-content: space-between; gap: 14px; }
.chart-tooltip .ct-label { color: var(--fg-secondary); }
.chart-tooltip .ct-val { font-family: var(--font-mono); color: var(--fg); font-weight: 600; }

@media (max-width: 900px) {
  .two-col { grid-template-columns: 1fr; }
  .token-summary { grid-template-columns: repeat(2, 1fr); }
  .token-summary .tk-item:nth-child(3), .token-summary .tk-item:nth-child(4) { border-top: 1px solid var(--border); }
}
</style>
