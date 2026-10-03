<template>
  <TeamOverlay large :title="t('workspace.new_shared_session')" @close="emit('close')">
    <form
      id="team-shared-session-create-form"
      class="create-session"
      data-testid="team-session-create"
      @submit.prevent="create"
    >
      <label class="team-form-field"
        >{{ t('replica.session_name') }}<input
          v-model.trim="title"
          data-testid="team-session-title"
          required
          maxlength="240"
          :disabled="!!created"
      /></label>
      <label class="team-form-field"
        >{{ t('workspace.context_goal') }}<textarea
          v-model.trim="goal"
          data-testid="team-session-goal"
          rows="3"
          required
          maxlength="16000"
          :placeholder="t('replica.session_goal_placeholder')"
          :disabled="!!created"
        />
      </label>
      <label v-if="!taskId && tasks.length" class="team-form-field"
        ><span>{{ t('replica.linked_task') }} <small>{{ t('team.optional') }}</small></span><ActionSelect><select v-model="selectedTask" :aria-label="t('replica.linked_task')" :disabled="!!created">
          <option value="">{{ t('workspace.no_linked_task') }}</option>
          <option v-for="task in tasks" :key="task.id" :value="task.id">
            {{ task.title }}
          </option>
        </select></ActionSelect></label
      >
      <h3>{{ t('replica.session_members') }}</h3>
      <p>{{ t('replica.session_members_copy') }}</p>
      <label v-for="member in members" :key="member.id" class="person-choice"
        ><input
          v-model="selectedMembers"
          type="checkbox"
          :value="member.user_id"
          :disabled="!!created"
        />{{ member.display_label }}</label
      >
      <h3>{{ t('replica.session_agents') }}</h3>
      <p>{{ t('replica.session_agents_copy') }}</p>
      <label
        v-for="offer in offers"
        :key="offer.id"
        class="offer-choice"
        :class="{ unavailable: !offer.managed_callable }"
      >
        <input
          v-model="selected"
          type="checkbox"
          :value="offer.id"
          :disabled="!offer.managed_callable || !!created"
        />
        <span
          ><AgentBadge :agent="offer.provider" size="md" />
          <small
            >{{
              members.find((member) => member.user_id === offer.owner_user_id)
                ?.display_label || t('team.member')
            }}
            · {{ offer.daemon_id }}</small
          ></span
        >
        <small>{{ t(offer.managed_callable ? 'team.online' : 'replica.agent_not_callable') }}</small>
      </label>
      <p v-if="!loading && !offers.some((offer) => offer.managed_callable)">
        {{ t('replica.no_callable_agents') }}
      </p>
      <p v-if="error" role="alert">
        {{ created ? t('replica.session_setup_incomplete') : '' }}{{ error }}
      </p>
      <RouterLink
        v-if="created && error"
        :to="{ name: 'team-session', params: { teamId, id: created.id } }"
        >{{ t('replica.open_created_session') }}</RouterLink
      >

    </form>
      <template #footer>
        <button type="button" class="btn" :disabled="busy" @click="emit('close')">
          {{ t('common.cancel') }}</button
        ><button
          class="btn primary"
          type="submit" form="team-shared-session-create-form"
          :disabled="busy || loading || !title || !goal || !selected.length"
        >
          {{ t(busy ? 'common.loading' : created ? 'replica.retry_session_setup' : 'replica.create_session') }}
        </button>
      </template>
  </TeamOverlay>
</template>
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import TeamOverlay from "./TeamOverlay.vue";
import ActionSelect from "../ActionSelect.vue";
import AgentBadge from "../AgentBadge.vue";
import {useLocale} from "../../composables/useLocale";
import {
  createTeamContext,
  createTeamSession,
  getTeamContext,
  getTeamSession,
  listTeamAgentOffers,
  listTeamMembers,
  listTeamTasks,
  setTeamSessionParticipant,
} from "../../services/teamClient";
import type {
  TeamAgentOffer,
  TeamMember,
  TeamSession,
  TeamTask,
} from "../../types/team";
const {t}=useLocale();
const props = defineProps<{ teamId: string; taskId?: string }>();
const emit = defineEmits<{ close: [] }>(),
  router = useRouter();
