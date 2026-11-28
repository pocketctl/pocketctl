<template>
  <TeamOverlay drawer :title="saved?.confirmed_by ? '已确认的分工' : reviewed ? '核对分工' : '方案与分工'" @close="emit('close')">
    <div class="group-form" :aria-busy="busy">
      <p v-if="error" role="alert">{{ error }} <button class="btn" @click="load" :disabled="busy">重新核对原帖</button></p>
      <template v-if="saved">
        <section class="proposal">
          <h3>定稿方案</h3>
          <small>方案 v{{ saved.revision }} · Context v{{ saved.context_version }}</small>
          <textarea v-if="editing" aria-label="定稿方案" v-model="proposal" rows="3" :disabled="busy" />
          <p v-else class="statement">{{ proposal }}</p>
          <details><summary>查看原帖</summary><blockquote>{{ saved.source_text }}</blockquote></details>
        </section>
        <fieldset v-if="editing" :disabled="busy">
          <label>怎样实施<ActionSelect teleport-to=".group-form"><select aria-label="怎样实施" v-model="mode" @change="originalAgent">
            <option v-if="saved.source_binding_id" value="original" :disabled="items.length>1">交给原讨论 Agent</option>
            <option value="independent">分别派工</option>
            <option value="plan" :disabled="session.group_plans === false">共同交付（步骤计划）</option>
          </select></ActionSelect></label>
          <details><summary>引用群内回答（{{ refs.length }}）</summary>
            <label class="reference-option" v-for="e in referencedEvents" :key="e.id"><input type="checkbox" v-model="refs" :value="e.id" />{{ e.content.slice(0,160) }}</label>
          </details>
        </fieldset>
        <div v-else>
          <p class="mode-summary">实施方式 · {{ mode === 'plan' ? '共同交付（步骤计划）' : mode === 'original' ? '交给原讨论 Agent' : '分别派工' }}</p>
          <details v-if="saved.references_snapshot.length"><summary>引用群内回答（{{ saved.references_snapshot.length }}）</summary><blockquote v-for="r in saved.references_snapshot" :key="r.event_id">{{ r.content }}</blockquote></details>
        </div>
        <section class="work-list">
          <header><h3>工作分工 <small>{{ items.length }}</small></h3>
            <button v-if="editing && mode!=='original' && items.length<16" class="add" :disabled="busy" @click="add">＋ 添加分工</button>
          </header>
          <article v-for="item in items" :key="item.item_id">
            <button v-if="editing" class="item-toggle" :aria-expanded="expanded===item.item_id" @click="expanded=expanded===item.item_id?'':item.item_id">
              <span><strong>{{ item.instruction || '填写职责' }}</strong><small>{{ agentIdentity(item.offer_id) }}</small></span>
              <span aria-hidden="true">{{ expanded===item.item_id ? '⌃' : '⌄' }}</span>
            </button>
            <fieldset v-if="editing && expanded===item.item_id" :disabled="busy" class="item-fields">
            <label
              >执行 Agent<ActionSelect teleport-to=".group-form"><select aria-label="执行 Agent" :disabled="mode==='original'" v-model="item.offer_id" @change="delete item.code">
                <option
                  v-for="agent in session.agent_bindings"
                  :key="agent.id"
                  :value="agent.offer_id"
                  :disabled="agent.availability !== 'online'"
                >
                  {{ agentIdentity(agent.offer_id) }}
                </option>
              </select></ActionSelect></label
            >
            <template v-if="mode === 'plan'">
              <label
                >执行工作区<ActionSelect teleport-to=".group-form"><select aria-label="执行工作区" :value="item.code?.grant_revision ?? ''"
                  @change="chooseWorkspace(item, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">普通步骤</option>
                  <option v-for="g in grants(item)" :key="g.grant_revision" :value="g.grant_revision">
                    {{ g.repository }} · {{ g.base_sha.slice(0, 12) }} · {{ g.tools.join('、') }}
                  </option>
                </select></ActionSelect></label
              >
              <small v-if="!grants(item).length">这台机器尚未提供已授权的代码仓库。</small>
              <template v-if="item.code">
                <label
                  >代码步骤<ActionSelect teleport-to=".group-form"><select aria-label="代码步骤" v-model="item.code.kind">
                    <option value="develop">开发</option>
                    <option value="merge">合并已验收的提交</option>
                    <option value="verify">复验合并提交</option>
                  </select></ActionSelect></label
                >
                <label
                  >允许变更的路径（每行一项）<textarea
                    :value="item.code.paths.join('\n')"
                    @change="item.code.paths = lines($event)"
                  />
                </label>
                <small>基线 {{ item.code.base_sha }}</small>
              </template>
            </template>
            <label>职责<textarea v-model="item.instruction" rows="2" /></label
            ><label>验收条件<textarea v-model="item.acceptance" rows="2" /></label>
            <label
              >验收人<ActionSelect teleport-to=".group-form"><select aria-label="验收人" v-model="item.reviewer_user_id">
                <option v-for="m in reviewers" :key="m.user_id" :value="m.user_id">{{ memberName(m.user_id) }}</option>
              </select></ActionSelect></label
            >
            <label
              >必需检查（每行一项）<textarea
                :value="item.required_checks.join('\n')"
                @change="item.required_checks = lines($event)"
              />
            </label>
            <div v-if="mode === 'plan' && items.length > 1">
              等待哪些分工先通过验收
              <label v-for="(other, n) in items" :key="other.item_id"
                ><template v-if="other !== item"
                  ><input v-model="item.depends_on" type="checkbox" :value="other.item_id" /> 分工 {{ n + 1 }}</template
                ></label
              >
            </div>
            <button class="btn" v-if="mode !== 'original' && items.length > 1" @click="remove(item.item_id)">移除此项</button>

            </fieldset>
            <div v-if="!editing" class="review-item">
              <strong>{{ item.instruction || '尚未填写职责' }}</strong><small>{{ agentIdentity(item.offer_id) }}</small>
              <dl><dt>验收人</dt><dd>{{ memberName(item.reviewer_user_id) }}</dd>
              <dt>验收条件</dt><dd>{{ item.acceptance || '尚未填写' }}</dd>
              <template v-if="item.required_checks.length"><dt>必需检查</dt><dd>{{ item.required_checks.join('、') }}</dd></template>
              <template v-if="mode==='plan' && item.code"><dt>工作区</dt><dd>{{ item.code.repository }} · {{ item.code.base_sha }} · {{ item.code.kind }} · {{ item.code.paths.join('、') }} · {{ item.code.tools.join('、') }}</dd></template>
              <template v-if="mode==='plan' && item.depends_on.length"><dt>先验收</dt><dd>{{ item.depends_on.map(id=>items.find(i=>i.item_id===id)?.instruction || id).join('、') }}</dd></template>
              </dl>
              <span v-if="saved.confirmed_by">{{ stateName(item.step_state || item.call_state || item.task_state) }}</span>
              <button class="btn" v-if="item.task_id" @click="emit('task', item.task_id)">查看任务</button>
            </div>
          </article>
        </section>
        <p v-if="saved.confirmed_by">{{ memberName(saved.confirmed_by) }} 已确认<span v-if="mode==='plan'"> · 打开任务的执行步骤，核对并激活计划。</span></p>
      </template>
      <p v-else-if="!busy && !error">这条消息还没有共享委托。</p>
      <p v-if="busy" role="status">正在核对…</p>
    </div>
    <template v-if="saved && !saved.confirmed_by && canEdit" #footer>
      <button v-if="reviewed" class="btn" :disabled="busy" @click="reviewed=false">返回修改</button>
      <button v-if="reviewed" class="btn primary" :disabled="busy || edited || session.current_context_version!==saved.context_version" @click="confirm">确认按 v{{ saved.revision }} 实施</button>
      <button v-else class="btn primary" :disabled="busy" @click="save">保存并核对分工</button>
    </template>
  </TeamOverlay>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { teamProviderLabel } from '../../utils/teamProvider'
