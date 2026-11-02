<template>
  <Teleport to="body">
    <dialog ref="dialog" class="memory-manual-dialog memory-workbench design-shell reference-shell" aria-modal="true" aria-labelledby="manual-claim-title" @cancel.prevent="close" @click="outside">
      <form @submit.prevent="save">
        <header><h2 id="manual-claim-title">{{ t('memory.manual.title') }}</h2><button type="button" class="manual-close" :aria-label="t('common.close')" :disabled="busy" @click="close"><WorkspaceIcon name="close" /></button></header>
        <div class="manual-body">
          <p class="manual-hint">{{ t('memory.manual.hint') }}</p>
          <fieldset :disabled="busy || uncertain">
            <label>{{ t('memory.manual.statement') }}<textarea v-model="statement" data-testid="manual-statement" maxlength="4000" rows="5" required /></label>
            <small>{{ statement.trim().length }} / 4000</small>
            <label>{{ t('memory.manual.type') }}<ActionSelect :teleport-to="dialog || 'body'"><select v-model="claimType" :disabled="busy || uncertain" :aria-label="t('memory.manual.type')"><option v-for="type in types" :key="type" :value="type">{{ t(`memory.manual.types.${type}`) }}</option></select></ActionSelect></label>
            <label>{{ t('memory.manual.scope') }}<ActionSelect :teleport-to="dialog || 'body'"><select v-model="scope" :disabled="busy || uncertain" :aria-label="t('memory.manual.scope')"><option value="installation">{{ t('memory.manual.personal') }}</option><option value="repository">{{ t('memory.manual.repository') }}</option></select></ActionSelect></label>
            <label v-if="scope === 'repository'">{{ t('memory.manual.repository_id') }}<input v-model.trim="repositoryId" data-testid="manual-repository" required :placeholder="t('memory.manual.repository_hint')" /></label>
            <label class="manual-confirm"><input v-model="confirmed" type="checkbox" data-testid="manual-confirm" />{{ t('memory.manual.confirm') }}</label>
          </fieldset>
          <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
          <p v-if="uncertain" class="manual-hint">{{ t('memory.manual.uncertain') }}</p>
        </div>
        <footer><button type="button" class="memory-button" :disabled="busy" @click="close">{{ t('common.cancel') }}</button><button type="submit" class="memory-button is-primary" data-testid="manual-save" :disabled="busy || !valid">{{ busy ? t('common.loading') : uncertain ? t('memory.manual.retry') : t('memory.manual.save') }}</button></footer>
      </form>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import {computed,nextTick,onMounted,onUnmounted,ref,watch} from 'vue'
