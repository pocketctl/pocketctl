<script setup lang="ts">
import ActionSelect from '../ActionSelect.vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'
import {ref,computed,watch,nextTick,onUnmounted} from 'vue'
import {useLocale} from '../../composables/useLocale'
import type {MemoryClaimDetail} from '../../types/memory'
const props=withDefaults(defineProps<{
  claim:MemoryClaimDetail|null
  evidence:Array<{evidence_id:string;excerpt:string}>
  targets:Array<{installation_id:string;owner_scope_kind:string}>
  busy?:boolean;error?:string;uncertain?:boolean
}>(),{busy:false,error:'',uncertain:false})
const emit=defineEmits<{confirm:[input:{targetInstallationId:string;evidenceIds:string[]}];cancel:[]}>()
const {t}=useLocale()
const dialog=ref<HTMLDialogElement>(),selectedTarget=ref(''),selectedEvidence=ref<string[]>([]),confirmed=ref(false)
const evidenceItems=computed(()=>props.evidence.slice(0,8))
const locked=computed(()=>props.busy||props.uncertain)
const current=computed(()=>props.claim?.versions.find(v=>v.version_id===props.claim?.claim.current_version_id))
const canConfirm=computed(()=>confirmed.value&&props.targets.some(x=>x.installation_id===selectedTarget.value)&&selectedEvidence.value.length>0&&selectedEvidence.value.every(id=>evidenceItems.value.some(x=>x.evidence_id===id)))
let opener:HTMLElement|null=null,overflow='',opened=false,generation=0
function cleanup(){dialog.value?.close();if(opened){document.body.style.overflow=overflow;opened=false;if(opener?.isConnected)opener.focus()}}
function close(){if(!locked.value)emit('cancel')}
watch(()=>[props.claim?.claim.claim_id,props.claim?.claim.current_version_id],async()=>{
  const turn=++generation;selectedTarget.value='';selectedEvidence.value=[];confirmed.value=false
  if(!props.claim){cleanup();return}
  await nextTick();if(turn!==generation||!dialog.value)return
  if(!opened){opener=document.activeElement as HTMLElement;overflow=document.body.style.overflow;document.body.style.overflow='hidden';opened=true}
  if(!dialog.value.open)dialog.value.showModal()
},{immediate:true})
watch(()=>props.targets,()=>{if(!props.targets.some(x=>x.installation_id===selectedTarget.value)){selectedTarget.value='';confirmed.value=false}})
onUnmounted(()=>{generation++;cleanup()})
function toggleEvidence(id:string){if(locked.value)return;const index=selectedEvidence.value.indexOf(id);if(index>=0)selectedEvidence.value.splice(index,1);else if(selectedEvidence.value.length<8)selectedEvidence.value.push(id)}
</script>
<template>
 <Teleport to="body">
  <dialog v-if="claim" ref="dialog" class="memory-promotion-dialog memory-workbench design-shell reference-shell" aria-modal="true" aria-labelledby="memory-promotion-title" @cancel.prevent="close">
   <header><h3 id="memory-promotion-title">{{ t('memory.governance.promotion.title') }}</h3><button type="button" class="promotion-close" :disabled="locked" :aria-label="t('common.close')" @click="close"><WorkspaceIcon name="close" /></button></header>
   <div class="promotion-body">
    <p class="memory-governance-muted">{{ t('memory.governance.promotion.copyBoundary') }}</p>
    <blockquote class="promotion-statement">{{ current?.statement }}</blockquote>
    <p v-if="!targets.length" class="memory-notice">{{ t('memory.claim_no_promotion_targets') }}</p>
    <fieldset :disabled="locked">
     <label class="memory-promotion-target">{{ t('memory.governance.promotion.target') }}
      <ActionSelect :teleport-to="dialog || 'body'"><select v-model="selectedTarget" :disabled="locked" data-testid="memory-promotion-target"><option value="" disabled>{{ t('memory.governance.promotion.selectTarget') }}</option><option v-for="target in targets" :key="target.installation_id" :value="target.installation_id">{{ target.owner_scope_kind }} · {{ target.installation_id.slice(0,8) }}</option></select></ActionSelect>
     </label>
     <fieldset class="memory-promotion-evidence"><legend>{{ t('memory.governance.promotion.evidence') }}</legend><label v-for="item in evidenceItems" :key="item.evidence_id"><input type="checkbox" :value="item.evidence_id" :checked="selectedEvidence.includes(item.evidence_id)" @change="toggleEvidence(item.evidence_id)"><span>{{ item.excerpt }}</span></label></fieldset>
     <label class="memory-promotion-confirm"><input v-model="confirmed" type="checkbox" data-testid="memory-promotion-confirm">{{ t('memory.governance.promotion.confirmCopy') }}</label>
    </fieldset>
    <p v-if="error" class="memory-notice is-error" role="alert">{{ error }}</p><p v-if="uncertain" class="memory-notice">{{ t('memory.claim_operation_uncertain') }}</p>
   </div>
   <footer><button type="button" class="memory-button" :disabled="locked" @click="close">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-primary" data-testid="memory-promotion-submit" :disabled="busy || !canConfirm" @click="emit('confirm',{targetInstallationId:selectedTarget,evidenceIds:[...selectedEvidence]})">{{ t(busy?'memory.loading':'memory.governance.promotion.confirm') }}</button></footer>
  </dialog>
 </Teleport>
