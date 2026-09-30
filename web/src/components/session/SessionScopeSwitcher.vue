<template>
  <div class="session-scope-switcher" role="group" :aria-label="t('session.scope_label')">
    <div class="session-scope-tabs"><button type="button" :class="{ active: modelValue.type === 'personal' }"
      :aria-pressed="modelValue.type === 'personal'" @click="selectPersonal">
      {{ t('session.scope_personal') }}
    </button>
    <button type="button" :class="{ active: modelValue.type === 'team' }" :aria-pressed="modelValue.type === 'team'" @click="selectTeam(modelValue.type === 'team' ? modelValue.teamId : teams[0]?.id || '')">{{ t('session.scope_team') }}</button>
    </div>
    <div v-if="modelValue.type === 'team'" class="browser-team-select"><select v-if="modelValue.type === 'team'" :value="modelValue.teamId" aria-label="筛选团队" @change="selectTeam(($event.target as HTMLSelectElement).value)">
      <option v-if="!teams.length" value="">尚未加入团队</option>
      <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}</option>
    </select></div>
  </div>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { SessionScope } from '../../composables/useScopedSessionState'

defineProps<{
  modelValue: SessionScope
  teams: Array<{ id: string; name: string }>
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: SessionScope): void
}>()

const { t } = useLocale()

function selectPersonal(): void {
  emit('update:modelValue', { type: 'personal' })
}

function selectTeam(teamId: string): void {
  emit('update:modelValue', { type: 'team', teamId })
}
</script>

<style scoped>
.session-scope-switcher { min-width:0; }
.session-scope-tabs { display:flex; margin:10px 10px 0; padding:3px; border:1px solid var(--border); border-radius:7px; background:var(--bg); }
.session-scope-tabs button { flex:1; border:0; border-radius:4px; background:none; color:var(--fg-secondary); padding:7px; font:11px/1.5 var(--font-body); cursor:pointer; }
.session-scope-tabs button[aria-pressed=true] { background:var(--accent-muted); color:var(--accent); }
.browser-team-select { padding:10px 10px 0; }
.browser-team-select select { width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); font:12px/1.5 var(--font-body); }
button:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
