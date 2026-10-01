<template>
  <div class="session-scope-switcher" role="group" :aria-label="t('session.scope_label')">
    <div class="session-scope-tabs"><button type="button" :class="{ active: modelValue.type === 'personal' }"
      :aria-pressed="modelValue.type === 'personal'" @click="selectPersonal">
      {{ t('session.scope_personal') }}
    </button>
    <button type="button" :class="{ active: modelValue.type === 'team' }" :aria-pressed="modelValue.type === 'team'" @click="selectTeam(modelValue.type === 'team' ? modelValue.teamId : teams[0]?.id || '')">{{ t('session.scope_team') }}</button>
    </div>
    <div v-if="modelValue.type === 'team'" class="browser-team-select">
      <label class="browser-team-field">
        <svg class="browser-team-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-4-5.65"/></svg>
        <span class="browser-team-caption" aria-hidden="true">{{ t('session.scope_team') }}</span>
        <select :value="modelValue.teamId" :disabled="!teams.length" aria-label="筛选团队"
          @change="selectTeam(($event.target as HTMLSelectElement).value)">
          <option v-if="!teams.length" value="">尚未加入团队</option>
          <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}</option>
        </select>
        <svg class="browser-team-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </label>
    </div>
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
.browser-team-field { position:relative; display:block; min-width:0; }
.browser-team-field svg { position:absolute; z-index:1; top:50%; width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; color:var(--fg-secondary); pointer-events:none; transform:translateY(-50%); }
.browser-team-icon { left:11px; }
.browser-team-field .browser-team-chevron { right:11px; }
.browser-team-caption { position:absolute; z-index:1; top:8px; left:35px; color:var(--fg-tertiary); font:400 10px/14px var(--font-body); pointer-events:none; }
.browser-team-select select { appearance:none; display:block; width:100%; min-width:0; height:52px; box-sizing:border-box; padding:23px 34px 8px 35px; overflow:hidden; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--surface); color:var(--fg); font:500 12px/18px var(--font-body); text-overflow:ellipsis; white-space:nowrap; cursor:pointer; transition:border-color .15s,background .15s; }
.browser-team-select select:hover:not(:disabled) { border-color:var(--border-light); background:var(--surface-hover); }
.browser-team-select select:disabled { color:var(--fg-tertiary); cursor:default; }
button:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