</template>
<style scoped>
.memory-promotion-dialog{inset:0;width:min(640px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 48px);min-height:0;margin:auto;padding:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--ink);overflow:hidden;box-shadow:var(--modal-shadow)}
.memory-promotion-dialog[open]{display:flex;flex-direction:column;grid-template-columns:none}.memory-promotion-dialog:not([open]){display:none}.memory-promotion-dialog::backdrop{background:var(--overlay,#16203965);backdrop-filter:blur(4px)}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px;flex:none}header{border-bottom:1px solid var(--line)}h3{font-size:18px;font-weight:650;margin:0}footer{justify-content:flex-end;border-top:1px solid var(--line)}.promotion-body{min-height:0;overflow:auto;padding:20px 24px;overscroll-behavior:contain}fieldset{border:0;padding:0;margin:0;min-width:0}.promotion-close{display:grid;place-items:center;width:36px;height:36px;border:0;background:transparent;color:var(--muted);cursor:pointer}.promotion-close :deep(svg){width:18px;height:18px}.promotion-statement{margin:16px 0;padding:12px;border:1px solid var(--line);border-radius:8px;font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.memory-promotion-target{gap:8px;font-size:13px}.memory-promotion-target :deep(.action-select){width:100%}.memory-promotion-evidence{display:grid;gap:12px;border:1px solid var(--line);border-radius:8px;padding:12px;margin:16px 0;font-size:12px;line-height:1.8}.memory-promotion-evidence label{display:flex;align-items:flex-start;gap:8px}.memory-promotion-evidence input{flex:none;margin-top:5px}.memory-promotion-evidence span{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:768px){.memory-promotion-dialog{inset:auto 0 0;margin:0;width:100%;max-height:92dvh;border:0;border-radius:24px 24px 0 0}.memory-promotion-dialog::backdrop{backdrop-filter:none}header,footer,.promotion-body{padding:16px 20px}header{position:relative;padding-top:22px}header::before{content:'';position:absolute;top:8px;left:calc(50% - 15.5px);width:31px;height:4px;border-radius:4px;background:var(--muted);opacity:.35}h3{font-size:17px}.promotion-close{width:44px;height:44px;border-radius:50%;background:var(--soft)}footer{padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}button{min-height:44px}
:deep(.action-select-content){padding:0;gap:0;border-radius:14px}:deep(.action-select-content>button){min-height:52px;padding:14px 16px;border-radius:0;font-size:16px;background:transparent}:deep(.action-select-content>button+button){border-top:1px solid var(--line)}:deep(.action-select-content>button[aria-selected=true]){color:var(--brand);background:transparent}}
</style>
