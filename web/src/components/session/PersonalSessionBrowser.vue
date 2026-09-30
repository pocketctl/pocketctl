<template>
  <aside
    ref="root"
    class="personal-session-browser"
    @keydown.esc="
      menu = '';
      projectMenu = '';
    "
  >
    <header>
      <div>
        <h3>会话</h3>
        <small
          >{{ allRows.length }} 个会话 ·
          {{
            allRows.filter((item) =>
              ["running", "busy", "retry"].includes(item.status),
            ).length
          }}
          个运行中</small
        >
      </div>
      <button
        aria-label="新建会话"
        @click="
          newProject = null;
          newOpen = true;
        "
      >
        ＋
      </button>
    </header>
    <SessionScopeSwitcher
      :model-value="{ type: 'personal' }"
      :teams="teams"
      @update:model-value="emit('update:scope', $event)"
    />
    <div class="filters">
      <div class="filter-wrap">
        <button
          class="filter-trigger host-trigger"
          :aria-expanded="menu === 'host'"
          @click="menu = menu === 'host' ? '' : 'host'"
        >
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="13" rx="2" />
            <path d="M8 21h8M12 16v5" /></svg
          ><span
            ><small>主机</small><strong>{{ hostName(host) }}</strong></span
          ><span>⌄</span>
        </button>
        <div v-if="menu === 'host'" class="filter-menu">
          <input
            v-model="hostQuery"
            aria-label="搜索主机"
            placeholder="搜索主机名称"
          /><button
            v-for="item in hostOptions"
            :key="item.daemon_id"
            @click="
              host = item.daemon_id;
              menu = '';
            "
          >
            <i :class="['dot', { online: item.status === 'online' }]"></i
            ><span>{{
              item.alias || item.hostname || item.daemon_id || "全部主机"
            }}</span>
          </button>
        </div>
      </div>
      <div class="filter-wrap">
        <button
          class="filter-trigger"
          aria-haspopup="menu"
          :aria-expanded="menu === 'agent'"
          @click="menu = menu === 'agent' ? '' : 'agent'"
        >
          <svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" /></svg
          ><strong>{{ agentLabel(agent) }}（{{ filtered.length }}）</strong
          ><span>⌄</span>
        </button>
        <div v-if="menu === 'agent'" class="filter-menu" role="menu">
          <button
            v-for="item in agentOptions"
            :key="item"
            role="menuitemradio"
            :aria-checked="agent === item"
            @click="
              agent = item;
              menu = '';
            "
          >
            {{ agent === item ? "✓ " : "" }}{{ agentLabel(item)
            }}<small>{{
              allRows.filter((row) => !item || row.agent_type === item).length
            }}</small>
          </button>
        </div>
      </div>
    </div>
    <div class="presence">
      <i
        :class="[
          'dot',
          { online: scopedHosts.some((item) => item.status === 'online') },
        ]"
      ></i
      ><span
        >{{ scopedHosts.filter((item) => item.status === "online").length }} /
        {{ scopedHosts.length }} 台主机在线</span
      ><button aria-label="搜索会话" @click="searchOpen = !searchOpen">
        ⌕
      </button>
    </div>
    <input
      v-if="searchOpen"
      v-model="query"
      class="search"
      aria-label="搜索已加载会话"
      placeholder="搜索已加载会话"
    />
    <nav class="list" aria-label="个人会话列表">
      <button
        v-if="archived"
        class="archive"
        @click="
          archived = false;
          load();
        "
      >
        ‹ 返回会话
      </button>
      <div v-else class="project-label">
        <span>项目</span><CreateProjectControl @created="load" />
      </div>
      <section
        v-for="group in groups"
        :key="group.id"
        @dragover.prevent
        @drop.prevent="dropGroup(group.id)"
      >
        <div
          v-if="!archived"
          class="project-heading"
          :draggable="group.id !== 'ungrouped'"
          @dragstart="dragProject = group.id"
        >
          <button
            :aria-expanded="!collapsed[group.id]"
            @click="collapsed[group.id] = !collapsed[group.id]"
          >
            <svg viewBox="0 0 24 24">
              <path
                d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
              /></svg
            >{{ group.name }} <small>{{ group.count }}</small></button
          ><button
            v-if="group.id !== 'ungrouped'"
            aria-label="项目操作"
            @click="projectMenu = projectMenu === group.id ? '' : group.id"
          >
            ···
          </button>
          <div v-if="projectMenu === group.id" class="project-menu">
            <button
              @click="
                newProject = group.id;
                newOpen = true;
                projectMenu = '';
              "
            >
              在项目中新建会话</button
            ><button @click="renameGroup(group.id)">重命名</button
            ><button @click="shiftGroup(group.id, -1)">上移</button
            ><button @click="shiftGroup(group.id, 1)">下移</button>
          </div>
        </div>
        <template v-if="archived || !collapsed[group.id]">
          <div
            v-for="item in group.rows"
            :key="item.session_id"
            class="session-row"
            draggable="true"
            @dragstart="dragSession = item.session_id"
            @dragend="dragSession = ''"
            @dragover.prevent
            @drop.stop.prevent="dropSession(group.id, item.session_id)"
          >
            <button
              v-if="item.children?.length"
              class="fold"
              :aria-expanded="expanded[item.session_id]"
              @click="expanded[item.session_id] = !expanded[item.session_id]"
            >
              {{ expanded[item.session_id] ? "▾" : "▸" }}</button
            ><i
              :class="[
                'dot',
                { online: ['running', 'busy', 'retry'].includes(item.status) },
              ]"
            ></i>
            <RouterLink :to="`/session/${item.session_id}`"
              ><strong
                ><SessionPinBadge v-if="item.pinned" /><input
                  v-if="renamingId === item.session_id"
                  v-model="renameInput"
                  class="ss-rename-input"
                  @click.stop.prevent
                  @keydown.enter="commitRename(item)"
                  @keydown.esc="cancelRename"
                  @blur="commitRename(item)"
                /><template v-else>{{
                  item.title || item.session_id.slice(0, 8)
                }}</template
                ><b v-if="item.new_badge_pending">NEW</b></strong
              ><small
                >{{ agentLabel(item.agent_type) }} ·
                {{
                  formatTime(item.last_activity_at || item.created_at)
                }}</small
              ></RouterLink
            >
            <SessionActions
              :session="item"
              :projects="projects"
              :archived-view="archived"
              @startRename="startRename"
              @deleted="load"
              @moved="load"
              @archived="load"
              @pinned="load"
            />
            <div v-if="expanded[item.session_id]" class="children">
              <RouterLink
                v-for="child in item.children"
                :key="child.agentId"
                :to="`/session/${item.session_id}?subagent=${child.agentId}`"
                >↳ {{ child.title || child.agentId.slice(0, 8) }}</RouterLink
              >
            </div>
          </div>
          <button
            v-if="cursors[group.id]"
            class="archive"
            @click="loadBucket(group.id, cursors[group.id]!)"
          >
            加载更多
          </button>
        </template>
      </section>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-else-if="loading" class="empty">加载中…</p>
      <p v-else-if="!filtered.length" class="empty">当前筛选下没有会话。</p>
      <button
        v-if="!archived"
        class="archive"
        @click="
          archived = true;
          load();
        "
      >
        已归档 <span>{{ archivedCount }}</span>
      </button>
    </nav>
    <NewSessionDialog
      v-if="newOpen"
      :daemons="daemons"
      :pre-selected-daemon-id="host"
      :project-id="newProject"
      @close="newOpen = false"
    />
  </aside>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, toRefs } from "vue";
