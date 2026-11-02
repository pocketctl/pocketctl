<template>
  <section class="extraction-issues" aria-labelledby="extraction-issues-title" data-testid="extraction-issues">
    <div class="issues-heading"><h3 id="extraction-issues-title">{{ t('memory.recovery.title') }}</h3>
      <button v-if="!hideRefresh" type="button" class="memory-button" :disabled="loading || submitting !== null" @click="load">{{ t('memory.operational.refresh') }}</button>
    </div>
    <p class="memory-muted">{{ t('memory.recovery.hint') }}</p>
    <p v-if="loading && !loaded" role="status">{{ t('memory.recovery.loading') }}</p>
    <p v-if="error" class="memory-error" role="alert">{{ t(error) }}</p>
    <p v-if="loaded && !error && !issues.length" role="status">{{ t('memory.recovery.empty') }}</p>
    <article v-for="issue in issues" :key="issue.run_id" class="issue-card">
      <div class="issues-heading"><strong>{{ t(`memory.recovery.reason.${issue.reason}`) }}</strong>
        <span role="status">{{ t(`memory.recovery.status.${issue.status}`) }}</span></div>
      <p class="memory-muted issue-source">{{ t('memory.recovery.source') }} {{ issue.session_id }} · {{ issue.turn_id }}</p>
      <p class="memory-muted">{{ formatTime(issue.completed_at) }} · {{ t('memory.recovery.attempts') }} {{ issue.retry_count }}/3</p>
      <p v-if="issue.blocked_reason" class="memory-muted">{{ t(`memory.recovery.blocked.${issue.blocked_reason}`) }}</p>
      <template v-if="confirming === issue.run_id">
        <p>{{ t('memory.recovery.confirm_hint') }}</p>
        <div class="issue-actions"><button type="button" class="memory-button" :disabled="submitting !== null" @click="confirming = null">{{ t('common.cancel') }}</button>
          <button type="button" class="memory-button is-primary" data-testid="extraction-retry-confirm" :disabled="submitting !== null" @click="retry(issue)">{{ t('memory.recovery.confirm') }}</button></div>
      </template>
      <button v-else-if="issue.can_retry" type="button" class="memory-button" data-testid="extraction-retry" :disabled="submitting !== null || loading" @click="confirming = issue.run_id">{{ t('memory.recovery.retry') }}</button>
    </article>
    <p v-if="hasMore" class="memory-muted">{{ t('memory.recovery.more') }}</p>
  </section>
</template>
<script setup lang="ts">
import {onMounted,onUnmounted,ref,watch} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {listMemoryExtractionIssues,retryMemoryExtraction,type MemoryExtractionIssue} from '../../services/memoryClient'
const props=defineProps<{installationId:string;hideRefresh?:boolean}>()
const emit=defineEmits<{updated:[]}>()
const {t}=useLocale()
const issues=ref<MemoryExtractionIssue[]>([]),hasMore=ref(false),loading=ref(false),loaded=ref(false)
const error=ref(''),confirming=ref<string|null>(null),submitting=ref<string|null>(null)
let generation=0,timer:ReturnType<typeof setInterval>|undefined
function formatTime(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString()}
async function load(){
  if(loading.value||submitting.value)return
  const turn=generation
  loading.value=true
  try{
    const result=await listMemoryExtractionIssues(props.installationId)
    if(turn!==generation)return
    issues.value=result.issues;hasMore.value=result.has_more;loaded.value=true;error.value=''
    if(confirming.value&&!issues.value.some(i=>i.run_id===confirming.value&&i.can_retry))confirming.value=null
    emit('updated')
  }catch{if(turn===generation){error.value='memory.recovery.load_error';issues.value=[];hasMore.value=false}}
  finally{if(turn===generation)loading.value=false}
}
async function retry(issue:MemoryExtractionIssue){
  if(submitting.value)return
  const turn=generation
  submitting.value=issue.run_id;error.value=''
  let failed=false
  try{await retryMemoryExtraction(props.installationId,issue.run_id)}
  catch{failed=true}
  finally{if(turn===generation){submitting.value=null;confirming.value=null}}
  if(turn!==generation)return
  await load()
  if(turn===generation&&failed)error.value='memory.recovery.retry_unknown'
}
watch(()=>props.installationId,()=>{
  generation++;issues.value=[];hasMore.value=false;loading.value=false;loaded.value=false;error.value='';confirming.value=null;submitting.value=null;void load()
})
defineExpose({refresh:load})
onMounted(()=>{void load();timer=setInterval(()=>{if(!confirming.value)void load()},10000)})
onUnmounted(()=>{generation++;if(timer)clearInterval(timer)})
</script>
<style scoped>
.extraction-issues{width:100%;border-top:1px solid var(--border);padding-top:16px;color:var(--fg)}
.issues-heading,.issue-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.memory-muted{color:var(--fg-secondary)}
h3{font-size:15px;margin:0}.issue-card{padding:14px 0;border-bottom:1px solid var(--border)}
.issue-card p{margin:8px 0;line-height:1.6}.issue-source{overflow-wrap:anywhere;font-size:12px}.issue-actions{justify-content:flex-end}
</style>
