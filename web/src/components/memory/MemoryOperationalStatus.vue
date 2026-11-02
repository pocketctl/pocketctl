<template>
  <div v-show="attention || state === 'unknown' || dialogOpen" class="memory-operational-status" :class="{ 'is-error': attention }"
    :role="attention ? 'alert' : 'status'" data-testid="memory-operational-status">
    <button ref="trigger" type="button" class="memory-operational-trigger" data-testid="memory-operational-trigger"
      :title="`${t(`memory.operational.${state}`)} · ${t('memory.operational.details')}`" aria-haspopup="dialog" :aria-expanded="dialogOpen" :aria-label="`${t(`memory.operational.${state}`)} · ${t('memory.operational.details')}`" @click="openDialog">
      <span class="memory-operational-label">{{ t(`memory.operational.${state}`) }}</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5v5"/><circle cx="10" cy="14" r=".8" class="warning-dot"/></svg>
    </button>
    <Teleport to="body">
      <dialog v-if="dialogOpen" ref="dialog" class="memory-operational-dialog memory-workbench design-shell reference-shell"
        aria-modal="true" aria-labelledby="memory-operational-title" @cancel.prevent="closeDialog" @close="closed" @click="outside">
        <div class="memory-sheet-handle" aria-hidden="true"></div>
        <header class="operational-dialog-head modal-head">
          <h2 id="memory-operational-title">{{ t('memory.operational.title') }}</h2>
          <button type="button" class="memory-dialog-close" :aria-label="t('common.close')" @click="closeDialog"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
        </header>
        <div class="operational-dialog-body modal-content">
        <div class="operational-dialog-summary" :role="attention ? 'alert' : 'status'">
          <strong>{{ t(`memory.operational.${state}`) }}</strong>
          <p v-if="reason">{{ t(`memory.operational.${reason}`) }}</p>
        </div>
        <button type="button" class="memory-button" data-testid="memory-operational-refresh" :disabled="busy" @click="refreshAll">{{ t('memory.operational.refresh') }}</button>
        <MemoryExtractionIssues v-if="showExtraction" ref="issues" :hide-refresh="true" :installation-id="installationId" @updated="refresh" />
        </div>
      </dialog>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import MemoryExtractionIssues from './MemoryExtractionIssues.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { readMemoryOperationalStatus, type MemoryOperationalSnapshot } from '../../services/memoryOperationalStatus'