const offers = ref<TeamAgentOffer[]>([]),
  members = ref<TeamMember[]>([]),
  tasks = ref<TeamTask[]>([]);
const selected = ref<string[]>([]),
  selectedMembers = ref<number[]>([]),
  selectedTask = ref(""),
  title = ref(""),
  goal = ref(""),
  busy = ref(false),
  loading = ref(true),
  error = ref(""),
  created = ref<TeamSession | null>(null);
let retrying = false;
onMounted(async () => {
  try {
    const result = await Promise.all([
      listTeamAgentOffers(props.teamId),
      listTeamMembers(props.teamId),
      listTeamTasks(props.teamId),
    ]);
    offers.value = result[0].filter((offer) => offer.state === "active");
    members.value = result[1];
    tasks.value = result[2].filter(
      (task) => !["archived", "deleted"].includes(task.state),
    );
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : t('team.load_failed');
  } finally {
    loading.value = false;
  }
});
async function create() {
  if (busy.value || !title.value || !goal.value || !selected.value.length)
    return;
  busy.value = true;
  error.value = "";
  try {
    if (!created.value)
      created.value = await createTeamSession(props.teamId, {
        title: title.value,
        offerIDs: selected.value,
        taskID: props.taskId || selectedTask.value || undefined,
      });
    else created.value = await getTeamSession(created.value.id);
    for (const userID of selectedMembers.value) {
      if (
        !created.value.participants.some(
          (member) => member.user_id === userID && member.state === "active",
        )
      )
        created.value = await setTeamSessionParticipant(
          created.value,
          userID,
          true,
        );
    }
    // On an uncertain response, read back before attempting the remaining step.
    const snapshot = retrying ? await getTeamContext(created.value.id) : null;
    if (!snapshot)
      await createTeamContext(created.value.id, {
        expectedRevision: 0,
        goal: goal.value,
        consensus: [],
        openQuestions: [],
        references: [],
      });
    else if (snapshot.goal !== goal.value)
      throw new Error(t('replica.session_existing_goal'));
    emit("close");
    await router.push({
      name: "team-session",
      params: { teamId: props.teamId, id: created.value.id },
    });
  } catch (failure) {
    retrying = true;
    error.value = failure instanceof Error ? failure.message : t('replica.session_create_failed');
  } finally {
    busy.value = false;
  }
}
</script>
<style scoped>
.create-session {
  display: grid;
  gap: 12px;
  font-size: 12px;
}
.team-form-field {
  display: grid;
  gap: 7px;
  color: var(--fg-secondary);
}
input:not([type="checkbox"]),
textarea,
select {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 11px;
  background: var(--surface);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  color: var(--fg);
  font: inherit;
}
textarea {
  resize: vertical;
}
p {
  margin: 0;
  color: var(--fg-secondary);
  line-height: 1.7;
}
h3 {
  margin: 10px 0 0;
  font-size: 12px;
  font-weight: 550;
}
.offer-choice {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 0;
  border-bottom: 1px solid var(--border);
}
.offer-choice > span {
  display: grid;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.offer-choice strong {
  font-weight: 550;
}
.offer-choice small {
  font-size: 11px;
  color: var(--fg-secondary);
  overflow-wrap: anywhere;
}
.person-choice {
  display: flex;
  align-items: center;
  gap: 8px;
}
.unavailable {
  opacity: 0.55;
}
input[type="checkbox"] {
  accent-color: var(--accent);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
button {
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: 550 12px/1.5 var(--font-body);
  cursor: pointer;
}
.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg-secondary);
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
a {
  color: var(--accent);
}
</style>