import ActionSelect from '../ActionSelect.vue'
import TeamOverlay from './TeamOverlay.vue'
import { teamRequest } from '../../services/teamClient'
import { useAuth } from '../../composables/useAuth'
import { getRelayOrigin } from '../../composables/useEnv'
import type { TeamEvent, TeamMember, TeamSession, TeamCodeStep } from '../../types/team'
interface Item {
  code?: TeamCodeStep
  item_id: string
  offer_id: string
  instruction: string
  acceptance: string
  reviewer_user_id: number
  required_checks: string[]
  depends_on: string[]
  task_id?: string
  step_state?: string
  call_state?: string
  task_state?: string
}
interface Assignment {
  assignment_id: string
  source_text: string
  proposal: string
  source_binding_id: string | null
  source_offer_id: string | null
  mode: string
  confirmed_by: number | null
  revision: number
  context_version: number
  references_snapshot: { event_id: string; content: string }[]
  items: Item[]
}
const props = defineProps<{
  session: TeamSession
  source: TeamEvent
  members: TeamMember[]
  events: TeamEvent[]
  actor: number
  canEdit: boolean
}>()
const emit = defineEmits<{ close: []; task: [id: string] }>()
const path = '/api/team/sessions/' + encodeURIComponent(props.session.id) + '/assignments'
const origin = getRelayOrigin(),
  actor = props.actor,
  auth = useAuth()
