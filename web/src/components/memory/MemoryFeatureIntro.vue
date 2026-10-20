<template>
  <section class="memory-feature-intro" :data-testid="`memory-intro-${feature}`"
    :aria-label="t(`memory.intro.${feature}.title`)">
    <header>
      <MemoryModuleIcon :module="feature" />
      <h3>{{ t(`memory.intro.${feature}.title`) }}</h3>
    </header>
    <p>{{ t(`memory.intro.${feature}.description`) }}</p>
    <dl>
      <div><dt>{{ t('memory.intro.usage') }}</dt><dd>{{ t(`memory.intro.${feature}.usage`) }}</dd></div>
      <div><dt>{{ t('memory.intro.start') }}</dt><dd>{{ t(`memory.intro.${feature}.start`) }}</dd></div>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import MemoryModuleIcon from './MemoryModuleIcon.vue'
defineProps<{ feature: 'wiki' | 'codegraph' | 'git' }>()
const { t } = useLocale()
</script>

<style scoped>
.memory-feature-intro { margin: 16px 0; padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--fg); overflow-wrap: anywhere; }
.memory-feature-intro header { display: flex; align-items: center; gap: 12px; }
.memory-feature-intro header svg { width: 24px; height: 24px; flex-shrink: 0; color: var(--accent); }
.memory-feature-intro h3 { margin: 0; font-size: 16px; }
.memory-feature-intro p, .memory-feature-intro dd { font-size: 14px; line-height: 1.7; color: var(--fg-secondary); }
.memory-feature-intro p { margin: 12px 0 20px; }
.memory-feature-intro dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin: 0; }
.memory-feature-intro dt { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.memory-feature-intro dd { margin: 0; }
@media (max-width: 640px) {
  .memory-feature-intro { padding: 18px; }
  .memory-feature-intro dl { grid-template-columns: 1fr; gap: 16px; }
}
</style>
