<template>
  <div class="agent-picker" data-testid="team-agent-picker">
    <div v-if="loading" class="picker-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!candidates.length" class="picker-empty">{{ t('team.agents_empty') }}</div>
    <section v-for="host in hosts" :key="host.id" class="installed-host" role="group" :aria-label="host.name">
      <header class="host-heading">
        <WorkspaceIcon name="laptop" class="host-icon" />
        <strong :title="host.name">{{ host.name }}</strong>
        <span class="availability" :class="host.agents.some(agent => agent.availability === 'occupied') ? 'occupied' : host.online ? 'online' : 'offline'">{{ t(host.agents.some(agent => agent.availability === 'occupied') ? 'team.availability.occupied' : host.online ? 'team.availability.online' : 'team.availability.offline') }}</span>
      </header>
      <div class="host-agents">
        <label
          v-for="candidate in host.agents"
          :key="candidateKey(candidate)"
          class="agent-option"
          :class="{ disabled: disabled || !selectable(candidate) }"
        >
          <input
            type="checkbox"
            :value="candidateKey(candidate)"
            :checked="modelValue.includes(candidateKey(candidate))"
            :disabled="disabled || !selectable(candidate)"
            :data-testid="`team-agent-${candidateKey(candidate)}`"
            @change="toggle(candidate)"
          />
          <span class="agent-copy">
            <strong>{{ providerLabel(candidate.provider) }}</strong>
            <span>{{ availabilityCopy(candidate) }}</span>
          </span>
        </label>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import WorkspaceIcon from '../WorkspaceIcon.vue'
import { teamProviderLabel } from '../../utils/teamProvider'
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { TeamAgentCandidate, TeamProvider } from '../../types/team'

const props = withDefaults(defineProps<{
  candidates: TeamAgentCandidate[]
  modelValue: string[]
  loading?: boolean
  disabled?: boolean
}>(), { loading: false, disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()
const { t } = useLocale()

const hosts = computed(() => {
  const grouped = new Map<string, { id:string; name:string; online:boolean; agents:TeamAgentCandidate[] }>()
  for(const candidate of props.candidates) {
    let host=grouped.get(candidate.daemon_id)
    if(!host) {host={id:candidate.daemon_id,name:candidate.alias?.trim()||candidate.hostname||candidate.daemon_id,online:candidate.online,agents:[]};grouped.set(candidate.daemon_id,host)}
    host.agents.push(candidate)
  }
  return [...grouped.values()]
})

function candidateKey(candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>): string {
  return `${candidate.daemon_id}:${candidate.provider}`
}

function selectable(candidate: TeamAgentCandidate): boolean {
  return candidate.installed && candidate.availability !== 'occupied'
}

function providerLabel(provider: TeamProvider): string {
  return teamProviderLabel(provider)
}

function availabilityCopy(candidate: TeamAgentCandidate): string {
  if (candidate.availability === 'online') return t('team.agent_callable')
  if (candidate.availability === 'offline') return t('team.agent_offline_copy')
  if (candidate.availability === 'occupied') return t('team.agent_occupied_copy')
  if (candidate.availability === 'unmanaged') return t('team.agent_unmanaged_copy')
  return candidate.installed ? t('team.agent_unsupported_copy') : t('team.agent_not_installed')
}

function toggle(candidate: TeamAgentCandidate): void {
  const key = candidateKey(candidate)
  const next = props.modelValue.includes(key)
    ? props.modelValue.filter(value => value !== key)
    : [...props.modelValue, key]
  emit('update:modelValue', next)
}
</script>

<style scoped>
.agent-picker { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; min-width: 0; width: 100%; }
.installed-host { min-width: 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--surface); }
.host-heading { display: flex; align-items: center; gap: 9px; padding: 11px 14px; background: var(--surface-hover); border-bottom: 1px solid var(--border); }
.host-icon { width: 16px; height: 16px; flex: none; color: var(--fg-secondary); }
.host-heading strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; }
.host-agents { display: grid; grid-template-columns: minmax(0, 1fr); padding: 5px; gap: 3px; }
.agent-option { display: flex; align-items: center; gap: 11px; min-width: 0; min-height: 58px; padding: 10px; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.agent-option:hover:not(.disabled) { background: var(--surface-hover); }
.agent-option:has(input:checked) { background: var(--accent-subtle); border-color: var(--accent); }
.agent-option:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
.agent-option.disabled { opacity: .6; cursor: not-allowed; }
.agent-option input { width: 16px; height: 16px; margin: 0; flex: none; accent-color: var(--accent); }
.agent-copy { min-width: 0; display: grid; gap: 3px; }
.agent-copy strong { color: var(--fg); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.agent-copy > span { color: var(--fg-secondary); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.availability { flex: none; padding: 3px 7px; border-radius: 5px; font-size: 11px; color: var(--fg-secondary); background: var(--surface-hover); }
.availability.online { color: var(--success); background: color-mix(in srgb, var(--success) 10%, transparent); }
.availability.offline, .availability.occupied { color: var(--warning); background: color-mix(in srgb, var(--warning) 10%, transparent); }
.picker-empty { padding: 22px; border: 1px dashed var(--border); border-radius: 10px; color: var(--fg-tertiary); font-size: 12px; text-align: center; }
</style>
