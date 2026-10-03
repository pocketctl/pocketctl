<template>
  <aside
    class="team-session-browser"
    data-testid="team-session-browser"
    @keydown.esc="
      menu = '';
      rowMenu = '';
    "
  >
    <header class="panel-head">
      <div>
        <h3> {{ t('workspace.team_sessions') }} </h3>
        <small>{{ t('workspace.sessions_count', {count:hostRows.length}) }}</small>
      </div>
      <button
        class="new-button"
        :aria-label="t('workspace.new_shared_session')"
        :disabled="
          !teamId || teamAccess.capabilities.value?.writes_enabled !== true
        "
        @click="createOpen = true"
      >
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </header>
    <SessionScopeSwitcher
      :model-value="{ type: 'team', teamId }"
      :teams="teams"
      @update:model-value="changeScope"
    />
    <div ref="filtersElement" class="browser-filters">
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
            ><small> {{ t('workspace.participating_hosts') }} </small
            ><strong>{{
              hosts.find((host) => host.id === daemon)?.name || t('session.host_filter_all')
            }}</strong></span
          ><svg class="chevron" viewBox="0 0 24 24">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        <div v-if="menu === 'host'" class="filter-menu host-filter-menu">
          <input
            v-model="hostQuery"
            type="search"
            :aria-label="t('hosts.search_hosts')"
            :placeholder="t('workspace.search_host_names')"
          />
          <div class="host-filter-options">
          <button
            v-for="host in hostOptions"
            :key="host.id"
            type="button"
            class="filter-option host-filter-option"
            :aria-pressed="daemon === host.id"
            @click="
              daemon = host.id;
              menu = '';
            "
          >
            <i :class="['dot', { offline: !host.online }]" aria-hidden="true"></i
            ><span class="host-filter-copy"
              ><span>{{ host.name }}</span
              ><small>{{
                host.id
                  ? `${host.online ? t('team.online') : t('team.availability.offline')} · ${host.id}`
                  : t('workspace.hosts_in_scope')
              }}</small></span
            ><span class="filter-count">{{
              rows.filter(
                (item) =>
                  !host.id ||
                  item.agent_bindings.some(
                    (binding) => binding.daemon_id === host.id,
                  ),
              ).length
            }}</span>
            <svg class="filter-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
          </button>
          <p v-if="!hostOptions.length" class="host-filter-empty"> {{ t('session.host_filter_no_match') }} </p>
          </div>
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
          ><span class="filter-trigger-label"
            >{{ providerLabel(provider) }}（{{ filtered.length }}）</span
          ><svg class="chevron" viewBox="0 0 24 24">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>
        <div v-if="menu === 'agent'" class="filter-menu" role="menu" :aria-label="t('session.agent_filter_label')">
          <button
            v-for="agent in ['', 'codex', 'claude-code']"
            :key="agent"
            type="button"
            class="filter-option"
            role="menuitemradio"
            :aria-checked="provider === agent"
            @click="
              provider = agent;
              menu = '';
            "
          >
            <svg class="filter-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
            <span class="filter-option-label">{{ providerLabel(agent) }}</span
            ><span class="filter-count">{{
              hostRows.filter((item) => !agent || matches(item, daemon, agent))
                .length
            }}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="presence">
      <i
        :class="['dot', { offline: !scopedHosts.some((host) => host.online) }]"
      ></i
      ><span
        >{{ scopedHosts.filter((host) => host.online).length }} /
        {{ t('workspace.online_hosts_count', {count:scopedHosts.length}) }}</span
      ><button :aria-label="t('workspace.search_sessions')" @click="searchOpen = !searchOpen">
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="7" />
          <path d="m16 16 4 4" />
        </svg>
      </button>
    </div>
    <input
      v-if="searchOpen"
      v-model="query"
      class="session-search"
      type="search"
      :aria-label="t('workspace.search_shared_sessions')"
      :placeholder="t('workspace.search_loaded_sessions')"
    />
    <nav class="browser-list" :aria-label="t('workspace.shared_session_list')">
      <button v-if="archived" class="archive-toggle" @click="archived = false"> {{ t('workspace.back_to_sessions') }} </button>
      <div class="list-heading">{{ archived ? t('team.task_filter.archived') : t('memory.search_suggestion_shared') }}</div>
      <div
        v-for="item in filtered"
        :key="item.id"
        :class="[
          'session-row',
          { active: item.id === currentSessionId && teamId === currentTeamId },
        ]"
      >
        <RouterLink
          :to="{ name: 'team-session', params: { teamId, id: item.id } }"
          @click="emit('opened', item.id)"
          ><i :class="['dot', { offline: item.state !== 'active' }]"></i>
          <div>
            <strong>{{ item.title }}</strong
