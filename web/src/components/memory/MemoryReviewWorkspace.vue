<template>
  <section class="memory-review-sections" data-testid="memory-review-workspace">
    <MemorySectionTabs :model-value="section" :items="sections" :label="t('memory.ui.review.sections')" panel-prefix="memory-review-section" @update:model-value="selectSection" />
    <div id="memory-review-section-automatic" v-show="section === 'automatic'" role="tabpanel" :aria-label="t('memory.ui.review.automatic')" tabindex="0"><slot name="automatic" /></div>
    <div id="memory-review-section-personal" v-show="section === 'personal'" role="tabpanel" :aria-label="personalLabel" tabindex="0"><slot name="personal" /></div>
    <div id="memory-review-section-shared" v-show="section === 'shared'" role="tabpanel" :aria-label="t('memory.ui.review.shared')" tabindex="0"><slot name="shared" /></div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import MemorySectionTabs from './MemorySectionTabs.vue'
type Section='automatic'|'personal'|'shared'
const props=withDefaults(defineProps<{lifecycleMode?:'off'|'shadow'|'enabled'|'unknown';initialSection?:Section}>(),{lifecycleMode:'unknown',initialSection:'automatic'})
const {t}=useLocale()
const section=ref<Section>(props.initialSection)
const personalLabel=computed(()=>t(props.lifecycleMode==='shadow'?'memory.ui.review.observation':props.lifecycleMode==='enabled'?'memory.ui.review.legacy':'memory.ui.review.personal'))
const sections=computed(()=>[{id:'automatic',label:t('memory.ui.review.automatic')},{id:'personal',label:personalLabel.value},{id:'shared',label:t('memory.ui.review.shared')}])
function selectSection(value:string){if(value==='automatic'||value==='personal'||value==='shared')section.value=value}
watch(()=>props.initialSection,selectSection)
</script>
<style scoped>
.memory-review-sections{min-width:0}.memory-review-sections>[role=tabpanel]{padding-top:20px;min-width:0}
</style>