const identity = {
  userId: actor,
  origin,
  isCurrent: () => auth.user.value?.id === actor && props.session.id === props.source.team_session_id,
}
const busy = ref(false),
  error = ref(''),
  saved = ref<Assignment | null>(null),
  reviewed = ref(false)
const mode = ref('independent'),
  proposal = ref(''),
  refs = ref<string[]>([]),
  items = ref<Item[]>([]),
  baseline = ref('')
const reviewers = computed(() =>
  props.members.filter(
    (m) =>
      m.state === 'active' &&
      m.role !== 'viewer' &&
      props.session.participants.some((p) => p.state === 'active' && p.user_id === m.user_id),
  ),
)
const referencedEvents = computed(() => {
  const entries = new Map(
    (saved.value?.references_snapshot ?? []).map((e) => [e.event_id, { id: e.event_id, content: e.content }]),
  )
  for (const event of props.events)
    if (['member_message', 'agent_message'].includes(event.kind)) entries.set(event.id, event)
  return [...entries.values()]
})
function stateName(value?: string) {
  return (
    (
      {
        open: '待开始',
        in_progress: '进行中',
        pending: '等待派发',
        dispatched: '已派发',
        running: '执行中',
        reserved: '已预留',
        accepted: '已接受',
        completed: '执行结束',
        failed: '执行失败',
        blocked: '受阻',
        uncertain: '等待核对',
        unknown: '等待核对',
        cancelled: '已取消',
      } as Record<string, string>
    )[value ?? ''] ?? value
  )
}
function memberName(id: number) {
  return props.members.find((m) => m.user_id === id)?.display_label ?? '成员 ' + id
}
const editing = computed(()=>props.canEdit && !saved.value?.confirmed_by && !reviewed.value)
const expanded = ref('')
function originalAgent() {
  if(mode.value === 'original' && saved.value?.source_offer_id && items.value.length === 1) {
    const item=items.value[0]
    if(item.offer_id!==saved.value.source_offer_id) delete item.code
    item.offer_id=saved.value.source_offer_id
  }
}
function agentIdentity(id:string) {
  const agent=props.session.agent_bindings.find(b=>b.offer_id===id)
  return agent ? [teamProviderLabel(agent.provider), memberName(agent.owner_user_id), agent.daemon_id].join(' · ') : id || '待选 Agent'
}
function add() {
  const item=newItem()
  items.value.push(item)
  expanded.value=item.item_id
}
function lines(e: Event) {
  return (e.target as HTMLTextAreaElement).value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}