> <small>{{ t('workspace.shared_session_meta', {people:item.participants.length, agents:item.agent_bindings.length, date:new Date(item.updated_at).toLocaleDateString(), hosts:new Set(item.agent_bindings.map(binding => binding.daemon_id)).size}) }}</small>
          </div></RouterLink
        >
        <button
          class="row-more"
          :aria-label="t('workspace.session_named_actions', {title:item.title})"
          aria-haspopup="menu"
          :aria-expanded="rowMenu === item.id"
          @click="rowMenu = rowMenu === item.id ? '' : item.id"
        >
          ···
        </button>
        <div v-if="rowMenu === item.id" class="row-menu" role="menu">
          <button role="menuitem" @click="copySessionID(item.id)"> {{ t('session.actions.copy_id') }} </button>
          <button
            v-if="item.creator_user_id === user?.id && teamAccess.capabilities.value?.writes_enabled"
            role="menuitem"
            @click="
              editing = item;
              renameTitle = item.title;
              rowMenu = '';
            "
          > {{ t('workspace.rename') }} </button
          ><button
            v-if="item.state !== 'archived' && item.creator_user_id === user?.id && teamAccess.capabilities.value?.writes_enabled"
            role="menuitem"
            @click="
              archiveTarget = item;
              rowMenu = '';
            "
          > {{ t('workspace.archive_session') }} </button>
        </div>
      </div>
      <p v-if="loading" class="empty"> {{ t('common.loading') }} </p>
      <p v-else-if="error" class="empty" role="alert">
        {{ error }} <button @click="load"> {{ t('common.retry') }} </button>
      </p>
      <p v-else-if="!filtered.length" class="empty">
        {{ teamId ? t('workspace.no_filtered_sessions') : t('workspace.join_team_hint')
        }}<button
          v-if="teamId"
          @click="
            daemon = '';
            provider = '';
            query = '';
            archived = false;
          "
        > {{ t('workspace.reset_filters') }} </button
        ><RouterLink v-else to="/teams"> {{ t('workspace.open_team') }} </RouterLink>
      </p>
      <button v-if="!archived" class="archive-toggle" @click="archived = true"> {{ t('team.task_filter.archived') }} <span>{{
          sessions.filter((item) => item.state === "archived").length
        }}</span>
      </button>
    </nav>
    <TeamOverlay actions v-if="editing" :title="t('workspace.rename_shared_session')" @close="editing = null"
      ><form
        class="rename-form"
        @submit.prevent="mutate(editing, { title: renameTitle })"
      >
        <input
          v-model.trim="renameTitle"
          maxlength="240"
          required
          :aria-label="t('workspace.session_name')"
        />
        <p v-if="error" role="alert">{{ error }}</p>
        <button :disabled="mutationBusy || !renameTitle"> {{ t('common.save') }} </button>
      </form></TeamOverlay
    >
    <TeamOverlay actions
      v-if="archiveTarget"
      :title="t('workspace.archive_session')"
      @close="archiveTarget = null"
      ><p class="archive-note"> {{ t('workspace.archive_shared_hint') }} </p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template #footer
        ><button
          :disabled="mutationBusy"
          @click="mutate(archiveTarget, { state: 'archived' })"
        > {{ t('workspace.confirm_archive') }} </button></template
      ></TeamOverlay
    >
    <TeamSessionCreateDialog
      v-if="createOpen"
      :team-id="teamId"
      @close="createOpen = false"
    />
  </aside>