import { useSessionBrowserFilters } from "../../composables/useSessionBrowserFilters";
import SessionScopeSwitcher from "./SessionScopeSwitcher.vue";
import SessionActions from "../SessionActions.vue";
import SessionPinBadge from "../SessionPinBadge.vue";
import CreateProjectControl from "../CreateProjectControl.vue";
import NewSessionDialog from "../NewSessionDialog.vue";
import { useSessionRename } from "../../composables/useSessionRename";
import { useWebSocket } from "../../composables/useWebSocket";
import type { SessionScope } from "../../composables/useScopedSessionState";
import { listTeams } from "../../services/teamClient";
import type { TeamSummary } from "../../types/team";
import {
  listProjects,
  listOrganizedSessions,
  moveSession,
  renameProject,
  reorderProjects,
  reorderSession,
  type SessionProject,
} from "../../services/sessionOrganization";
const root = ref<HTMLElement | null>(null);
function closeMenus(event: MouseEvent) {
  if (!(event.target as HTMLElement).closest(".filter-wrap,.project-heading")) {
    menu.value = "";
    projectMenu.value = "";
  }
}
const emit = defineEmits<{ "update:scope": [scope: SessionScope] }>();
const { renamingId, renameInput, startRename, commitRename, cancelRename } =
    useSessionRename(),
  { connect, send, onEvent } = useWebSocket();
