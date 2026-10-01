<template>
  <aside
    ref="root"
    class="personal-session-browser"
    @keydown.esc="closeWithEscape"
  >
    <header>
      <div>
        <h3>会话</h3>
        <small
          >{{ scopedSessions.length }} 个会话 ·
          {{
            scopedSessions.filter((item) =>
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
      <div v-if="personalHosts.length || host" class="filter-wrap host-filter-popover">
        <button
          ref="hostFilterTrigger"
          type="button"
          class="filter-trigger host-trigger"
          :aria-expanded="menu === 'host'"
          aria-controls="personal-session-host-filter"
          @click="toggleHostFilter"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="13" rx="2" />
            <path d="M8 21h8M12 16v5" /></svg
          ><span class="host-filter-copy"
            ><small>{{ t('session.host_filter_label') }}</small><span>{{ hostName(host) }}</span></span
          ><svg class="filter-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div v-if="menu === 'host'" id="personal-session-host-filter" class="filter-menu host-filter-menu">
          <input
            ref="hostFilterSearch"
            v-model="hostQuery"
            class="host-filter-search"
            type="search"
            :aria-label="t('session.host_filter_search')"
            :placeholder="t('session.host_filter_search')"
          />
          <div class="host-filter-options">
          <button
            v-for="item in hostOptions"
            :key="item.daemon_id"
            type="button"
            class="filter-option host-filter-option"
            :data-host-filter="item.daemon_id"
            :aria-pressed="host === item.daemon_id"
            @click="selectHostFilter(item.daemon_id)"
          >
            <i :class="['dot', { online: item.status === 'online' }]" aria-hidden="true"></i>
            <span class="host-filter-copy"><span>{{ hostName(item.daemon_id) }}</span>
              <small>{{ item.daemon_id ? `${item.status === 'online' ? t('dashboard.online') : t('dashboard.offline')} · ${item.daemon_id}` : t('session.host_filter_all_hint') }}</small>
            </span>
            <span class="filter-count">{{ item.count }}</span>
            <span class="host-filter-check" aria-hidden="true">{{ host === item.daemon_id ? '✓' : '' }}</span>
          </button>
          <p v-if="!hostOptions.length" class="host-filter-empty">{{ t('session.host_filter_no_match') }}</p>
          </div>
        </div>
      </div>
      <div v-if="browserSessions.length" class="filter-wrap agent-filter-popover">
        <button
          type="button"
          class="filter-trigger"
          aria-haspopup="menu"
          :aria-expanded="menu === 'agent'"
          @click="menu = menu === 'agent' ? '' : 'agent'"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg
          ><span class="filter-trigger-label">{{ agentLabel(agent) }}（{{ agentCount(agent) }}）</span>
          <svg class="filter-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div v-if="menu === 'agent'" class="filter-menu" role="menu" :aria-label="t('session.agent_filter_label')">
          <button
            v-for="item in agentOptions"
            :key="item"
            type="button"
            class="filter-option"
            role="menuitemradio"
            :aria-checked="agent === item"
            @click="
              agent = item;
              menu = '';
            "
          >
            <svg class="filter-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
            <span class="filter-option-label">{{ agentLabel(item) }}</span>
            <span class="filter-count">{{
              agentCount(item)
            }}</span>
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
            <RouterLink :to="{ path: `/session/${item.session_id}`, query: host ? { host } : {} }"
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
                :to="{ path: `/session/${item.session_id}`, query: { subagent: child.agentId, ...(host ? { host } : {}) } }"
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
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch, toRefs } from "vue";
import { useSessionBrowserFilters } from "../../composables/useSessionBrowserFilters";
import { useLocale } from "../../composables/useLocale";
import { agentDisplayName } from "../../utils/agentDisplay";
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
const hostFilterTrigger = ref<HTMLButtonElement | null>(null);
const hostFilterSearch = ref<HTMLInputElement | null>(null);
const { t } = useLocale();
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
  sessionSnapshot = ref<any[] | null>(null),
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
  const daemon = personalHosts.value.find((item) => item.daemon_id === id);
  return daemon?.daemon_alias || daemon?.alias || daemon?.hostname || id || t('session.host_filter_all');
}
async function toggleHostFilter() {
  menu.value = menu.value === "host" ? "" : "host";
  if (menu.value === "host") {
    hostQuery.value = "";
    await nextTick();
    hostFilterSearch.value?.focus();
  }
}
function selectHostFilter(id: string) {
  host.value = id;
  menu.value = "";
  hostFilterTrigger.value?.focus();
}
function closeWithEscape() {
  const wasHostMenu = menu.value === "host";
  menu.value = "";
  projectMenu.value = "";
  if (wasHostMenu) hostFilterTrigger.value?.focus();
}
function agentLabel(value: string) {
  return value ? agentDisplayName(value) : t('session.agent_filter_all');
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
// The organized list is paginated and host-scoped. Use the personal Relay
// snapshot for host options and counts so switching hosts never loses options.
const browserSessions = computed(() => sessionSnapshot.value ?? allRows.value);
const scopedSessions = computed(() => browserSessions.value.filter(
  item => (!host.value || item.daemon_id === host.value) &&
    (archived.value ? !!item.archived_at : !item.archived_at),
));
function sessionAgent(item: any): string {
  const value = String(item.agent_type || item.agent || "claude-code");
  return value === "claude" ? "claude-code" : value;
}
function agentCount(value: string) {
  return scopedSessions.value.filter(item => !value || sessionAgent(item) === value).length;
}
const agentOptions = computed(
  () =>
    [
      "",
      ...new Set(scopedSessions.value.map(sessionAgent)),
    ] as string[],
);
const filtered = computed(() =>
  allRows.value.filter(
    (item) =>
      (!agent.value || sessionAgent(item) === agent.value) &&
      `${item.title} ${item.cwd} ${item.session_id}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const personalHosts = computed(() => {
  const hosts = new Map<string, any>();
  for (const daemon of daemons.value) {
    hosts.set(daemon.daemon_id, { ...daemon, count: 0 });
  }
  for (const session of browserSessions.value) {
    if (!session.daemon_id) continue;
    let daemon = hosts.get(session.daemon_id);
    if (!daemon) {
      daemon = {
        daemon_id: session.daemon_id,
        daemon_alias: session.daemon_alias,
        hostname: session.hostname,
        status: session.daemon_online ? "online" : "offline",
        count: 0,
      };
      hosts.set(session.daemon_id, daemon);
    }
    daemon.count++;
  }
  return [...hosts.values()];
});
const hostOptions = computed(() =>
  [
    {
      daemon_id: "",
      hostname: t('session.host_filter_all'),
      count: browserSessions.value.length,
      status: personalHosts.value.some((item) => item.status === "online")
        ? "online"
        : "offline",
    },
    ...personalHosts.value,
  ].filter((item) =>
    `${item.daemon_alias || item.alias || ""} ${item.hostname} ${item.daemon_id}`
      .toLowerCase()
      .includes(hostQuery.value.trim().toLowerCase()),
  ),
);
const scopedHosts = computed(() =>
  personalHosts.value.filter((item) => !host.value || item.daemon_id === host.value),
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
watch(agentOptions, options => {
  if (sessionSnapshot.value && agent.value && !options.includes(agent.value)) agent.value = "";
});
onMounted(() => {
  document.addEventListener("click", closeMenus);
  connect();
  cleanups.push(
    onEvent("daemon_list", (message: any) => {
      daemons.value = (message.daemons || []).map((daemon: any) => ({
        ...daemon,
        status: (daemon.daemon_online ?? daemon.online ?? (daemon.status === "online"))
          ? "online" : "offline",
      }));
    }),
    onEvent("session_list", (message: any) => {
      sessionSnapshot.value = message.sessions || [];
    }),
    onEvent("daemon_status", (message: any) => {
      const daemon = daemons.value.find(item => item.daemon_id === message.daemon_id);
      if (daemon) daemon.status = message.status;
      for (const session of sessionSnapshot.value || []) {
        if (session.daemon_id === message.daemon_id) session.daemon_online = message.status === "online";
      }
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
        send({ type: "list_sessions" });
      }),
    );
  send({ type: "list_daemons" });
  send({ type: "list_sessions" });
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
  min-width: 0;
}
.filter-wrap {
  position: relative;
}
.host-filter-popover { padding: 10px 10px 0; }
.agent-filter-popover { padding: 8px 10px; border-bottom: 1px solid var(--sidebar-border); }
.filter-trigger {
  width: 100%;
  min-width: 0;
  height: 34px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  color: var(--fg-secondary);
  text-align: center;
  cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
}
.filter-trigger:hover,
.filter-trigger[aria-expanded="true"] { border-color: var(--border-light); color: var(--fg); background: var(--surface-hover); }
.filter-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.host-trigger { height: 52px; text-align: left; }
.filter-trigger > svg { stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.filter-trigger-label { min-width: 0; overflow: hidden; font-size: 11.5px; font-weight: 600; line-height: 1; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.filter-chevron { justify-self: end; transition: transform .15s ease; }
.filter-trigger[aria-expanded="true"] .filter-chevron { transform: rotate(180deg); }
svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  flex: none;
}
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
.search {
  padding: 8px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font: 11px var(--font-body);
}
.filter-menu { position: absolute; z-index: 60; top: calc(100% - 3px); right: 10px; left: 10px; display: flex; flex-direction: column; gap: 2px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); }
.filter-option { width: 100%; min-width: 0; min-height: 34px; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 8px; overflow: hidden; border: 0; border-radius: var(--radius-sm); color: var(--fg-secondary); background: transparent; font: 12px/1.2 var(--font-body); text-align: left; cursor: pointer; }
.filter-option:hover,
.filter-option:focus-visible { color: var(--fg); background: var(--surface-hover); outline: none; }
.filter-option[aria-checked="true"] { color: var(--fg); background: var(--accent-muted); }
.filter-check { width: 14px; height: 14px; opacity: 0; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.filter-option[aria-checked="true"] .filter-check { opacity: 1; }
.filter-option-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-count { min-width: 20px; color: var(--fg-tertiary); font: 10.5px/1 var(--font-mono); text-align: right; }
.host-filter-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.host-filter-copy > span,
.host-filter-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-filter-copy > span { color: var(--fg); font-size: 12px; }
.host-filter-copy > small { color: var(--fg-tertiary); font-size: 10px; font-weight: 400; }
.host-filter-menu { top: calc(100% + 5px); padding: 7px; }
.host-filter-search { width: 100%; min-width: 0; padding: 9px; border: 1px solid var(--border-light); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); font: 12px var(--font-body); }
.host-filter-search:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.host-filter-options { max-height: min(360px, 45dvh); overflow-y: auto; margin-top: 5px; }
.host-filter-option { grid-template-columns: 7px minmax(0, 1fr) auto 12px; min-height: 53px; }
.host-filter-option[aria-pressed="true"] { background: var(--accent-muted); }
.host-filter-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.host-filter-check { color: var(--accent); }
.host-filter-empty { padding: 20px 10px; color: var(--fg-secondary); text-align: center; font-size: 12px; }
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
@media(max-width:768px) { .panel-head,header { padding-left:52px; } }
</style>
