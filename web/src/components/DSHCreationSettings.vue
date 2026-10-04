<template>
  <div class="creation-settings">
    <button type="button" class="selection-row" :disabled="disabled" @click="openCard('model')">
      <span class="row-icon">✦</span><span class="row-copy"><strong>{{ t('session.dsh.title') }}</strong><small>{{ modelName }} · {{ effort || t('session.dsh.default') }}</small></span><span aria-hidden="true">›</span>
    </button>
    <button type="button" class="selection-row" :disabled="disabled" @click="openCard('permission')">
      <span class="row-icon">♧</span><span class="row-copy"><strong>{{ t('new_session.permission_label') }}</strong><small>{{ permissionName }}</small></span><span aria-hidden="true">›</span>
    </button>
    <Teleport to="body">
      <div v-if="card" class="selection-overlay" @click.self="close" @keydown.esc.stop.prevent="close">
        <section ref="panel" tabindex="-1" class="selection-panel" role="dialog" aria-modal="true" :aria-label="title" @keydown.tab.stop="trapFocus">
          <header><button type="button" @click="close">{{ t('session.dsh.cancel') }}</button><h2>{{ title }}</h2><button type="button" class="done" :disabled="disabled" @click="confirm">{{ t('common.done') }}</button></header>
          <div class="selection-body">
            <input v-model="search" type="search" :placeholder="t('session.dsh.searchOptions')" :aria-label="t('session.dsh.searchOptions')">
            <template v-if="card === 'model'">
              <h3>{{ t('new_session.model_label') }}</h3>
              <button type="button" class="choice" :aria-pressed="draftModel === ''" @click="selectModel('')"><span>{{ t('new_session.model_default') }}</span><span v-if="!draftModel">✓</span></button>
              <button v-for="item in filteredModels" :key="item.alias" type="button" class="choice" :aria-pressed="draftModel === item.alias" @click="selectModel(item.alias)"><span>{{ item.name }}<small>{{ item.alias.split('/')[0] }}</small></span><span v-if="draftModel === item.alias">✓</span></button>
              <p v-if="!models.length" class="hint">{{ t(loaded ? 'session.dsh.noModels' : 'new_session.model_loading') }}</p>
              <h3>{{ t('session.dsh.effort') }}</h3>
              <div class="effort-choices">
                <button v-for="value in ['', ...efforts]" :key="value" type="button" :aria-pressed="draftEffort === value" @click="draftEffort = value">{{ value || t('session.dsh.default') }}</button>
              </div>
              <p class="hint">{{ t(efforts.length ? 'workspace.effort_capability_hint' : 'workspace.effort_unavailable') }}</p>
            </template>
            <template v-else>
              <button type="button" class="choice" :aria-pressed="!draftPermission" @click="draftPermission = ''"><span>{{ t('new_session.model_default') }}</span><span v-if="!draftPermission">✓</span></button>
              <button v-for="option in filteredPermissions" :key="option.value" type="button" class="choice" :aria-pressed="draftPermission === option.value" @click="draftPermission = option.value"><span>{{ t(option.titleKey) }}<small>{{ t(option.descriptionKey) }}</small></span><span v-if="draftPermission === option.value">✓</span></button>
              <p class="hint">{{ t('session.dsh.creationPermissionHint') }}</p>
              <p v-if="!presets.length" class="hint">{{ t('session.dsh.noCreationPermissions') }}</p>
            </template>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { permissionOptions } from '../types/permission'