const teams = ref<TeamSummary[]>([]),
  projects = ref<SessionProject[]>([]),
  daemons = ref<any[]>([]),
  buckets = ref<Record<string, any[]>>({}),
  cursors = ref<Record<string, string | null>>({}),
  revisions = ref<Record<string, number>>({}),
  collapsed = ref<Record<string, boolean>>({}),
  expanded = ref<Record<string, boolean>>({});
const { host, agent, query, archived, searchOpen } = toRefs(
  useSessionBrowserFilters(
    computed<SessionScope>(() => ({ type: "personal" })),
  ),
);
const hostQuery = ref(""),
  menu = ref(""),
  projectMenu = ref(""),
  archivedCount = ref(0),
  loading = ref(true),
  error = ref(""),
  newOpen = ref(false),
  newProject = ref<string | null>(null),
  dragProject = ref(""),
  dragSession = ref(""),
  orderRevision = ref(0),
  ungroupedCount = ref(0);
let generation = 0;
const cleanups: (() => void)[] = [];
function hostName(id: string) {
  const daemon = daemons.value.find((item) => item.daemon_id === id);
  return daemon?.alias || daemon?.hostname || id || "全部主机";
}
function agentLabel(value: string) {
  return value === "codex"
    ? "Codex"
    : value === "claude-code"
      ? "Claude Code"
      : value === "opencode"
        ? "OpenCode"
        : value || "全部 Agent";
}
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}
const allRows = computed(() => Object.values(buckets.value).flat());
const agentOptions = computed(
  () =>
    [
      "",
      ...new Set(allRows.value.map((item) => item.agent_type).filter(Boolean)),
    ] as string[],
);
const filtered = computed(() =>
  allRows.value.filter(
    (item) =>
      (!agent.value || item.agent_type === agent.value) &&
      `${item.title} ${item.cwd} ${item.session_id}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const hostOptions = computed(() =>
  [
    {
      daemon_id: "",
      hostname: "全部主机",
      status: daemons.value.some((item) => item.status === "online")
        ? "online"
        : "offline",
    },
    ...daemons.value,
  ].filter((item) =>
    `${item.alias || ""} ${item.hostname} ${item.daemon_id}`
      .toLowerCase()
      .includes(hostQuery.value.toLowerCase()),
  ),
);
const scopedHosts = computed(() =>
  daemons.value.filter((item) => !host.value || item.daemon_id === host.value),
);
const groups = computed(() =>
  archived.value
    ? [
        {
          id: "archived",
          name: "已归档",
          count: archivedCount.value,
          rows: filtered.value,
        },
      ]
    : [
        ...projects.value.map((item) => ({
          id: item.id,
          name: item.name,
          count: item.count,
          rows: filtered.value.filter((row) => row.project_id === item.id),
        })),
        {
          id: "ungrouped",
          name: "未分组",
          count: ungroupedCount.value,
          rows: filtered.value.filter((item) => !item.project_id),
        },
      ],
);
async function loadBucket(bucket: string, cursor?: string) {
  const current = generation;
  const page = await listOrganizedSessions({
    bucket: bucket === "archived" ? undefined : bucket,
    view: archived.value ? "archived" : "active",
    daemonId: host.value || undefined,
    limit: bucket === "ungrouped" ? 30 : 5,
    cursor,
  });
  if (current !== generation) return;
  buckets.value[bucket] = cursor
    ? [
        ...(buckets.value[bucket] || []),
        ...page.sessions.filter(
          (item) =>
            !buckets.value[bucket]?.some(
              (old) => old.session_id === item.session_id,
            ),
        ),
      ]
    : page.sessions;
  cursors.value[bucket] = page.next_cursor;
  revisions.value[bucket] = page.revision;
}
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  buckets.value = {};
  try {
    const snapshot = await listProjects(host.value || undefined);
    if (current !== generation) return;
    projects.value = snapshot.projects;
    orderRevision.value = snapshot.project_order_revision;
    archivedCount.value = snapshot.archived_count;
    ungroupedCount.value = snapshot.ungrouped_count;
    await Promise.all(
      (archived.value
        ? ["archived"]
        : ["ungrouped", ...snapshot.projects.map((item) => item.id)]
      ).map((id) => loadBucket(id)),
    );
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : "加载失败";
  } finally {
    if (current === generation) loading.value = false;
  }
}
async function mutation(run: () => Promise<unknown>) {
  try {
    await run();
    await load();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "操作失败";
  }
}
async function renameGroup(id: string) {
  const project = projects.value.find((item) => item.id === id);
  if (!project) return;
  const name = prompt("项目名称", project.name)?.trim();
  projectMenu.value = "";
  if (name && name !== project.name)
    await mutation(() => renameProject(id, name, Number(project.revision)));
}
async function shiftGroup(id: string, direction: number) {
  const ids = projects.value.map((item) => item.id),
    from = ids.indexOf(id),
    to = from + direction;
  projectMenu.value = "";
  if (to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  await mutation(() => reorderProjects(ids, orderRevision.value));
}
async function dropGroup(id: string) {
  if (dragSession.value) {
    const session = dragSession.value;
    dragSession.value = "";
    await mutation(() => moveSession(session, id === "ungrouped" ? null : id));
  } else if (
    dragProject.value &&
    dragProject.value !== id &&
    id !== "ungrouped"
  ) {
    const ids = projects.value.map((item) => item.id),
      from = ids.indexOf(dragProject.value);
    if (from < 0) return;
    const moved = ids.splice(from, 1)[0]!;
    const to = ids.indexOf(id);
    if (to < 0) return;
    ids.splice(to, 0, moved);
    dragProject.value = "";
    await mutation(() => reorderProjects(ids, orderRevision.value));
  }
}
async function dropSession(bucket: string, before: string) {
  const id = dragSession.value;
  dragSession.value = "";
  if (!id || id === before) return;
  const item = allRows.value.find((row) => row.session_id === id);
  if ((item?.project_id || "ungrouped") !== bucket) {
    await mutation(() =>
      moveSession(id, bucket === "ungrouped" ? null : bucket),
    );
    return;
  }
  await mutation(() =>
    reorderSession(bucket, id, before, revisions.value[bucket] ?? 0),
  );
}
watch(host, () => void load());
onMounted(() => {
  document.addEventListener("click", closeMenus);
  connect();
  cleanups.push(
    onEvent("daemon_list", (message: any) => {
      daemons.value = message.daemons || [];
    }),
  );
  for (const name of [
    "connection_restored",
    "session_organization_changed",
    "session_created",
    "session_discovered",
  ])
    cleanups.push(
      onEvent(name, () => {
        void load();
        send({ type: "list_daemons" });
      }),
    );
  send({ type: "list_daemons" });
  void listTeams()
    .then((value) => (teams.value = value))
    .catch(() => {});
  void load();
});
onBeforeUnmount(() => {
  document.removeEventListener("click", closeMenus);
  generation++;
  cleanups.forEach((cleanup) => cleanup());
});
</script>
<style scoped>
.personal-session-browser {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--fg);
  background: var(--surface);
}
header {
  height: 66px;
  min-height: 66px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  box-sizing: border-box;
}
header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
header small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--fg-tertiary);
}
header > button {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--fg-secondary);
  background: none;
  cursor: pointer;
  font-size: 19px;
}
.filters {
  padding: 10px 10px 8px;
  display: grid;
  gap: 8px;
}
.filter-wrap {
  position: relative;
}
.filter-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--fg-secondary);
  text-align: left;
  font: 11px var(--font-body);
  cursor: pointer;
}
.filter-trigger > span:first-of-type,
.filter-trigger > strong {
  flex: 1;
  min-width: 0;
}
.filter-trigger strong {
  font-weight: 550;
  color: var(--fg);
  display: block;
}
.filter-trigger small {
  display: block;
  color: var(--fg-tertiary);
  font-size: 9px;
  margin-bottom: 3px;
}
svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  flex: none;
}
.filter-menu,
.project-menu {
  position: absolute;
  z-index: 30;
  top: 100%;
  left: 0;
  right: 0;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
}
.filter-menu button,
.project-menu button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 6px;
  border: 0;
  background: none;
  color: var(--fg);
  text-align: left;
  font: 11px var(--font-body);
  cursor: pointer;
}
.filter-menu button > span {
  flex: 1;
}
.filter-menu input,
.search {
  padding: 8px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: 11px var(--font-body);
}
.filter-menu input {
  width: 100%;
}
.search {
  margin: 0 12px 8px;
}
.presence {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 9px 16px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.presence > span {
  flex: 1;
}
.presence button {
  width: 24px;
  height: 24px;
  color: inherit;
  border: 0;
  background: none;
  cursor: pointer;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-tertiary);
  flex: none;
}
.dot.online {
  background: var(--success);
}
.list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 14px;
}
.project-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 8px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.project-heading {
  position: relative;
  display: flex;
  align-items: center;
  padding: 7px 8px;
  gap: 8px;
}
.project-heading > button {
  display: flex;
  gap: 7px;
  align-items: center;
  border: 0;
  background: none;
  color: var(--fg-secondary);
  font: 11px var(--font-body);
  cursor: pointer;
}
.project-heading > button:first-child {
  flex: 1;
  text-align: left;
}
.project-heading small {
  font-size: 10px;
  color: var(--fg-tertiary);
}
.session-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  margin-bottom: 2px;
}
.session-row:hover {
  background: var(--surface-hover);
}
.session-row > a {
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: var(--fg);
}
.session-row strong {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-row small {
  display: block;
  font-size: 10px;
  color: var(--fg-tertiary);
  margin-top: 4px;
}
.session-row b {
  font-size: 8px;
  color: var(--accent);
}
.fold {
  width: 12px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg-secondary);
  cursor: pointer;
}
.children {
  flex-basis: 100%;
  display: grid;
  padding-left: 23px;
  gap: 6px;
}
.children a {
  font-size: 11px;
  color: var(--fg-secondary);
  text-decoration: none;
}
.archive {
  display: flex;
  justify-content: space-between;
  width: 100%;
  padding: 12px 8px;
  border: 0;
  background: none;
  color: var(--fg-secondary);
  font: 11px var(--font-body);
  cursor: pointer;
}
.empty {
  text-align: center;
  padding: 24px 8px;
  color: var(--fg-secondary);
  font-size: 12px;
}
.ss-rename-input {
  width: 100%;
  min-width: 0;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--accent);
  font: inherit;
}
.personal-session-browser {
  background: var(--bg-secondary);
}
.personal-session-browser > header > button {
  width: 32px;
  height: 32px;
  color: var(--accent);
  background: var(--surface);
}
.session-row strong {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}
.session-row small {
  font-size: 11px;
  line-height: 15px;
}
.filter-trigger {
  min-height: 34px;
  border-radius: 8px;
  background: var(--surface);
  padding: 0 10px;
  font: 11.5px/1.5 var(--font-body);
}
.host-trigger {
  height: 52px;
}
.filter-trigger small {
  font-size: 10px;
  margin-bottom: 4px;
}
.host-trigger strong {
  font-size: 12px;
  font-weight: 500;
}
.filter-trigger:not(.host-trigger) > strong {
  text-align: center;
}
@media(max-width:768px) { .panel-head,header { padding-left:52px; } }
</style>
