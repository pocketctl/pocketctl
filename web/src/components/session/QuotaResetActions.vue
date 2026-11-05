<template>
  <div class="reset-actions">
    <p v-if="message" class="reset-status" role="status" aria-live="polite">{{ message }}</p>
    <template v-if="showCounts">
      <h3 v-if="choices.length || cardsStatus!=='ok'">{{ t('codex_quota.cards') }}</h3>
      <div v-if="choices.length" class="reset-card-group">
        <section v-for="choice in choices" :key="choice.type" class="reset-card-row">
          <div class="reset-total"><span>{{ choice.label }}</span><strong>{{ t('codex_quota.card_count',{n:choice.count}) }}</strong></div>
          <small v-if="choice.expires?.length">{{ t('codex_quota.card_expires') }} {{ formatDate(Math.min(...choice.expires)) }}</small>
          <small v-else>{{ t('codex_quota.card_details_unknown') }}</small>
          <button class="reset-use" type="button" :disabled="!canUse" @click="choose(choice)">{{ t('quota_reset.use_one') }}</button>
          <details v-if="choice.expires?.length"><summary>{{ t('codex_quota.card_expiries') }}</summary><p v-for="(date,i) in choice.expires" :key="i">{{ formatDate(date) }}</p></details>
        </section>
      </div>
      <p v-else-if="cardsStatus!=='ok'" class="reset-note">{{ t(cardsStatus==='authentication_required'?'quota_reset.auth':'codex_quota.cards_unknown') }}</p>
    </template>
    <button v-else-if="choices.length" class="reset-use" type="button" :disabled="!canUse" @click="choose(choices[0]!)">{{ t('quota_reset.use_one') }}</button>
    <p v-if="choices.length&&!supported" class="reset-note">{{ t('quota_reset.unsupported') }}</p>
    <p v-if="choices.length" class="reset-note">{{ t('quota_reset.manual_note') }}</p>
    <button v-if="provider==='codex'&&reset.phase.value==='unknown'" class="reset-use" :disabled="!canRecover" @click="chooseRetry">{{ t('quota_reset.retry_original') }}</button>
    <button v-if="reset.locked.value&&reset.phase.value!=='submitting'" class="reset-use" :disabled="!online||reset.phase.value==='checking'" @click="reset.reconcile">{{ t('quota_reset.reconcile') }}</button>
  </div>
  <Teleport to="body">
    <div v-if="selected" class="reset-confirm-backdrop" @click.self="selected=null" @keydown.esc.stop.prevent="selected=null">
      <section ref="confirmation" class="reset-confirm" role="alertdialog" aria-modal="true" :aria-label="t('quota_reset.confirm_title')" aria-describedby="quota-reset-message" tabindex="-1" @keydown.tab="trap">
        <header><h2>{{ t('quota_reset.confirm_title') }}</h2><button type="button" :aria-label="t('common.close')" @click="selected=null">×</button></header>
        <div id="quota-reset-message" class="reset-confirm-content"><p>{{ selected.label }}</p><dl><div><dt>{{ t('codex_quota.host') }}</dt><dd>{{ hostname||daemonId }}</dd></div><div><dt>{{ t(provider==='zcode'?'zcode_quota.account':'codex_quota.account') }}</dt><dd>{{ accountLabel }}</dd></div></dl><p>{{ t(retrying?'quota_reset.retry_message':'quota_reset.confirm_message') }}</p></div>
        <footer><button type="button" @click="selected=null">{{ t('common.cancel') }}</button><button type="button" class="primary" @click="confirm">{{ t('quota_reset.confirm') }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount,nextTick} from 'vue'
