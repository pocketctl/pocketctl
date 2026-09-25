<template>
  <aside class="participants-panel" data-testid="team-session-participants">
    <header><div><span>参与者与 Agent</span><strong>{{ session.participants.length }} 人 · {{ session.agent_bindings.length }} Agents</strong></div><button type="button" aria-label="关闭参与者" @click="$emit('close')">×</button></header>
    <div class="participants-body">
      <section>
        <small>参与成员</small>
        <div v-for="participant in session.participants" :key="participant.id" class="person-row">
          <span class="avatar">{{ memberLabel(participant.user_id).charAt(0).toUpperCase() }}</span>
          <div><strong>{{ memberLabel(participant.user_id) }}</strong><em>{{ participant.user_id === currentUserId ? '我' : '成员' }}</em></div>
          <button v-if="canManage && participant.user_id !== session.creator_user_id" type="button" :disabled="busy" @click="remove(participant.user_id)">移除</button>
        </div>
        <div v-if="canManage && availableMembers.length" class="add-person">
          <select v-model.number="selectedUserID"><option :value="0">添加团队成员…</option><option v-for="member in availableMembers" :key="member.id" :value="member.user_id">{{ member.display_label }}</option></select>
          <button type="button" :disabled="busy || !selectedUserID" @click="add">添加</button>
        </div>
      </section>
      <section>
        <small>Agent 绑定</small>
        <div v-for="binding in session.agent_bindings" :key="binding.id" class="agent-row">
          <span :class="['availability-dot', binding.availability]"></span>
          <div><strong>{{ binding.provider === 'codex' ? 'Codex' : 'Claude Code' }}</strong><em>{{ binding.daemon_id }} · {{ binding.availability }}</em></div>
          <RouterLink v-if="binding.owner_user_id === currentUserId && binding.native_session_id" :to="nativeSessionLink(binding.native_session_id)">原生会话</RouterLink>
        </div>
      </section>
      <p v-if="error" class="panel-error">{{ error }}</p>
      <p class="owner-boundary">原生会话和其中的工具审批仅对 Agent 所有者开放。</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { getTeamContext, getTeamSession, setTeamSessionParticipant } from '../../services/teamClient'
import type { TeamMember, TeamSession } from '../../types/team'

const props = defineProps<{ session: TeamSession; members: TeamMember[]; currentUserId: number }>()
const emit = defineEmits<{ close: []; updated: [session: TeamSession] }>()
const selectedUserID = ref(0), busy = ref(false), error = ref('')
const canManage = computed(() => props.session.creator_user_id === props.currentUserId)
const participantIDs = computed(() => new Set(props.session.participants.map(participant => participant.user_id)))
const availableMembers = computed(() => props.members.filter(member => member.state === 'active' && !participantIDs.value.has(member.user_id)))
function memberLabel(userID: number): string { return props.members.find(member => member.user_id === userID)?.display_label ?? `用户 ${userID}` }
function nativeSessionLink(nativeSessionID: string): string { return `/session/${encodeURIComponent(nativeSessionID)}?return_team_session=${encodeURIComponent(props.session.id)}&team=${encodeURIComponent(props.session.team_id)}` }
function failureMessage(failure: unknown): string { return failure instanceof Error ? failure.message : '操作失败' }
async function add(): Promise<void> {
  if (!selectedUserID.value) return
  busy.value = true; error.value = ''
  try {
    const context = await getTeamContext(props.session.id)
    if (context?.references.some(reference => reference.source_kind !== 'team_event' || reference.owner_scope_id !== null || reference.installation_id !== null)) {
      throw new Error('当前 Context 含有未确认对新成员可见的引用，已阻止加入')
    }
    const current = await getTeamSession(props.session.id)
    const updated = await setTeamSessionParticipant(current, selectedUserID.value, true)
    selectedUserID.value = 0; emit('updated', updated)
  } catch (failure) { error.value = failureMessage(failure) } finally { busy.value = false }
}
async function remove(userID: number): Promise<void> {
  busy.value = true; error.value = ''
  try { emit('updated', await setTeamSessionParticipant(props.session, userID, false)) }
  catch (failure) { error.value = failureMessage(failure) } finally { busy.value = false }
}
</script>

<style scoped>
.participants-panel { width: 320px; min-width: 270px; border-left: 1px solid var(--border); color: var(--fg); background: var(--surface); overflow-y: auto; }.participants-panel header { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); }.participants-panel header div { display: grid; gap: 3px; }.participants-panel header span { color: var(--fg-secondary); font-size: 10px; }.participants-panel header strong { font-size: 12px; }.participants-panel header button { border: 0; color: var(--fg-secondary); background: none; font-size: 22px; cursor: pointer; }.participants-body { padding: 16px; }.participants-body section { margin-bottom: 24px; }.participants-body section > small { display: block; margin-bottom: 9px; color: var(--accent); font: 650 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.person-row,.agent-row { min-height: 48px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid var(--border); }.person-row > div,.agent-row > div { min-width: 0; display: grid; gap: 3px; flex: 1; }.person-row strong,.agent-row strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; }.person-row em,.agent-row em { overflow: hidden; color: var(--fg-tertiary); font: normal 9px var(--font-mono); text-overflow: ellipsis; }.person-row button,.agent-row a,.add-person button { border: 0; color: var(--accent); background: none; font-size: 9px; cursor: pointer; text-decoration: none; }.avatar { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: var(--accent); background: var(--accent-muted); font-size: 10px; }.availability-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-tertiary); }.availability-dot.online { background: var(--success); }.availability-dot.offline,.availability-dot.occupied { background: var(--warning); }.add-person { display: flex; gap: 6px; margin-top: 10px; }.add-person select { min-width: 0; flex: 1; padding: 7px; border: 1px solid var(--border); border-radius: 7px; color: var(--fg); background: var(--bg); font-size: 10px; }.panel-error { color: var(--error); font-size: 10px; }.owner-boundary { color: var(--fg-tertiary); font-size: 10px; line-height: 1.55; }
@media (max-width: 900px) { .participants-panel { position: absolute; inset: 62px 0 0 auto; z-index: 80; width: min(350px, 90vw); box-shadow: -12px 0 30px rgba(0,0,0,.18); } }
</style>
