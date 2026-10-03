<template>
  <nav class="memory-module-navigation subnav" :aria-label="t('memory.workspace_label')"
    data-testid="memory-module-rail">
    <p class="memory-rail-title">{{ t('memory.workbench') }}</p>
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
            <MemoryModuleIcon :module="module" />
          </span>
          <span class="memory-module-copy">
            <strong>{{ t(`memory.tab_${module}`) }}</strong>
          </span>
          <span v-if="module === 'review' && reviewCount !== null" class="memory-tab-badge">
            {{ reviewCount > 99 ? '99+' : reviewCount }}
          </span>
        </button>
      </div>
    </section>
    <p class="memory-rail-foot"><span class="memory-status-dot"></span>{{ t('memory.services_enabled') }}</p>
  </nav>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { MEMORY_MODULE_GROUPS, type MemoryModule } from './memoryModules'
import MemoryModuleIcon from './MemoryModuleIcon.vue'

defineProps<{
  modelValue: MemoryModule
  reviewCount: number | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: MemoryModule): void
}>()

const { t } = useLocale()
</script>