import {useQuotaReset} from '../../composables/useQuotaReset'
import {useLocale} from '../../composables/useLocale'
export interface ResetChoice {type:string;label:string;count:number;expires?:number[]}
const props=withDefaults(defineProps<{provider:'codex'|'zcode';daemonId:string;scopeId:string;homeId?:string;hostname?:string;accountLabel:string;supported:boolean;online:boolean;stale:boolean;choices:ResetChoice[];showCounts?:boolean;cardsStatus?:string}>(),{cardsStatus:'ok'})
const emit=defineEmits<{refresh:[];locked:[value:boolean]}>()
const {t,locale}=useLocale()
const reset=useQuotaReset(computed(()=>({provider:props.provider,daemonId:props.daemonId,scopeId:props.scopeId,homeId:props.homeId,enabled:props.supported&&props.online&&!props.stale&&props.choices.some(c=>c.count>0),recoverable:props.supported&&props.online&&!props.stale,online:props.online})))
const canUse=computed(()=>props.supported&&props.online&&!props.stale&&!reset.locked.value)
const retrying=ref(false)
const canRecover=computed(()=>props.supported&&props.online&&!props.stale)
const selected=ref<ResetChoice|null>(null),confirmation=ref<HTMLElement|null>(null)
let previous:HTMLElement|null=null,inert:[HTMLElement,boolean][]=[]
const message=computed(()=>reset.phase.value==='idle'?'':t('quota_reset.'+reset.phase.value))
const formatDate=(n:number)=>new Date(n*1000).toLocaleString(locale.value==='zh'?'zh-CN':'en-US')
function choose(choice:ResetChoice){retrying.value=false;if(canUse.value)selected.value=choice}
function chooseRetry(){if(canRecover.value){retrying.value=true;selected.value={type:'codex',label:t('codex_quota.card_name'),count:1}}}
function confirm(){const choice=selected.value;if(!choice||!(retrying.value?canRecover.value:canUse.value))return;selected.value=null;if(retrying.value)reset.retryOriginal();else reset.submit(choice.type)}
function release(){inert.forEach(([node,prior])=>node.inert=prior);inert=[];previous?.focus({preventScroll:true})}
watch(selected,async value=>{if(!value){release();return}previous=document.activeElement as HTMLElement;await nextTick();const overlay=confirmation.value?.parentElement;if(!overlay)return;inert=Array.from(document.body.children).filter((n):n is HTMLElement=>n instanceof HTMLElement&&n!==overlay&&!n.contains(overlay)&&!['SCRIPT','STYLE','LINK'].includes(n.tagName)).map(n=>[n,n.inert]);inert.forEach(([n])=>n.inert=true);confirmation.value?.querySelector<HTMLButtonElement>('footer button')?.focus()})
watch(()=>[props.scopeId,props.homeId,props.online,props.stale,props.choices.map(c=>c.type+':'+c.count).join(',')],()=>{selected.value=null})
watch(reset.phase,value=>{emit('locked',reset.locked.value);if(value==='success'||value==='noCredit'||value==='nothingToReset')emit('refresh')},{immediate:true})
function trap(e:KeyboardEvent){const nodes=Array.from(confirmation.value?.querySelectorAll<HTMLElement>('button:not(:disabled)')??[]);if(e.shiftKey&&document.activeElement===nodes[0]){e.preventDefault();nodes.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===nodes.at(-1)){e.preventDefault();nodes[0]?.focus()}}
onBeforeUnmount(release)
</script>
<style scoped>
.reset-actions{margin-top:12px}.reset-status,.reset-note{font-size:12px;line-height:1.65;color:var(--muted);margin:10px 0}.reset-status{background:var(--bg);padding:12px 14px;border-radius:9px}.reset-actions h3{font-size:12px;font-weight:400;color:var(--muted);margin:16px 0 8px}.reset-card-group{border:1px solid var(--border);border-radius:12px;overflow:hidden}.reset-card-row{padding:16px}.reset-card-row+.reset-card-row{border-top:1px solid var(--border)}.reset-total{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:14px}.reset-total strong{font-size:29px;font-weight:600;font-variant-numeric:tabular-nums}.reset-card-row>small{display:block;font-size:12px;color:var(--muted);margin-top:8px}.reset-use{color:var(--accent);border:1px solid var(--border);border-radius:9px;min-height:44px;padding:10px 12px;font:inherit;font-size:14px;background:var(--surface);cursor:pointer;margin-top:8px}.reset-use:disabled{color:var(--muted);opacity:.5;cursor:default}.reset-card-row details{font-size:12px;color:var(--muted);margin-top:10px}.reset-card-row summary{min-height:44px;display:flex;align-items:center;color:var(--accent);cursor:pointer}.reset-confirm-backdrop{position:fixed;inset:0;z-index:1100;background:#0008;backdrop-filter:blur(4px);display:grid;place-items:center;padding:24px}.reset-confirm{width:min(560px,100%);max-height:90dvh;overflow:auto;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 80px #0005}.reset-confirm header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:23px 24px 18px;border-bottom:1px solid var(--border)}.reset-confirm h2{font-size:18px;margin:0}.reset-confirm header button{border:0;background:transparent;font-size:22px;min-height:44px;min-width:44px;color:var(--muted);cursor:pointer}.reset-confirm-content{padding:20px 24px 23px;font-size:13px;line-height:1.9;color:var(--muted)}.reset-confirm-content p{margin:0}.reset-confirm dl{margin:12px 0}.reset-confirm dl div{display:flex;gap:12px}.reset-confirm dt{min-width:44px}.reset-confirm dd{margin:0;overflow-wrap:anywhere}.reset-confirm footer{display:flex;justify-content:flex-end;gap:9px;padding:17px 24px;border-top:1px solid var(--border);background:var(--bg)}.reset-confirm footer button{min-height:44px;border:1px solid var(--border);border-radius:8px;padding:10px 16px;color:var(--fg);background:var(--surface);font:inherit;cursor:pointer}.reset-confirm footer .primary{background:var(--accent);color:var(--surface);border-color:var(--accent)}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}@media(max-width:760px){.reset-confirm-backdrop{padding:0;align-items:end;backdrop-filter:none}.reset-confirm{width:100%;max-height:88dvh;border-radius:18px 18px 0 0;border:0}.reset-confirm footer{padding-bottom:max(20px,env(safe-area-inset-bottom))}}
</style>
