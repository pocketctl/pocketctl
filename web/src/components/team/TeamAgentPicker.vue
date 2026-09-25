<template>
  <div class="agent-picker" data-testid="team-agent-picker">
    <div v-if="loading" class="picker-empty">{{ t('common.loading') }}</div>
    <div v-else-if="!candidates.length" class="picker-empty">{{ t('team.agents_empty') }}</div>
    <label
      v-for="candidate in candidates"
      :key="candidateKey(candidate)"
      class="agent-option"
      :class="{ disabled: !selectable(candidate) }"
    >
      <input
        type="checkbox"
        :value="candidateKey(candidate)"
        :checked="modelValue.includes(candidateKey(candidate))"
        :disabled="disabled || !selectable(candidate)"
        :data-testid="`team-agent-${candidateKey(candidate)}`"
        @change="toggle(candidate)"
      />
      <span class="provider-mark">{{ candidate.provider === 'codex' ? 'C' : 'CC' }}</span>
      <span class="agent-copy">
        <strong>{{ providerLabel(candidate.provider) }}</strong>
        <small>{{ candidate.hostname || candidate.daemon_id }}</small>
        <span>{{ availabilityCopy(candidate) }}</span>
      </span>
      <span class="availability" :class="candidate.availability">{{ t(`team.availability.${candidate.availability}`) }}</span>
    </label>
  </div>
</template>

<script setup lang="ts">
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

function candidateKey(candidate: Pick<TeamAgentCandidate, 'daemon_id' | 'provider'>): string {
  return `${candidate.daemon_id}:${candidate.provider}`
}

function selectable(candidate: TeamAgentCandidate): boolean {
  return candidate.installed && candidate.availability !== 'occupied'
}

function providerLabel(provider: TeamProvider): string {
  return provider === 'claude-code' ? 'Claude Code' : 'Codex'
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
.agent-picker { display: grid; gap: 8px; }
.agent-option { min-height: 68px; display: flex; align-items: center; gap: 11px; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); cursor: pointer; }
.agent-option:has(input:checked) { border-color: var(--accent); background: var(--accent-subtle); }
.agent-option.disabled { opacity: .62; cursor: not-allowed; }
.agent-option input { accent-color: var(--accent); }
.provider-mark { width: 34px; height: 34px; flex: 0 0 34px; display: grid; place-items: center; border-radius: 9px; color: var(--accent); background: var(--accent-muted); font: 700 10px var(--font-mono); }
.agent-copy { min-width: 0; display: grid; gap: 2px; flex: 1; }
.agent-copy strong { font-size: 12px; }.agent-copy small { overflow: hidden; color: var(--fg-secondary); font: 10px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }.agent-copy > span { color: var(--fg-tertiary); font-size: 10px; }
.availability { flex: 0 0 auto; padding: 4px 7px; border-radius: 999px; color: var(--fg-secondary); background: var(--surface-hover); font-size: 10px; }
.availability.online { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
.availability.offline, .availability.occupied { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
.availability.unsupported, .availability.unmanaged { color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
.picker-empty { padding: 22px; border: 1px dashed var(--border); border-radius: var(--radius-md); color: var(--fg-tertiary); font-size: 12px; text-align: center; }
</style>
