<template>
  <section class="memory-context-workspace" data-testid="memory-panel-context">
    <MemorySectionTabs :model-value="section" :items="sections" :label="t('memory.ui.context.sections')" panel-prefix="memory-context-section" @update:model-value="selectSection" />
    <div v-if="pendingSection" class="memory-notice memory-context-draft" role="dialog" :aria-label="t('memory.ui.context.draftTitle')" data-testid="context-draft-prompt">
      <p>{{ t('memory.ui.context.draftHint') }}</p>
      <div><button class="memory-button" data-testid="context-draft-keep" @click="resolveDraft(true)">{{ t('memory.ui.context.keepDraft') }}</button><button class="memory-button" data-testid="context-draft-discard" @click="resolveDraft(false)">{{ t('memory.ui.context.discardDraft') }}</button><button class="memory-button" @click="pendingSection = null">{{ t('common.cancel') }}</button></div>
    </div>
    <div id="memory-context-section-settings" v-show="section === 'settings'" role="tabpanel" :aria-label="t('memory.ui.context.settings')" tabindex="0">
      <MemoryContextSettings ref="settings" @draft-change="hasDraft = $event" />
    </div>
    <div id="memory-context-section-packs" v-show="section === 'packs'" role="tabpanel" :aria-label="t('memory.context.packTitle')" tabindex="0">
      <div class="memory-context-pack-workspace" :class="{'has-selection':selectedPack,'reading-detail':readingDetail}">
        <div class="memory-context-pack-queue"><ContextPackList ref="packList" hide-feedback :selected-pack-id="selectedPack?.pack_id" @select="selectPack" @reset="resetPack" /></div>
        <div class="memory-context-pack-reader">
          <button v-if="selectedPack" class="memory-button memory-context-back" data-testid="context-pack-back" @click="readingDetail = false">← {{ t('memory.ui.context.backToPacks') }}</button>
          <ContextPackDetail :pack="selectedPack" feedback :feedback-busy="packList?.busy" :feedback-status="packList?.feedbackPackId === selectedPack?.pack_id ? packList?.feedbackStatus : undefined" @feedback="sendFeedback" />
          <p v-if="!selectedPack" class="memory-muted memory-context-select">{{ t('memory.ui.context.selectPack') }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextPackListEntry } from '../../types/memory'
import MemorySectionTabs from './MemorySectionTabs.vue'
import MemoryContextSettings from './MemoryContextSettings.vue'
import ContextPackList from './ContextPackList.vue'
import ContextPackDetail from './ContextPackDetail.vue'
const {t}=useLocale()
const section=ref('settings'),pendingSection=ref<string|null>(null),hasDraft=ref(false)
const settings=ref<InstanceType<typeof MemoryContextSettings>|null>(null)
const selectedPack=ref<ContextPackListEntry|null>(null),readingDetail=ref(false)
const packList=ref<InstanceType<typeof ContextPackList>|null>(null)
const sections=computed(()=>[{id:'settings',label:t('memory.ui.context.settings')},{id:'packs',label:t('memory.context.packTitle')}])
function selectSection(value:string){
  if(value!==section.value&&value==='packs'&&hasDraft.value){pendingSection.value=value;return}
  if(value==='packs'||value==='settings')section.value=value
}
function resolveDraft(keep:boolean){if(!keep)settings.value?.discardDraft();section.value=pendingSection.value??section.value;pendingSection.value=null}
function selectPack(pack:ContextPackListEntry){selectedPack.value=pack;readingDetail.value=true}
function resetPack(){selectedPack.value=null;readingDetail.value=false}
function sendFeedback(action:'used'|'ignored'|'incorrect'|'harmful'){if(selectedPack.value)void packList.value?.sendFeedback(selectedPack.value,action)}
</script>
<style scoped>
.memory-context-workspace{min-width:0}.memory-context-workspace>[role=tabpanel]{padding-top:20px;min-width:0}.memory-context-pack-workspace{display:grid;grid-template-columns:minmax(210px,260px) minmax(0,1fr);gap:22px}.memory-context-pack-queue{min-width:0;border-right:1px solid var(--border);padding-right:18px}.memory-context-pack-reader{min-width:0}.memory-context-pack-queue :deep(.context-pack-list){margin:0;padding:0;border:0;border-radius:0;background:none}.memory-context-draft>div{display:flex;gap:8px;flex-wrap:wrap}.memory-context-select{padding:32px;font-size:13px}.memory-context-back{display:none}
@media(max-width:760px){.memory-context-pack-workspace{grid-template-columns:minmax(0,1fr)}.memory-context-pack-queue{border:0;padding:0}.memory-context-pack-reader{display:none}.reading-detail .memory-context-pack-queue{display:none}.reading-detail .memory-context-pack-reader{display:block}.memory-context-back{display:inline-flex;margin-bottom:16px;min-height:44px}}
</style>
