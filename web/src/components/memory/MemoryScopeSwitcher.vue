<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemoryGovernanceScope } from '../../types/memory'

const props = defineProps<{
  scopes: MemoryGovernanceScope[]
  modelValue: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
const { t } = useLocale()
const grouped = computed(() => ({
  personal: props.scopes.filter(scope => scope.owner_scope_kind === 'personal'),
  team: props.scopes.filter(scope => scope.owner_scope_kind === 'team'),
  organization: props.scopes.filter(scope => scope.owner_scope_kind === 'organization'),
}))
function label(scope: MemoryGovernanceScope): string {
  return `${t('memory.governance.scope.' + scope.owner_scope_kind)} · ${scope.owner_scope_id.slice(0, 8)}`
}
</script>

<template>
  <div class="memory-scope-switcher" role="group" :aria-label="t('memory.governance.scope.switcher')">
    <button
      v-for="scope in [...grouped.personal, ...grouped.team, ...grouped.organization]"
      :key="scope.installation_id"
      type="button"
      class="memory-scope-chip"
      :class="{ 'memory-scope-chip-active': scope.installation_id === modelValue,
                [`memory-scope-chip-${scope.owner_scope_kind}`]: true }"
      :aria-pressed="scope.installation_id === modelValue"
      @click="emit('update:modelValue', scope.installation_id)"
    >
      {{ label(scope) }}
      <span v-if="scope.state !== 'active'" class="memory-scope-state">{{ scope.state }}</span>
    </button>
    <p v-if="scopes.length === 0" class="memory-scope-empty">{{ t('memory.governance.scope.empty') }}</p>
  </div>
</template>
