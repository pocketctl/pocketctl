<template>
  <div class="session-scope-switcher" role="group" :aria-label="t('session.scope_label')">
    <button type="button" :class="{ active: modelValue.type === 'personal' }"
      :aria-pressed="modelValue.type === 'personal'" @click="selectPersonal">
      {{ t('session.scope_personal') }}
    </button>
    <button v-for="team in teams" :key="team.id" type="button"
      :class="{ active: modelValue.type === 'team' && modelValue.teamId === team.id }"
      :aria-pressed="modelValue.type === 'team' && modelValue.teamId === team.id"
      @click="selectTeam(team.id)">
      {{ team.name }}
    </button>
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
.session-scope-switcher { min-width: 0; display: flex; gap: 3px; padding: 3px; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-secondary); scrollbar-width: none; }
.session-scope-switcher::-webkit-scrollbar { display: none; }
.session-scope-switcher button { min-width: 0; flex: 0 0 auto; padding: 6px 10px; overflow: hidden; border: 0; border-radius: 6px; color: var(--fg-secondary); background: transparent; font: 600 11px var(--font-body); text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.session-scope-switcher button:hover { color: var(--fg); background: var(--surface-hover); }
.session-scope-switcher button.active { color: var(--fg); background: var(--surface); box-shadow: 0 1px 4px rgba(0, 0, 0, .12); }
.session-scope-switcher button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