type Model = {alias:string;name:string;is_default?:boolean;supported_reasoning_efforts?:string[]}
const props=defineProps<{models:Model[];model:string;effort:string;permission:string;presets:string[];loaded:boolean;disabled:boolean}>()
const emit=defineEmits<{change:[value:{model:string;effort:string;permission:string}]}>()
const {t}=useLocale()
const card=ref<'model'|'permission'|null>(null),search=ref(''),draftModel=ref(''),draftEffort=ref(''),draftPermission=ref('')
const panel=ref<HTMLElement>()
let opener:HTMLElement|null=null
const title=computed(()=>t(card.value==='model'?'session.dsh.title':'new_session.permission_label'))
const options=computed(()=>permissionOptions('dsh',true,props.presets))
const modelName=computed(()=>props.models.find(m=>m.alias===props.model)?.name||t('new_session.model_default'))
const permissionName=computed(()=>props.permission?t(options.value.find(p=>p.value===props.permission)?.titleKey||props.permission):t('new_session.model_default'))
const filteredModels=computed(()=>props.models.filter(m=>(m.name+' '+m.alias).toLowerCase().includes(search.value.toLowerCase())))
const filteredPermissions=computed(()=>options.value.filter(p=>(t(p.titleKey)+' '+t(p.descriptionKey)).includes(search.value)))
const efforts=computed(()=>props.models.find(m=>draftModel.value?m.alias===draftModel.value:m.is_default)?.supported_reasoning_efforts||[])
async function openCard(value:'model'|'permission'){
 opener=document.activeElement instanceof HTMLElement?document.activeElement:null
 draftModel.value=props.model;draftEffort.value=props.effort;draftPermission.value=props.permission;search.value='';card.value=value
 await nextTick();panel.value?.focus()
}
function selectModel(value:string){if(value!==draftModel.value){draftModel.value=value;draftEffort.value=''}}
function close(){card.value=null;opener?.focus()}
function confirm(){emit('change',{model:draftModel.value,effort:efforts.value.includes(draftEffort.value)?draftEffort.value:'',permission:props.presets.includes(draftPermission.value)?draftPermission.value:''});close()}
function trapFocus(event:KeyboardEvent){
 const nodes=Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input')||[]),first=nodes[0],last=nodes.at(-1)
 if(event.shiftKey&&(document.activeElement===first||document.activeElement===panel.value)){event.preventDefault();last?.focus()}
 else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===panel.value)){event.preventDefault();first?.focus()}
}
</script>
<style scoped>
.creation-settings{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
.selection-row{display:flex;align-items:center;gap:12px;padding:15px;min-height:76px;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:12px;color:var(--fg);cursor:pointer;min-width:0}
.row-icon{color:var(--accent);font-size:20px}.row-copy{flex:1;min-width:0}.row-copy strong{display:block;font-size:13px;font-weight:600}.row-copy small{display:block;font-size:12px;color:var(--fg-secondary);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.selection-row:hover{border-color:var(--accent)}.selection-row:disabled{opacity:.5;cursor:not-allowed}
.selection-overlay{position:fixed;inset:0;z-index:1400;background:#0006;display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(3px)}
.selection-panel{width:480px;max-width:100%;max-height:85dvh;border:1px solid var(--border);border-radius:18px;background:var(--surface);color:var(--fg);display:flex;flex-direction:column;overflow:hidden;outline:none;box-shadow:0 20px 70px #0003}
header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);gap:8px}
header h2{font-size:16px;margin:0}header button{min-height:44px;padding:0 10px;background:transparent;border:0;color:var(--accent);cursor:pointer;font:inherit;font-size:14px}.done{font-weight:650}
.selection-body{overflow:auto;padding:16px 20px 24px;overscroll-behavior:contain}
input{width:100%;min-height:44px;border:1px solid var(--border);border-radius:9px;padding:10px 12px;background:var(--surface);color:var(--fg);font:inherit;font-size:14px;margin-bottom:12px}
h3{font-size:12px;color:var(--fg-secondary);font-weight:500;margin:16px 0 8px}
.choice{width:100%;display:flex;justify-content:space-between;align-items:center;gap:16px;text-align:left;padding:13px 12px;min-height:48px;background:transparent;color:var(--fg);border:1px solid transparent;border-radius:9px;cursor:pointer;font:inherit;font-size:14px}
.choice small{display:block;font-size:12px;color:var(--fg-tertiary);margin-top:5px}.choice[aria-pressed=true]{background:color-mix(in srgb,var(--accent) 8%,transparent);border-color:color-mix(in srgb,var(--accent) 25%,transparent)}.choice[aria-pressed=true]>span:last-child{color:var(--accent)}
.effort-choices{display:flex;gap:6px;flex-wrap:wrap}.effort-choices button{flex:1;min-width:52px;min-height:44px;border:1px solid var(--border);background:var(--surface);color:var(--fg-secondary);border-radius:8px;cursor:pointer}.effort-choices button[aria-pressed=true]{background:var(--fg);border-color:var(--fg);color:var(--surface)}
.hint{color:var(--fg-tertiary);font-size:12px;line-height:1.6}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:640px){.creation-settings{grid-template-columns:1fr;gap:0;border:1px solid var(--border);border-radius:12px;overflow:hidden}.selection-row{border:0;border-radius:0;min-height:70px}.selection-row+.selection-row{border-top:1px solid var(--border)}.selection-overlay{padding:0;align-items:flex-end}.selection-panel{width:100%;max-height:90dvh;border-radius:20px 20px 0 0}.selection-body{padding-bottom:max(24px,env(safe-area-inset-bottom))}input{font-size:16px}}
</style>
