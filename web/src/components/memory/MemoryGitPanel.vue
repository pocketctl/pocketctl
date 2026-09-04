<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {memoryGit} from '../../services/memoryGit'
import type {MemoryGitConnection,MemoryGitExpected,MemoryGitPage,MemoryGitProposal} from '../../types/memoryGit'
import {createClientId} from '../../utils/clientId'
const props=defineProps<{scopeId:string}>(),{t}=useLocale()
const page=ref<MemoryGitPage|null>(null),selected=ref(''),detail=ref<MemoryGitProposal|null>(null),error=ref(''),loading=ref(false),busy=ref(false),unavailable=ref(false)
const exportId=ref(''),assetId=ref(''),assetKind=ref<'claim'|'rule'|'wiki'|'skill'>('rule')
const connection=computed(()=>page.value?.items.find(c=>c.connectionId===selected.value)??null)
let listRequest:AbortController|undefined,detailRequest:AbortController|undefined,actionRequest:AbortController|undefined,epoch=0
let proposalPageRequest:AbortController|undefined,cleanupPageRequest:AbortController|undefined,childEpoch=0
const proposalPageLoading=ref(false),cleanupPageLoading=ref(false),proposalContinued=ref(false),cleanupContinued=ref(false)
const childPositions=new Map<string,{proposals:boolean;cleanup:boolean}>()
function cancelChildren(){proposalPageRequest?.abort();cleanupPageRequest?.abort();childEpoch++;proposalPageLoading.value=false;cleanupPageLoading.value=false}
type Operation='review'|'apply'|'resolve'|'preview'|'enroll'|'poll'|'recover'
type Intent={scope:string;connection:string;resource:string;operation:Operation;key:string;state:'pending'|'unknown';createdAt:number;request?:string}
// Attempt ownership is transient, never part of the durable intent metadata.
const intentAttempts=new Map<string,AbortController>()
const intentStorage='memory.git.intents.v1',operations:Operation[]=['review','apply','resolve','preview','enroll','poll','recover'],storageWarning=ref(false)
function restoreIntents():Intent[]{
  try {
    const raw=sessionStorage.getItem(intentStorage);if(!raw)return []
    if(raw.length>12000)throw new Error()
    const values:unknown=JSON.parse(raw),fields=['scope','connection','resource','operation','key','state','createdAt']
    if(!Array.isArray(values)||values.length>8||values.some(v=>!v||typeof v!=='object'||Object.keys(v).some(k=>!fields.includes(k))||
      !['scope','connection','resource','key'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(v[k]))||!operations.includes(v.operation)||
      !['pending','unknown'].includes(v.state)||!Number.isSafeInteger(v.createdAt)||v.createdAt<0))throw new Error()
    return values.map(v=>({...v,state:'unknown'}))
  }catch{storageWarning.value=true;return []}
}
const intents=ref<Intent[]>(restoreIntents())
function persistIntents(){try{sessionStorage.setItem(intentStorage,JSON.stringify(intents.value.map(({scope,connection,resource,operation,key,state,createdAt})=>({scope,connection,resource,operation,key,state,createdAt}))))}catch{storageWarning.value=true}}
function revokeAttempt(key:string){
  const controller=intentAttempts.get(key);intentAttempts.delete(key)
  if(controller&&actionRequest===controller){actionRequest=undefined;busy.value=false}
  controller?.abort()
}
function suspendIntents(scrub=false){
  for(const intent of intents.value){revokeAttempt(intent.key);if(intent.state==='pending')intent.state='unknown';if(scrub)delete intent.request}
  const controller=actionRequest;actionRequest=undefined;controller?.abort();busy.value=false;persistIntents()
}
function observeGeneration(scope:string,connectionId:string,generation:string){
  if(scope!==props.scopeId)return
  if(detail.value?.connection_id===connectionId&&detail.value.generation!==generation){detailRequest?.abort();detail.value=null}
  for(const intent of intents.value)if(intent.scope===scope&&intent.connection===connectionId&&intent.request&&JSON.parse(intent.request).expected_generation!==generation){
    revokeAttempt(intent.key)
    intent.state='unknown';delete intent.request
  }
  persistIntents()
}
function retryable(intent:Intent){const age=Date.now()-intent.createdAt;return !!intent.request&&intent.scope===props.scopeId&&age>=0&&age<23*60*60*1000}
function handled(intent:Intent){if(intent.state==='pending')return;intents.value=intents.value.filter(i=>i.key!==intent.key);persistIntents()}
const slots=['base','memory','git'] as const
function clear(){detail.value=null;page.value=null;selected.value='';exportId.value='';childPositions.clear()}
function cancel(){listRequest?.abort();detailRequest?.abort();actionRequest?.abort();cancelChildren();epoch++}
function failed(reason:unknown){
  const value=reason as {status?:number;code?:string;message?:string}
  error.value=value?.message??t('memory.git.request_failed')
  if([401,403,404,410].includes(value?.status??0)||['source_invalid','authorization_stale','forbidden','purged','withdrawn'].includes(value?.code??'')){
    suspendIntents(true);cancel();clear();loading.value=false;busy.value=false;unavailable.value=true
  }
}
async function loadProposal(proposalId:string,keep=false){
  detailRequest?.abort();detailRequest=new AbortController();const controller=detailRequest,scope=props.scopeId,started=epoch
  if(!keep)detail.value=null
  try {const value=await memoryGit.proposal(scope,proposalId,controller.signal);if(!controller.signal.aborted&&started===epoch)detail.value=value}
  catch(reason){if(!controller.signal.aborted&&started===epoch)failed(reason)}
}
async function choose(c:MemoryGitConnection){
  cancelChildren();const position=childPositions.get(c.connectionId)
  proposalContinued.value=position?.proposals??false;cleanupContinued.value=position?.cleanup??false
  detailRequest?.abort();suspendIntents();detail.value=null;error.value='';selected.value=c.connectionId;exportId.value=c.exports[0]?.export_id??''
  if(c.proposals[0])await loadProposal(c.proposals[0].proposal_id)
}
async function refresh(cursor?:string){
  cancelChildren()
  listRequest?.abort();listRequest=new AbortController();const controller=listRequest,scope=props.scopeId,started=epoch
  if(!scope){clear();return}loading.value=true;error.value=''
  try {
    const value=await memoryGit.connections(scope,cursor,controller.signal)
    if(controller.signal.aborted||started!==epoch)return
    for(const c of value.items)observeGeneration(scope,c.connectionId,c.generation)
    childPositions.clear();proposalContinued.value=false;cleanupContinued.value=false
    page.value=value;unavailable.value=false
    const next=value.items.find(c=>c.connectionId===selected.value)??value.items[0]
    if(!next){detailRequest?.abort();detail.value=null;selected.value='';return}
    if(next.connectionId!==selected.value)await choose(next)
    else {exportId.value=next.exports.some(e=>e.export_id===exportId.value)?exportId.value:next.exports[0]?.export_id??''
      const proposal=next.proposals.find(p=>p.proposal_id===detail.value?.proposal_id)??next.proposals[0]
      if(proposal)await loadProposal(proposal.proposal_id,true);else {detailRequest?.abort();detail.value=null}}
  }catch(reason){if(!controller.signal.aborted&&started===epoch)failed(reason)}
  finally{if(started===epoch)loading.value=false}
}
async function loadChildren(kind:'proposals'|'cleanup',cursor?:string){
  const c=connection.value;if(!c)return
  const scope=props.scopeId,connectionId=c.connectionId,generation=c.generation,started=epoch,childStarted=childEpoch,controller=new AbortController()
  if(kind==='proposals'){proposalPageRequest?.abort();proposalPageRequest=controller;proposalPageLoading.value=true}
  else{cleanupPageRequest?.abort();cleanupPageRequest=controller;cleanupPageLoading.value=true}
  const current=()=>!controller.signal.aborted&&started===epoch&&childStarted===childEpoch&&props.scopeId===scope&&connection.value?.connectionId===connectionId&&connection.value.generation===generation
  try {
    if(kind==='proposals'){
      const value=await memoryGit.proposals(scope,connectionId,cursor,controller.signal)
      if(!current()||value.connection_id!==connectionId)return
      if(value.generation!==generation){observeGeneration(scope,connectionId,value.generation);await refresh();return}
      c.proposals=value.items;c.proposals_next_cursor=value.next_cursor;c.proposal_total=value.total;proposalContinued.value=!!cursor
      childPositions.set(connectionId,{...childPositions.get(connectionId)??{proposals:false,cleanup:false},proposals:!!cursor})
      detailRequest?.abort();detail.value=null;if(value.items[0])await loadProposal(value.items[0].proposal_id)
    }else{
      const value=await memoryGit.cleanup(scope,connectionId,cursor,controller.signal)
      if(!current()||value.connection_id!==connectionId)return
      if(value.generation!==generation){observeGeneration(scope,connectionId,value.generation);await refresh();return}
      c.cleanup=value.items;c.cleanup_next_cursor=value.next_cursor;c.cleanup_total=value.total;c.cleanup_pending_count=value.pending_count;c.cleanup_pending=value.cleanup_pending;cleanupContinued.value=!!cursor
      childPositions.set(connectionId,{...childPositions.get(connectionId)??{proposals:false,cleanup:false},cleanup:!!cursor})
    }
  }catch(reason){if(current())failed(reason)}
  finally{if(current()){if(kind==='proposals')proposalPageLoading.value=false;else cleanupPageLoading.value=false}}
}
const expected=(d:MemoryGitProposal):MemoryGitExpected=>({expected_generation:d.generation,expected_revision:d.revision,expected_policy_hash:d.policy_hash,expected_proposed_hash:d.proposed_hash,expected_asset_revision:d.expected_asset_revision})
async function retryIntent(intent:Intent){
  if(busy.value||!retryable(intent)){error.value=t('memory.git.intent_manual');return}
  actionRequest?.abort();actionRequest=new AbortController();const controller=actionRequest,started=epoch
  intentAttempts.set(intent.key,controller)
  const ownsIntent=()=>intentAttempts.get(intent.key)===controller&&!controller.signal.aborted&&started===epoch
  busy.value=true;error.value='';intent.state='pending';persistIntents()
  try {
    const body=JSON.parse(intent.request!)
    if(['enroll','poll','recover'].includes(intent.operation))await memoryGit.sync(intent.scope,intent.resource,body,intent.key,controller.signal)
    else if(intent.operation==='review')await memoryGit.review(intent.scope,intent.resource,body,intent.key,controller.signal)
    else if(intent.operation==='apply')await memoryGit.apply(intent.scope,intent.resource,body,intent.key,controller.signal)
    else if(intent.operation==='resolve')await memoryGit.resolve(intent.scope,intent.resource,body,intent.key,controller.signal)
    else await memoryGit.preview(intent.scope,intent.resource,body,intent.key,controller.signal)
    if(ownsIntent()){intentAttempts.delete(intent.key);intents.value=intents.value.filter(i=>i.key!==intent.key);persistIntents();await refresh()}
  }
  catch(reason){if(ownsIntent()){intent.state='unknown';persistIntents();failed(reason)}}
  finally{
    if(intentAttempts.get(intent.key)===controller)intentAttempts.delete(intent.key)
    if(actionRequest===controller){actionRequest=undefined;busy.value=false}
  }
}
function action(operation:Operation,resource:string,body:unknown){
  if(busy.value)return
  if(intents.value.some(i=>i.scope===props.scopeId&&i.connection===selected.value&&i.resource===resource&&i.operation===operation)){error.value=t('memory.git.intent_unknown');return}
  if(intents.value.length>=8){error.value=t('memory.git.intent_capacity');return}
  const intent:Intent={scope:props.scopeId,connection:selected.value,resource,operation,key:`git-${createClientId()}`,state:'unknown',createdAt:Date.now(),request:JSON.stringify(body)}
  intents.value.push(intent);persistIntents();void retryIntent(intents.value[intents.value.length-1])
}
function review(){const d=detail.value;if(d?.capabilities.can_review)action('review',d.proposal_id,{...expected(d),decision:'approve'})}
function apply(){const d=detail.value;if(d?.capabilities.can_apply)action('apply',d.proposal_id,expected(d))}
function resolve(side:'memory'|'git'){const d=detail.value;if(!d?.capabilities.can_resolve)return;const v=d.versions[side]
  action('resolve',d.proposal_id,{...expected(d),expected_inputs:d.expected_inputs,resolution:{path:v.path,deleted:v.deleted,editable:v.editable}})}