const props=defineProps<{installationId:string}>()
const {t}=useLocale()
const snapshot=ref<MemoryOperationalSnapshot|null>(null)
const busy=ref(false)
const dialogOpen=ref(false)
const showExtraction=ref(false)
const issues=ref<InstanceType<typeof MemoryExtractionIssues>>()
async function refreshAll(){await Promise.all([refresh(),issues.value?.refresh?.()])}
const dialog=ref<HTMLDialogElement>()
const trigger=ref<HTMLButtonElement>()
let previousOverflow:string|undefined
function unlockScroll(){if(previousOverflow!==undefined){document.body.style.overflow=previousOverflow;previousOverflow=undefined}}
function closed(){if(dialog.value?.open)return;dialogOpen.value=false;unlockScroll();void nextTick(()=>trigger.value?.focus())}
function closeDialog(){dialog.value?.close();dialogOpen.value=false;unlockScroll();void nextTick(()=>trigger.value?.focus())}
async function openDialog(){
  if(dialogOpen.value)return
  showExtraction.value=reason.value==='extraction_failed'
  dialogOpen.value=true
  await nextTick()
  if(!dialogOpen.value)return
  previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden'
  dialog.value?.showModal()
}
function outside(event:MouseEvent){
  if(event.target!==dialog.value)return
  const rect=dialog.value.getBoundingClientRect()
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog()
}
const loaded=ref(false)
let generation=0
let timer:ReturnType<typeof setInterval>|undefined
const state=computed(()=>snapshot.value?.state??(loaded.value?'unknown':'loading'))
const attention=computed(()=>['degraded','error','offline'].includes(state.value))
const reasons=['feed_stalled','budget_blocked','extraction_stalled','extraction_failed','evidence_gap','feed_integrity']
const reason=computed(()=>attention.value&&reasons.includes(snapshot.value?.last_error_code??'')?snapshot.value!.last_error_code:null)
async function refresh(){
  if(busy.value)return
  const turn=++generation
  busy.value=true
  // An unresolved warning remains visible until a new result establishes recovery.
  if(!attention.value){snapshot.value=null;loaded.value=false}
  try{const result=await readMemoryOperationalStatus(props.installationId);if(turn===generation)snapshot.value=result}
  catch{if(turn===generation)snapshot.value=null}
  finally{if(turn===generation){loaded.value=true;busy.value=false}}
}
watch(()=>props.installationId,()=>{generation++;closeDialog();showExtraction.value=false;busy.value=false;loaded.value=false;snapshot.value=null;void refresh()})
onMounted(()=>{void refresh();timer=setInterval(()=>void refresh(),60000)})
watch(reason,value=>{if(dialogOpen.value&&value==='extraction_failed')showExtraction.value=true})
onUnmounted(()=>{generation++;dialog.value?.close();unlockScroll();if(timer)clearInterval(timer)})
</script>
<style scoped>
.memory-operational-status{display:inline-flex;flex:none;color:var(--warning)}
.memory-operational-status.is-error{color:var(--error)}
.memory-operational-trigger{display:grid;place-items:center;width:32px;height:32px;padding:6px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.memory-operational-trigger:hover{background:var(--error-bg)}
.memory-operational-label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.memory-operational-trigger svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.warning-dot{fill:currentColor;stroke:none}
.memory-operational-trigger:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.memory-operational-dialog.memory-workbench{position:fixed;inset:0;margin:auto;width:min(680px,calc(100vw - 32px));max-width:none;min-height:0;max-height:calc(100dvh - 48px);padding:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--ink);overflow:hidden;box-shadow:var(--modal-shadow)}
.memory-operational-dialog[open]{display:flex;flex-direction:column}
.memory-sheet-handle{display:none}
.memory-operational-dialog::backdrop{background:var(--overlay,#16203965);backdrop-filter:blur(4px)}
.operational-dialog-head{display:flex;flex:none;align-items:center;justify-content:space-between;gap:16px;padding:23px 24px 18px;border-bottom:1px solid var(--line)}
.operational-dialog-head h2{font-size:18px;font-weight:650;line-height:1.55;margin:0}
.memory-dialog-close{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:6px;border:0;border-radius:8px;background:transparent;color:var(--muted);cursor:pointer}
.memory-dialog-close:hover{background:var(--soft)}
.memory-dialog-close svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.operational-dialog-body{min-height:0;overflow:auto;padding:20px 24px 24px;overscroll-behavior:contain}
.operational-dialog-summary{line-height:1.7;margin-bottom:16px}
.operational-dialog-summary p{margin:8px 0 0;color:var(--muted)}
.memory-operational-dialog :deep(.extraction-issues){margin-top:20px}
@media(max-width:768px){
  .memory-operational-trigger{width:44px;height:44px}
  .memory-operational-dialog.memory-workbench{inset:auto 0 0;margin:0;width:100%;max-height:calc(92dvh - env(safe-area-inset-top,0px));border:0;border-radius:24px 24px 0 0;box-shadow:0 -12px 48px #0002}
  .memory-operational-dialog[open]{animation:memory-ios-sheet-in 220ms ease-out}
  .memory-operational-dialog::backdrop{background:#0006;backdrop-filter:none}
  .memory-sheet-handle{display:block;flex:none;width:31px;height:4px;margin:9px auto 0;border-radius:5px;background:var(--line-strong)}
  .operational-dialog-head{min-height:60px;gap:12px;padding:4px 16px 8px 20px}
  .operational-dialog-head h2{font-size:17px;font-weight:600}
  .memory-dialog-close{width:44px;height:44px;border-radius:50%;background:var(--soft)}
  .memory-dialog-close svg{width:18px;height:18px}
  .operational-dialog-body{padding:16px 20px calc(20px + env(safe-area-inset-bottom,0px));font-size:15px}
  .memory-operational-dialog :deep(.memory-button){min-height:44px}
}
@keyframes memory-ios-sheet-in{from{translate:0 32px;opacity:.7}to{translate:0 0;opacity:1}}
@media(prefers-reduced-motion:reduce){.memory-operational-dialog[open]{animation:none}}
</style>
