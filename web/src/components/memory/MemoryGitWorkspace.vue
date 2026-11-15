<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import MemorySectionTabs from './MemorySectionTabs.vue'
const { t } = useLocale()
const section = ref('sync')
const syncSection = computed<'sync' | 'operations'>(() => section.value === 'operations' ? 'operations' : 'sync')
const tabs = computed(() => [
  { id: 'projects', label: t('memory.ui.git_projects') },
  { id: 'sync', label: t('memory.ui.git_sync') },
  { id: 'operations', label: t('memory.ui.git_operations') },
])
</script>

<template>
  <section class="memory-git-sections">
    <MemorySectionTabs v-model="section" :items="tabs" :label="t('memory.ui.git_sections')" panel-prefix="memory-git-section" />
    <div v-show="section === 'projects'" id="memory-git-section-projects" role="tabpanel" :aria-label="t('memory.ui.git_projects')"><slot name="projects" /></div>
    <!-- One child instance owns all original pending/unknown requests across sections. -->
    <div v-show="section !== 'projects'" :id="`memory-git-section-${syncSection}`" role="tabpanel" :aria-label="t(section === 'operations' ? 'memory.ui.git_operations' : 'memory.ui.git_sync')"><slot name="sync" :section="syncSection" /></div>
  </section>
</template>

<style scoped>
.memory-git-sections{min-width:0}.memory-git-sections>[role=tabpanel]{min-width:0}
</style>
