<template>
  <section class="context-pack-list memory-config-card" data-testid="context-pack-list" :aria-busy="busy">
    <h3>{{ t('memory.context.packTitle') }}</h3>
    <div class="memory-config-toolbar">
      <input v-model="sessionId" :placeholder="t('memory.context.sessionPlaceholder')" :aria-label="t('memory.context.sessionPlaceholder')" data-testid="pack-session-input" @keyup.enter="refresh">
      <button class="memory-button" data-testid="pack-refresh" :disabled="busy || !sessionId.trim()" @click="refresh">{{ t('memory.context.refresh') }}</button>
    </div>
    <p v-if="queriedSession" class="hint" data-testid="pack-query">{{ t('memory.ui.context.querySession') }}: <code>{{ queriedSession }}</code></p>
    <p v-if="busy && !packs.length" role="status">{{ t('common.loading') }}</p>
    <p v-if="loadError" class="memory-notice is-error" role="alert" data-testid="pack-load-error">{{ t(loadError) }}</p>
    <p v-if="!hideFeedback" class="hint">{{ t('memory.ui.context.feedbackHint') }}</p>
    <p v-if="feedbackStatus && !hideFeedback" role="status" data-testid="pack-feedback-status">{{ t(feedbackStatus) }}</p>
    <ul v-if="packs.length > 0" data-testid="pack-rows">
      <li v-for="pack in packs" :key="pack.pack_id" :data-testid="`pack-${pack.state}`" :class="{selected: selectedPackId === pack.pack_id}">
        <button class="memory-button pack-select" :data-testid="`pack-select-${pack.pack_id}`" :aria-current="selectedPackId === pack.pack_id ? 'true' : undefined" @click="emit('select', pack)">{{ pack.pack_id.slice(0, 8) }}</button>
        <span class="state" :class="pack.state">{{ stateLabel(pack.state) }}</span>
        <span class="meta">{{ pack.client_request_id }} · {{ new Date(pack.created_at).toLocaleString() }}</span>
        <span v-if="pack.delivery" class="delivery">{{ t('memory.context.delivery') }}: {{ pack.delivery.state }}</span>
        <span v-if="!hideFeedback" class="feedback" :aria-label="t('memory.ui.context.userFeedback')" role="group">
          <button class="memory-button" v-for="action in ['used', 'ignored', 'incorrect', 'harmful'] as const" :key="action" :data-testid="`feedback-${action}`" :class="{ danger: action === 'harmful' }" :disabled="busy" @click="sendFeedback(pack, action)">{{ t(`memory.context.feedback.${action}`) }}</button>
        </span>
      </li>
    </ul>
    <div v-else-if="loaded && !loadError" class="empty" data-testid="pack-empty">{{ t('memory.context.packEmpty') }}</div>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextPackListEntry } from '../../types/memory'
import { listContextPacks, submitContextFeedback } from '../../services/memoryClient'
defineProps<{selectedPackId?:string|null;hideFeedback?:boolean}>()
const { t } = useLocale()
const emit = defineEmits<{ (event: 'select', pack: ContextPackListEntry): void; (event:'reset'):void }>()
const sessionId=ref(''),queriedSession=ref(''),packs=ref<ContextPackListEntry[]>([]),busy=ref(false),loaded=ref(false),loadError=ref(''),feedbackStatus=ref(''),feedbackPackId=ref('')
let epoch=0
watch(sessionId,()=>{epoch++;packs.value=[];loaded.value=false;loadError.value='';queriedSession.value='';feedbackStatus.value='';feedbackPackId.value='';busy.value=false;emit('reset')},{flush:'sync'})
onBeforeUnmount(()=>{epoch++})
function stateLabel(state:string):string{return t(`memory.context.packState.${state}`,{state})}
async function refresh():Promise<void>{
  const query=sessionId.value.trim()
  if(!query||busy.value)return
  const request=++epoch;queriedSession.value=query;busy.value=true;loaded.value=false;loadError.value='';packs.value=[];feedbackStatus.value='';emit('reset')
  try{const result=await listContextPacks(query);if(request!==epoch)return;packs.value=result.packs;loaded.value=true}
  catch(error){if(request===epoch)loadError.value=typeof error==='object'&&error!==null&&'status'in error&&(error.status===401||error.status===403)?'memory.ui.context.forbidden':'memory.ui.context.loadFailed'}
  finally{if(request===epoch)busy.value=false}
}
async function sendFeedback(pack:ContextPackListEntry,action:'used'|'ignored'|'incorrect'|'harmful'):Promise<void>{
  if(busy.value)return
  const request=epoch;busy.value=true;feedbackStatus.value='';feedbackPackId.value=pack.pack_id
  try{await submitContextFeedback({packId:pack.pack_id,action});if(request===epoch)feedbackStatus.value='memory.ui.context.feedbackRecorded'}
  catch{if(request===epoch)feedbackStatus.value='memory.ui.context.feedbackFailed'}
  finally{if(request===epoch)busy.value=false}
}
defineExpose({sendFeedback,busy,feedbackStatus,feedbackPackId})
</script>
<style scoped>
.context-pack-list{min-width:0}.context-pack-list h3{font-size:16px;margin:0 0 14px}.memory-config-toolbar{display:flex;gap:8px;flex-wrap:wrap}.memory-config-toolbar input{min-width:0;flex:1;padding:9px 10px;font:inherit;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--fg)}.hint{font-size:12px;line-height:1.6;color:var(--muted)}ul{list-style:none;margin:16px 0 0;padding:0}li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 8px;border-bottom:1px solid var(--border);border-radius:7px;font-size:12px;overflow-wrap:anywhere}li.selected{background:var(--accent-muted)}.meta,.delivery{flex-basis:100%;color:var(--muted)}.feedback{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.feedback button{font-size:11px;padding:5px 7px}.pack-select{font-family:monospace}.context-pack-list code{overflow-wrap:anywhere}
@media(max-width:700px){.memory-config-toolbar input{font-size:16px}.context-pack-list button{min-height:44px}}
</style>