function grants(item: Item) {
  return props.session.agent_bindings.find((b) => b.offer_id === item.offer_id)?.code_workspaces ?? []
}
function chooseWorkspace(item: Item, revision: string) {
  const grant = grants(item).find((g) => g.grant_revision === revision)
  item.code = grant
    ? {
        repository: grant.repository,
        base_sha: grant.base_sha,
        grant_revision: grant.grant_revision,
        paths: [...grant.paths],
        tools: [...grant.tools],
        kind: 'develop',
      }
    : undefined
}
function newItem(): Item {
  return {
    item_id: crypto.randomUUID(),
    offer_id:
      saved.value?.source_offer_id ??
      props.session.agent_bindings.find((b) => b.availability === 'online')?.offer_id ??
      '',
    reviewer_user_id: actor,
    instruction: '',
    acceptance: '',
    required_checks: [],
    depends_on: [],
  }
}
function remove(id: string) {
  items.value = items.value.filter((i) => i.item_id !== id)
  for (const i of items.value) i.depends_on = i.depends_on.filter((d) => d !== id)
}
const payload = computed(() => ({
  mode: mode.value,
  proposal: proposal.value,
  reference_event_ids: refs.value,
  items: items.value.map((i) => ({
    ...(mode.value === 'plan' && i.code ? { code: i.code } : {}),
    item_id: i.item_id,
    offer_id: i.offer_id,
    instruction: i.instruction,
    acceptance: i.acceptance,
    reviewer_user_id: i.reviewer_user_id,
    required_checks: i.required_checks,
    depends_on: mode.value === 'plan' ? i.depends_on : [],
  })),
}))
const edited = computed(() => JSON.stringify(payload.value) !== baseline.value)
function apply(a: Assignment | null) {
  saved.value = a
  reviewed.value = false
  if (!a) return
  mode.value = a.mode
  proposal.value = a.proposal
  refs.value = a.references_snapshot.map((r) => r.event_id)
  items.value = a.items.length
    ? a.items.map((i) => ({ ...i, depends_on: [...i.depends_on], required_checks: [...i.required_checks] }))
    : [{ ...newItem(), instruction: a.proposal }]
  expanded.value = items.value.length === 1 ? items.value[0].item_id : ''
  baseline.value = JSON.stringify(payload.value)
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    reviewed.value = false
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function write(method: 'POST' | 'PATCH', suffix: string, body: Record<string, unknown>) {
  return (
    await teamRequest<{ assignment: Assignment }>(path + suffix, {
      method,
      body: { request_id: crypto.randomUUID(), ...body },
      identity,
    })
  ).assignment
}
function load() {
  return run(async () => {
    const result = await teamRequest<{ assignment: Assignment | null }>(
      path + '/by-source/' + encodeURIComponent(props.source.id),
      { identity },
    )
    apply(result.assignment ?? (props.canEdit ? await write('POST', '', { source_event_id: props.source.id }) : null))
  })
}
function save() {
  return run(async () => {
    if (!saved.value) return
    if (
      edited.value ||
      !saved.value.items.length ||
      props.session.current_context_version !== saved.value.context_version
    )
      apply(
        await write('PATCH', '/' + saved.value.assignment_id, {
          ...payload.value,
          expected_revision: saved.value.revision,
          context_version: props.session.current_context_version,
        }),
      )
    reviewed.value = true
  })
}
function confirm() {
  return run(async () => {
    if (saved.value && reviewed.value && !edited.value)
      apply(
        await write('POST', '/' + saved.value.assignment_id + '/confirm', { expected_revision: saved.value.revision }),
      )
  })
}
onMounted(load)
</script>
<style scoped>
.group-form,.proposal,fieldset,.item-fields,.review-item{display:grid;min-width:0;gap:12px}
.group-form{gap:22px;overflow-wrap:anywhere}
.group-form h3,.group-form p,.group-form dl,.group-form dd{margin:0}
.group-form h3{font-size:14px;font-weight:600}.group-form small,.group-form dt,.mode-summary{color:var(--fg-secondary);font-size:12px}
.proposal{gap:6px}.proposal .statement{font-size:16px;white-space:pre-wrap}
.group-form fieldset{border:0;margin:0;padding:0}.group-form label{display:grid;gap:5px;font-size:13px}
.group-form textarea,.group-form select{display:block;width:100%;box-sizing:border-box;min-width:0;max-width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;color:var(--fg);background:var(--surface);font:inherit}
.group-form textarea{resize:vertical}.group-form textarea:focus,.group-form select:focus{outline:1px solid var(--accent)}
.group-form summary{cursor:pointer;color:var(--fg-secondary);font-size:12px;padding:6px 0}
.group-form blockquote{margin:4px 0;padding:4px 12px;border-inline-start:2px solid var(--border);white-space:pre-wrap}
.group-form .reference-option{display:flex;align-items:baseline;gap:8px;padding:5px 0}
.work-list header,.item-toggle{display:flex;align-items:center;justify-content:space-between;gap:10px}
.work-list header{padding-bottom:6px}.work-list h3 small{margin-inline-start:4px}
.work-list article{border-top:1px solid var(--border)}
.item-toggle,.add{border:0;background:none;color:var(--fg);text-align:start;cursor:pointer}.add{color:var(--accent);padding:7px 0}
.item-toggle{width:100%;min-height:54px;padding:12px 0}.item-toggle>span:first-child{min-width:0;display:grid;gap:3px}.item-toggle strong{overflow-wrap:anywhere}
.group-form .item-fields{padding:4px 0 16px}.review-item{gap:4px;padding:14px 0}.review-item dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin-top:6px}
.group-form button.btn{justify-self:start}
</style>
