<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { MemorySkillDocument } from '../../types/memorySkills'
defineProps<{ document: MemorySkillDocument }>()
const { t } = useLocale()
const fields = ['preconditions', 'validation', 'failure_handling', 'rollback'] as const
</script>
<template>
  <div class="memory-skill-document" data-testid="skill-document">
    <section><h3>{{ t('memory.skills.trigger') }}</h3><p>{{ document.trigger }}</p></section>
    <section><h3>{{ t('memory.skills.steps') }}</h3><ol><li v-for="(step, index) in document.steps" :key="index">
      <p>{{ step.instruction }}</p><small><code>{{ step.tool }}</code> · {{ step.operation }} · {{ step.permissions.join(', ') }}</small>
    </li></ol></section>
    <section v-for="field in fields" :key="field"><h3>{{ t(`memory.skills.${field}`) }}</h3>
      <ul><li v-for="(value, index) in document[field]" :key="index">{{ value }}</li></ul>
    </section>
  </div>
</template>
