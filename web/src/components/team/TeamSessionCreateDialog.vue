<template>
  <TeamOverlay title="新建共享会话" @close="emit('close')">
    <form
      class="create-session"
      data-testid="team-session-create"
      @submit.prevent="create"
    >
      <label class="field"
        >会话名称<input
          v-model.trim="title"
          data-testid="team-session-title"
          required
          maxlength="240"
          :disabled="!!created"
      /></label>
      <label class="field"
        >本轮目标<textarea
          v-model.trim="goal"
          data-testid="team-session-goal"
          rows="3"
          required
          maxlength="16000"
          placeholder="这次希望一起讨论什么？"
          :disabled="!!created"
        />
      </label>
      <label v-if="!taskId && tasks.length" class="field"
        >关联任务 <small>可选</small
        ><select v-model="selectedTask" :disabled="!!created">
          <option value="">不关联任务</option>
          <option v-for="task in tasks" :key="task.id" :value="task.id">
            {{ task.title }}
          </option>
        </select></label
      >
      <h3>参与成员</h3>
      <p>Agent 的所有者自动参与；也可以邀请其他团队成员一起讨论。</p>
      <label v-for="member in members" :key="member.id" class="person-choice"
        ><input
          v-model="selectedMembers"
          type="checkbox"
          :value="member.user_id"
          :disabled="!!created"
        />{{ member.display_label }}</label
      >
      <h3>参与 Agent</h3>
      <p>选择团队成员提供的在线 Agent，每个 Agent 对应独立会话。</p>
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
          ><strong>{{
            offer.provider === "codex" ? "Codex" : "Claude Code"
          }}</strong
          ><small
            >{{
              members.find((member) => member.user_id === offer.owner_user_id)
                ?.display_label || "成员"
            }}
            · {{ offer.daemon_id }}</small
          ></span
        >
        <small>{{ offer.managed_callable ? "在线" : "当前不可调用" }}</small>
      </label>
      <p v-if="!loading && !offers.some((offer) => offer.managed_callable)">
        当前没有可调用的 Agent。请在团队中添加自己的 Agent，或等待主机上线。
      </p>
      <p v-if="error" role="alert">
        {{ created ? "会话已创建，以下设置尚未完成：" : "" }}{{ error }}
      </p>
      <RouterLink
        v-if="created && error"
        :to="{ name: 'team-session', params: { teamId, id: created.id } }"
        >打开已创建的会话</RouterLink
      >
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">
          取消</button
        ><button
          class="primary"
          :disabled="busy || loading || !title || !goal || !selected.length"
        >
          {{ busy ? "创建中…" : created ? "重试剩余设置" : "创建会话" }}
        </button>
      </footer>
    </form>
  </TeamOverlay>
</template>
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import TeamOverlay from "./TeamOverlay.vue";
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
    error.value = failure instanceof Error ? failure.message : "加载失败";
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
      throw new Error("会话已存在不同目标，请打开会话查看。");
    emit("close");
    await router.push({
      name: "team-session",
      params: { teamId: props.teamId, id: created.value.id },
    });
  } catch (failure) {
    retrying = true;
    error.value = failure instanceof Error ? failure.message : "创建失败";
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
.field {
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
