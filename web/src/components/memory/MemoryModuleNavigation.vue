<template>
  <nav class="memory-module-navigation" :aria-label="t('memory.workspace_label')"
    data-testid="memory-module-rail">
    <section v-for="group in MEMORY_MODULE_GROUPS" :key="group.id" class="memory-module-group"
      :data-testid="`memory-module-group-${group.id}`">
      <h2>{{ t(`memory.group_${group.id}`) }}</h2>
      <div class="memory-module-tabs" role="tablist" aria-orientation="vertical"
        :data-testid="group.id === 'knowledge' ? 'memory-tabs' : undefined">
        <button v-for="module in group.modules" :key="module" :id="`memory-tab-${module}`"
          type="button" class="memory-module-tab" :class="{ active: modelValue === module }"
          role="tab" :aria-selected="modelValue === module"
          :aria-controls="`memory-panel-${module}`" :data-testid="`memory-tab-${module}`"
          @click="emit('update:modelValue', module)">
          <span class="memory-module-icon" aria-hidden="true">
            <svg v-if="module === 'search'" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
            <svg v-else-if="module === 'review'" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="m8 12 2.5 2.5L16 9"/></svg>
            <svg v-else-if="module === 'claims'" viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
            <svg v-else-if="module === 'wiki'" viewBox="0 0 24 24"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z"/></svg>
            <svg v-else-if="module === 'codegraph'" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 11 9.2-5M7 13l10 4"/></svg>
            <svg v-else-if="module === 'context'" viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/></svg>
            <svg v-else-if="module === 'settings'" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>
            <svg v-else viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>
          </span>
          <span class="memory-module-copy">
            <strong>{{ t(`memory.tab_${module}`) }}</strong>
            <small>{{ t(`memory.tab_${module}_desc`) }}</small>
          </span>
          <span v-if="module === 'review' && reviewCount !== null" class="memory-tab-badge">
            {{ reviewCount > 99 ? '99+' : reviewCount }}
          </span>
        </button>
      </div>
    </section>
  </nav>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { MEMORY_MODULE_GROUPS, type MemoryModule } from './memoryModules'

defineProps<{
  modelValue: MemoryModule
  reviewCount: number | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: MemoryModule): void
}>()

const { t } = useLocale()
</script>