import ActionSelect from '../ActionSelect.vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'
import {useLocale} from '../../composables/useLocale'
import {createManualMemoryClaim,MemoryClientError,type ManualMemoryClaimInput} from '../../services/memoryClient'
const props=defineProps<{installationId:string}>()
const emit=defineEmits<{close:[];created:[claimId:string]}>()
const {t}=useLocale()
const dialog=ref<HTMLDialogElement>(),statement=ref(''),claimType=ref('work_method'),scope=ref('installation'),repositoryId=ref(''),confirmed=ref(false),busy=ref(false),uncertain=ref(false),error=ref('')
const types=['architecture_decision','repository_convention','bug_root_cause','rejected_hypothesis','test_invariant','implementation_map','operational_runbook','work_method','reusable_skill_candidate']
const valid=computed(()=>statement.value.trim().length>0&&statement.value.trim().length<=4000&&confirmed.value&&(scope.value==='installation'||/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repositoryId.value)))
let generation=0,submission:{canonical:string;key:string;input:ManualMemoryClaimInput}|undefined
let opener:HTMLElement|null=null,overflow=''
function close(){if(!busy.value)emit('close')}
function outside(e:MouseEvent){if(e.target!==dialog.value)return;const r=dialog.value.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}
async function save(){
 if(busy.value||!valid.value)return
 const turn=generation,id=props.installationId
 const input:ManualMemoryClaimInput={statement:statement.value.trim(),claim_type:claimType.value,repository_id:scope.value==='repository'?repositoryId.value:null,confirmed:true}
 const canonical=JSON.stringify(input)
 if(!submission||submission.canonical!==canonical)submission={canonical,key:`manual-claim:${crypto.randomUUID()}`,input}
 busy.value=true;error.value=''
 try{const result=await createManualMemoryClaim(submission.input,submission.key,id);if(turn!==generation||id!==props.installationId)return;emit('created',result.claim_id)}
 catch(e){if(turn!==generation)return;uncertain.value=!(e instanceof MemoryClientError)||e.status===0||e.status>=500;error.value=t(e instanceof MemoryClientError&&e.code==='revision_conflict'?'memory.manual.duplicate':'memory.manual.failed')}
 finally{if(turn===generation)busy.value=false}
}
watch(()=>props.installationId,()=>{generation++;busy.value=false;emit('close')})
onMounted(async()=>{opener=document.activeElement as HTMLElement;overflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();dialog.value?.showModal()})
onUnmounted(()=>{generation++;dialog.value?.close();document.body.style.overflow=overflow;if(opener?.isConnected)opener.focus()})
</script>
<style scoped>
.memory-manual-dialog.memory-workbench{position:fixed;inset:0;margin:auto;width:min(640px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 48px);min-height:0;padding:0;border:1px solid var(--line);border-radius:18px;background:var(--panel);color:var(--ink);overflow:hidden;box-shadow:var(--modal-shadow)}
.memory-manual-dialog[open]{display:block;grid-template-columns:none}.memory-manual-dialog:not([open]){display:none}.manual-close :deep(svg){width:18px;height:18px}
.memory-manual-dialog::backdrop{background:var(--overlay,#16203965);backdrop-filter:blur(4px)}
form{width:100%;box-sizing:border-box;min-height:0;display:flex;flex-direction:column;max-height:inherit}header,footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px;flex:none}header{border-bottom:1px solid var(--line)}h2{font-size:18px;font-weight:650;margin:0}.manual-close{border:0;background:transparent;color:var(--muted);width:36px;height:36px;font-size:26px;cursor:pointer}footer{justify-content:flex-end;border-top:1px solid var(--line)}.manual-body{padding:20px 24px;overflow:auto;min-height:0;overscroll-behavior:contain}.manual-hint,small{font-size:12px;color:var(--muted);line-height:1.7}.manual-hint{margin:0 0 16px}fieldset{border:0;padding:0;margin:0;min-width:0}label{display:flex;flex-direction:column;gap:8px;font-size:13px;margin:14px 0}textarea,input:not([type=checkbox]){width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel);color:var(--ink);font:inherit}textarea{resize:vertical;min-height:120px}.manual-confirm{flex-direction:row;align-items:flex-start;line-height:1.7}.manual-confirm input{margin-top:5px;flex:none}.manual-body :deep(.action-select){width:100%}
@media(max-width:768px){.memory-manual-dialog.memory-workbench{inset:auto 0 0;margin:0;width:100%;max-height:92dvh;border:0;border-radius:24px 24px 0 0}header,footer,.manual-body{padding:16px 20px}h2{font-size:17px}.manual-close{width:44px;height:44px;border-radius:50%;background:var(--soft)}footer{padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}button{min-height:44px}
.memory-manual-dialog :deep(.action-select-content){padding:0;gap:0;border-radius:14px}
.memory-manual-dialog :deep(.action-select-content>button){min-height:52px;padding:14px 16px;border-radius:0;font-size:16px;background:transparent;color:var(--ink)}
.memory-manual-dialog :deep(.action-select-content>button+button){border-top:1px solid var(--line)}
.memory-manual-dialog :deep(.action-select-content>button[aria-selected=true]){color:var(--brand);background:transparent}
.memory-manual-dialog::backdrop{backdrop-filter:none}header{position:relative;padding-top:22px}header::before{content:"";position:absolute;top:8px;left:calc(50% - 15.5px);width:31px;height:4px;border-radius:4px;background:var(--muted);opacity:.35}.manual-body{font-size:15px}textarea,input:not([type=checkbox]){font-size:16px}}
</style>