</template>
<script setup lang="ts">
import { useLocale } from "../../composables/useLocale"
const { t } = useLocale()
import { computed, onBeforeUnmount, onMounted, ref, watch, toRefs } from "vue";
import { useSessionBrowserFilters } from "../../composables/useSessionBrowserFilters";
import { useAuth } from "../../composables/useAuth";
import TeamOverlay from "../team/TeamOverlay.vue";
import { useTeamAccess } from "../../composables/useTeamAccess";
import SessionScopeSwitcher from "./SessionScopeSwitcher.vue";
import TeamSessionCreateDialog from "../team/TeamSessionCreateDialog.vue";
import {
  updateTeamSession,
  getTeamSession,
  listTeams,
  listTeamSessions,
  listTeamAgentOffers,
  listTeamAgentCandidates,
} from "../../services/teamClient";
import type {
  TeamAgentCandidate,
  TeamAgentOffer,
  TeamSession,
  TeamSessionSummary,
  TeamSummary,
} from "../../types/team";
import type { SessionScope } from "../../composables/useScopedSessionState";
const props = defineProps<{
  teamId: string;
  currentSessionId?: string;
  currentTeamId?: string;
}>();
const emit = defineEmits<{
  "update:scope": [scope: SessionScope];
  filtered: [outside: boolean];
  opened: [id: string];
  updated: [session: TeamSession];
}>();
const teams = ref<TeamSummary[]>([]),
  sessions = ref<TeamSessionSummary[]>([]),
  offers = ref<TeamAgentOffer[]>([]),
  candidates = ref<TeamAgentCandidate[]>([]);
const filters = useSessionBrowserFilters(
  computed<SessionScope>(() => ({ type: "team", teamId: props.teamId })),
);
const {
  host: daemon,
  agent: provider,
  query,
  archived,
  searchOpen,
} = toRefs(filters);
const teamAccess = useTeamAccess(),
  { user } = useAuth();
const rowMenu = ref(""),
  editing = ref<TeamSessionSummary | null>(null),
  renameTitle = ref(""),
  archiveTarget = ref<TeamSessionSummary | null>(null),
  mutationBusy = ref(false);
async function copySessionID(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    rowMenu.value = "";
  } catch {
    error.value = t('workspace.copy_id_failed');
  }
}
async function mutate(
  item: TeamSessionSummary,
  input: { title?: string; state?: "archived" },
) {
  mutationBusy.value = true;
  error.value = "";
  try {
    const current = await getTeamSession(item.id);
    const updated = await updateTeamSession(current, input);
    sessions.value = sessions.value.map((row) =>
      row.id === updated.id ? updated : row,
    );
    emit("updated", updated);
    editing.value = null;
    archiveTarget.value = null;
    rowMenu.value = "";
  } catch (failure) {
    error.value =
      failure instanceof Error ? failure.message : "Operation failed";
  } finally {
    mutationBusy.value = false;
  }
}
const hostQuery = ref(""),
  menu = ref(""),
  createOpen = ref(false),
  loading = ref(false),
  error = ref(""),
  filtersElement = ref<HTMLElement | null>(null);