function sync(kind:'enroll'|'poll'|'recover',id=exportId.value){const c=connection.value;if(c?.capabilities.can_sync&&id)action(kind,c.connectionId,{expected_generation:c.generation,export_id:id,action:kind})}
function preview(){const c=connection.value;if(c?.capabilities.can_preview&&assetId.value)action('preview',c.connectionId,{expected_generation:c.generation,assets:[{kind:assetKind.value,id:assetId.value}],reason_code:'manual_preview'})}
watch(()=>props.scopeId,()=>{suspendIntents(true);cancel();clear();error.value='';busy.value=false;loading.value=false;unavailable.value=false;assetId.value='';void refresh()},{immediate:true,flush:'sync'})
onBeforeUnmount(()=>{suspendIntents(true);cancel()})
</script>

<template>
  <section class="memory-git" :aria-label="t('memory.git.title')">
    <header class="memory-git-toolbar"><div><h3>{{ t('memory.git.title') }}</h3><p>{{ t('memory.git.description') }}</p></div>
      <button class="memory-button" data-testid="git-refresh" :disabled="loading || !scopeId" @click="refresh()">{{ t('memory.git.refresh') }}</button></header>
    <div v-if="error" class="memory-notice is-error" role="alert">{{ error }}</div>
    <p v-if="storageWarning" role="alert">{{ t('memory.git.intent_storage_warning') }}</p>
    <section v-for="intent in intents" :key="intent.key" class="memory-notice" role="status"><strong>{{ t(intent.state==='pending'?'memory.git.intent_pending':'memory.git.intent_unknown') }}</strong>
      <p>{{ intent.operation }} · <code>{{ intent.scope }} / {{ intent.connection }} / {{ intent.resource }}</code></p><code>{{ intent.key }}</code>
      <p v-if="!retryable(intent)">{{ t('memory.git.intent_manual') }}</p>
      <button class="memory-button" data-testid="git-retry-intent" :disabled="busy || !retryable(intent)" @click="retryIntent(intent)">{{ t('memory.git.intent_retry') }}</button>
      <button class="memory-button" :disabled="intent.state==='pending'" @click="handled(intent)">{{ t('memory.git.intent_handled') }}</button></section>
    <p v-if="unavailable" role="status">{{ t('memory.git.unavailable') }}</p>
    <p v-else-if="loading && !page" role="status">{{ t('memory.git.loading') }}</p>
    <p v-else-if="page && !page.items.length" role="status">{{ t('memory.git.empty') }}</p>
    <div v-if="page?.items.length" class="memory-git-workspace">
      <aside class="memory-git-queue" :aria-label="t('memory.git.connections')">
        <button v-for="c in page.items" :key="c.connectionId" class="memory-git-connection" :class="{active:selected===c.connectionId}" :aria-pressed="selected===c.connectionId" @click="choose(c)">
          <strong>{{ c.provider }} · {{ c.targetBranch }}</strong><span>{{ c.capabilities.mode }} · {{ c.state }}</span><code>{{ c.connectionId }}</code></button>
        <button v-if="page.next_cursor" class="memory-button" @click="refresh(page.next_cursor!)">{{ t('memory.git.next') }}</button>
        <template v-if="connection">
          <h4>{{ t('memory.git.runs') }}</h4>
          <p v-for="run in connection.runs" :key="run.run_id"><code>{{ run.run_id }}</code><span>{{ run.state }} · {{ run.reason_code }} {{ run.unfinished ? t('memory.git.unfinished') : '' }}</span></p>
        </template>
      </aside>
      <main v-if="connection" class="memory-git-detail">
        <dl class="memory-git-status"><div><dt>{{ t('memory.git.last_success') }}</dt><dd>{{ connection.last_success ?? t('memory.git.not_run') }}</dd></div>
          <div><dt>{{ t('memory.git.current_error') }}</dt><dd>{{ connection.current_error ?? '—' }}</dd></div><div><dt>{{ t('memory.git.generation') }}</dt><dd><code>{{ connection.generation }}</code></dd></div></dl>
        <div v-if="connection.cleanup_pending || connection.cleanup_total || connection.cleanup.length" class="memory-notice" role="status" data-testid="git-cleanup"><strong>{{ t('memory.git.cleanup_pending') }} · {{ connection.cleanup_pending_count ?? 0 }} / {{ connection.cleanup_total ?? connection.cleanup.length }}</strong><p>{{ t('memory.git.cleanup_description') }}</p>
          <div v-for="entry in connection.cleanup" :key="entry.export_id"><code>{{ entry.export_id }}</code><span v-if="entry.recognized_at"> · {{ t('memory.git.recognized') }}</span>
            <button class="memory-button" :disabled="busy || !entry.cleanup_pending || !connection.capabilities.can_sync" @click="sync('recover',entry.export_id)">{{ t('memory.git.reconcile') }}</button></div>
          <button v-if="cleanupContinued" class="memory-button" data-testid="git-cleanup-first" :disabled="cleanupPageLoading" @click="loadChildren('cleanup')">{{ t('memory.git.first_page') }}</button>
          <button v-if="connection.cleanup_next_cursor" class="memory-button" data-testid="git-cleanup-next" :disabled="cleanupPageLoading" @click="loadChildren('cleanup',connection.cleanup_next_cursor)">{{ t('memory.git.next_cleanup') }}</button></div>
        <div class="memory-git-actions"><label>{{ t('memory.git.export') }}<select v-model="exportId"><option v-for="e in connection.exports" :key="e.export_id" :value="e.export_id">{{ e.export_id }}</option></select></label>
          <button class="memory-button" :disabled="busy || !exportId || !connection.capabilities.can_sync" @click="sync('enroll')">{{ t('memory.git.enroll') }}</button>
          <button class="memory-button" :disabled="busy || !exportId || !connection.capabilities.can_sync" @click="sync('poll')">{{ t('memory.git.sync') }}</button></div>
        <p class="memory-git-muted">{{ t('memory.git.enrollment_description') }}</p>
        <details v-if="connection.capabilities.can_preview" class="memory-git-preview"><summary>{{ t('memory.git.preview') }}</summary><form class="memory-git-actions" @submit.prevent="preview">
          <label>{{ t('memory.git.asset_kind') }}<select v-model="assetKind"><option>claim</option><option>rule</option><option>wiki</option><option>skill</option></select></label>
          <label>{{ t('memory.git.asset_id') }}<input v-model="assetId" required /></label><button class="memory-button" :disabled="busy || !assetId">{{ t('memory.git.preview') }}</button></form></details>
        <nav class="memory-git-proposals" :aria-label="t('memory.git.proposals')"><button v-for="p in connection.proposals" :key="p.proposal_id" class="memory-button" :aria-pressed="detail?.proposal_id===p.proposal_id" @click="loadProposal(p.proposal_id)">{{ p.state }} · {{ p.revision }}</button></nav>
        <p>{{ t('memory.git.proposal_total') }}: {{ connection.proposal_total ?? connection.proposals.length }}</p>
        <div class="memory-git-actions"><button v-if="proposalContinued" class="memory-button" data-testid="git-proposals-first" :disabled="proposalPageLoading" @click="loadChildren('proposals')">{{ t('memory.git.first_page') }}</button>
          <button v-if="connection.proposals_next_cursor" class="memory-button" data-testid="git-proposals-next" :disabled="proposalPageLoading" @click="loadChildren('proposals',connection.proposals_next_cursor)">{{ t('memory.git.next_proposals') }}</button></div>
        <article v-if="detail">
          <header class="memory-git-toolbar"><h4>{{ detail.key.kind }} · {{ detail.revision }}</h4><code>{{ detail.head_commit }}</code></header>
          <p>{{ t('memory.git.source') }}: {{ detail.source.kind }} · {{ detail.source.author_status }}</p>
          <p v-if="detail.review_reset" role="status">{{ t('memory.git.review_reset') }}</p>
          <div class="memory-git-versions"><section v-for="slot in slots" :key="slot"><h4>{{ t(`memory.git.${slot}`) }}</h4>
            <p>{{ t('memory.git.revision') }} <code>{{ detail.versions[slot].revision }}</code></p><code>{{ detail.versions[slot].content_hash }}</code>
            <p v-if="detail.versions[slot].deleted">{{ t('memory.git.deleted') }}</p><pre>{{ JSON.stringify(detail.versions[slot].editable,null,2) }}</pre></section></div>
          <ul v-if="detail.conflicts.length" class="memory-git-conflicts"><li v-for="conflict in detail.conflicts" :key="conflict.field"><strong>{{ conflict.field }}</strong> · {{ conflict.reason }}</li></ul>
          <section v-if="detail.proposed_result" class="memory-git-result" data-testid="git-proposed-result"><h4>{{ t('memory.git.proposed_result') }}</h4>
            <p>{{ t('memory.git.proposed_hash') }} <code>{{ detail.proposed_hash }}</code></p><code>{{ detail.proposed_result.path }}</code>
            <p><code>{{ detail.proposed_result.content_hash }}</code></p><p v-if="detail.proposed_result.deleted">{{ t('memory.git.deleted') }}</p>
            <pre>{{ JSON.stringify(detail.proposed_result.editable,null,2) }}</pre></section>
          <p v-else role="status">{{ t('memory.git.unresolved_result') }}</p>
          <p v-if="detail.gate_reasons.length" role="status">{{ t('memory.git.gates') }}: {{ detail.gate_reasons.join(' · ') }}</p>
          <div class="memory-git-actions"><button class="memory-button" data-testid="git-review" :disabled="busy || !detail.capabilities.can_review" @click="review">{{ t('memory.git.review') }}</button>
            <button class="memory-button" data-testid="git-apply" :disabled="busy || !detail.capabilities.can_apply" @click="apply">{{ t('memory.git.apply') }}</button>
            <button class="memory-button" :disabled="busy || !detail.capabilities.can_resolve" @click="resolve('memory')">{{ t('memory.git.use_memory') }}</button>
            <button class="memory-button" :disabled="busy || !detail.capabilities.can_resolve" @click="resolve('git')">{{ t('memory.git.use_git') }}</button></div>
        </article>
        <p class="memory-git-muted">{{ t('memory.git.external_write_disabled') }} · external_write_disabled</p>
      </main>
    </div>
  </section>
</template>