let generation = 0;
const selectedTeam = computed(() =>
  teams.value.find((team) => team.id === props.teamId),
);
function providerLabel(value: string) {
  return value === "codex"
    ? "Codex"
    : value === "claude-code"
      ? "Claude Code"
      : t('session.agent_filter_all');
}
function matches(item: TeamSessionSummary, host: string, agent: string) {
  return (
    (!host && !agent) ||
    item.agent_bindings.some(
      (binding) =>
        (!host || binding.daemon_id === host) &&
        (!agent || binding.provider === agent),
    )
  );
}
const rows = computed(() =>
  sessions.value.filter((item) =>
    archived.value ? item.state === "archived" : item.state !== "archived",
  ),
);
const hosts = computed(() => {
  const all = new Map<string, { id: string; name: string; online: boolean }>();
  for (const offer of offers.value) {
    const current = all.get(offer.daemon_id),
      candidate = candidates.value.find(
        (item) => item.daemon_id === offer.daemon_id,
      );
    all.set(offer.daemon_id, {
      id: offer.daemon_id,
      name: candidate?.hostname || offer.daemon_id,
      online: !!current?.online || offer.online,
    });
  }
  return [...all.values()];
});
const hostOptions = computed(() =>
  [
    {
      id: "",
      name: t('session.host_filter_all'),
      online: hosts.value.some((host) => host.online),
    },
    ...hosts.value,
  ].filter((host) =>
    `${host.name} ${host.id}`
      .toLowerCase()
      .includes(hostQuery.value.toLowerCase()),
  ),
);
const scopedHosts = computed(() =>
  hosts.value.filter((host) => !daemon.value || host.id === daemon.value),
);
const hostRows = computed(() =>
  rows.value.filter((item) => matches(item, daemon.value, "")),
);
const filtered = computed(() =>
  hostRows.value.filter(
    (item) =>
      matches(item, daemon.value, provider.value) &&
      item.title.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
);
function revealCurrent() {
  daemon.value = "";
  provider.value = "";
  query.value = "";
  archived.value =
    sessions.value.find((item) => item.id === props.currentSessionId)?.state ===
    "archived";
}
defineExpose({ revealCurrent });
function changeScope(scope: SessionScope) {
  emit("update:scope", scope);
}
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  sessions.value = [];
  offers.value = [];
  candidates.value = [];
  try {
    const nextTeams = await listTeams();
    if (current !== generation) return;
    teams.value = nextTeams;
    if (!props.teamId) return;
    const [nextSessions, nextOffers, nextCandidates] = await Promise.all([
      listTeamSessions(props.teamId),
      listTeamAgentOffers(props.teamId),
      listTeamAgentCandidates(props.teamId).catch(() => []),
    ]);
    if (current !== generation) return;
    sessions.value = nextSessions;
    offers.value = nextOffers.filter((offer) => offer.state === "active");
    candidates.value = nextCandidates;
  } catch (failure) {
    if (current === generation)
      error.value = failure instanceof Error ? failure.message : t('workspace.load_failed');
  } finally {
    if (current === generation) loading.value = false;
  }
}
function outsideClick(event: MouseEvent) {
  if (!filtersElement.value?.contains(event.target as Node)) menu.value = "";
  if (!(event.target as HTMLElement).closest(".session-row"))
    rowMenu.value = "";
}
watch(
  () => props.teamId,
  () => {
    void load();
  },
  { immediate: true },
);
watch([filtered, loading], () => {
  if (!loading.value)
    emit(
      "filtered",
      !!props.currentSessionId &&
        (!filtered.value.some((item) => item.id === props.currentSessionId) ||
          props.currentTeamId !== props.teamId),
    );
});
onMounted(() => document.addEventListener("click", outsideClick));
onBeforeUnmount(() => {
  generation++;
  document.removeEventListener("click", outsideClick);
});
</script>
<style scoped>
.team-session-browser {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: var(--fg);
  font-size: 12px;
}
.panel-head {
  height: 66px;
  min-height: 66px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  box-sizing: border-box;
}
.panel-head > div {
  min-width: 0;
}
.panel-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.panel-head small {
  display: block;
  margin-top: 4px;
  color: var(--fg-tertiary);
  font-size: 11px;
}
.new-button {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--fg-secondary);
  cursor: pointer;
}
.new-button svg {
  width: 14px;
  height: 14px;
}
.browser-filters {
  padding: 10px 10px 8px;
  display: grid;
  gap: 8px;
}
.filter-wrap {
  position: relative;
}
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
  color: var(--fg-secondary);
  background: var(--surface);
  cursor: pointer;
  text-align: left;
  font: 12px var(--font-body);
  transition: color .15s, border-color .15s, background .15s;
}
.filter-trigger:hover,
.filter-trigger[aria-expanded="true"] { border-color: var(--border-light); color: var(--fg); background: var(--surface-hover); }
.filter-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.host-trigger { height: 52px; }
svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  width: 15px;
  height: 15px;
  flex: none;
}
.filter-trigger > span,
.filter-trigger > strong {
  min-width: 0;
}
.filter-trigger > svg { stroke-width: 1.8; }
.filter-trigger strong {
  font-weight: 500;
  color: var(--fg);
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filter-trigger small {
  display: block;
  margin-bottom: 4px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.filter-trigger-label { overflow: hidden; font-size: 11.5px; font-weight: 600; line-height: 1; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.chevron {
  justify-self: end;
  transition: transform .15s ease;
}
.filter-trigger[aria-expanded="true"] .chevron { transform: rotate(180deg); }
.filter-menu {
  position: absolute;
  z-index: 60;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
.host-filter-menu { padding: 7px; }
.filter-menu input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  color: var(--fg);
  background: var(--bg);
  font: 12px var(--font-body);
}
.filter-menu input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
.filter-option {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  overflow: hidden;
  text-align: left;
  border: 0;
  background: transparent;
  color: var(--fg-secondary);
  font: 12px/1.2 var(--font-body);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.filter-option:hover,
.filter-option:focus-visible {
  color: var(--fg);
  background: var(--surface-hover);
  outline: none;
}
.filter-option[aria-checked="true"],
.filter-option[aria-pressed="true"] { color: var(--fg); background: var(--accent-muted); }
.filter-option-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-check { width: 14px; height: 14px; opacity: 0; stroke: var(--accent); stroke-width: 2; }
.filter-option[aria-checked="true"] .filter-check,
.filter-option[aria-pressed="true"] .filter-check { opacity: 1; }
.filter-count { min-width: 20px; color: var(--fg-tertiary); font: 10.5px/1 var(--font-mono); text-align: right; }
.host-filter-options { max-height: min(360px, 45dvh); overflow-y: auto; margin-top: 5px; }
.host-filter-option { grid-template-columns: 7px minmax(0, 1fr) auto 14px; min-height: 53px; }
.host-filter-option:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.host-filter-copy { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.host-filter-copy > span,
.host-filter-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host-filter-copy > span { color: var(--fg); font-size: 12px; }
.host-filter-copy > small { color: var(--fg-tertiary); font-size: 10px; font-weight: 400; }
.host-filter-empty { padding: 20px 10px; color: var(--fg-secondary); text-align: center; font-size: 12px; }
.dot {
  width: 6px;
  height: 6px;
  background: var(--success);
  border-radius: 50%;
  flex: none;
  display: inline-block;
}
.dot.offline {
  background: var(--fg-tertiary);
}
.presence {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.presence > span {
  flex: 1;
}
.presence button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
}
.session-search {
  margin: 0 12px 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  background: var(--bg);
  font: 11px var(--font-body);
}
.browser-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 8px 14px;
}
.list-heading {
  padding: 9px 8px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 9px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--fg);
  text-decoration: none;
}
.session-row:hover {
  background: var(--surface-hover);
}
.session-row.active {
  background: var(--sidebar-active);
  border-color: var(--border-active, var(--accent-muted));
}
.session-row > div {
  min-width: 0;
  flex: 1;
}
.session-row strong {
  font-size: 12px;
  font-weight: 500;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row small {
  display: block;
  margin-top: 4px;
  color: var(--fg-tertiary);
  font-size: 10px;
}
.archive-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  padding: 12px 8px;
  border: 0;
  background: none;
  color: var(--fg-secondary);
  font: 11px var(--font-body);
  cursor: pointer;
}
.empty {
  padding: 24px 8px;
  color: var(--fg-secondary);
  line-height: 1.8;
  text-align: center;
  font-size: 12px;
}
.empty button,
.empty a {
  display: block;
  margin: 8px auto;
  border: 0;
  background: none;
  color: var(--accent);
  font: 11px var(--font-body);
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.team-session-browser {
  background: var(--bg-secondary);
}
.session-row {
  position: relative;
  min-height: 54px;
  padding: 8px 9px;
  margin-left: 13px;
  gap: 9px;
}
.session-row > a {
  display: flex;
  gap: 9px;
  align-items: center;
  flex: 1;
  min-width: 0;
  color: inherit;
  text-decoration: none;
}
.session-row > a > div {
  min-width: 0;
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
.session-row.active {
  box-shadow: inset 2px 0 0 var(--accent);
}
.row-more {
  flex: none;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--fg-tertiary);
  cursor: pointer;
}
.row-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 40;
  display: grid;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  min-width: 160px;
}
.row-menu button,
.rename-form button {
  padding: 9px 10px;
  color: var(--fg);
  border: 0;
  background: none;
  text-align: left;
  font: 12px/1.5 var(--font-body);
  cursor: pointer;
}
.row-menu button:hover {
  background: var(--surface-hover);
}
.rename-form {
  display: grid;
  gap: 16px;
}
.rename-form input {
  border: 1px solid var(--border);
  padding: 10px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: 12px var(--font-body);
}
.archive-note {
  font-size: 12px;
  line-height: 1.8;
  color: var(--fg-secondary);
}
.new-button {
  width: 32px;
  height: 32px;
  background: var(--surface);
  color: var(--accent);
}
.session-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row > a > div {
  flex: 1;
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
