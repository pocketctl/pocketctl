<script setup lang="ts">
import {ref,computed,watch} from 'vue'
import {governanceEvidenceNeeds} from '../../utils/memoryGovernance'
import type {MemoryBulkDecisionItem,MemoryBulkDecisionResult} from '../../types/memory'
import { useLocale } from '../../composables/useLocale'
import type { MemoryGovernanceQueueEntry } from '../../types/memory'

const props=defineProps<{
  entries: MemoryGovernanceQueueEntry[]
  loading: boolean
  error: string | null
  bulkResults?:MemoryBulkDecisionResult[]
  executors?:import('../../types/memory').MemoryExecutorPrincipal[]
}>()
const emit = defineEmits<{
  (e: 'delegate',input:{candidateId:string;principalId:string}):void
  (e: 'revise',input:{candidateId:string;statement:string;retainedOrdinals:number[]}):void
  (e: 'bulk',items:MemoryBulkDecisionItem[]):void
  (e: 'decide', candidateId: string, decision: 'approve' | 'request_changes' | 'reject'): void
  (e: 'publish', candidateId: string, resolution: 'new' | 'parallel' | 'supersede'): void
}>()
const { t } = useLocale()
const executorSelected=ref<Record<string,string>>({})
const editStatement=ref<Record<string,string>>({}),removed=ref<Record<string,number[]>>({})
const filter=ref('all'),selected=ref<string[]>([])
const visible=computed(()=>props.entries.filter(e=>filter.value!=='evidence'||governanceEvidenceNeeds(e)))
watch(()=>props.entries,()=>{selected.value=[];editStatement.value={};removed.value={}})
function bulk(decision:'approve'|'request_changes'|'reject'){
 const items:MemoryBulkDecisionItem[]=props.entries.filter(e=>selected.value.includes(e.candidate.candidate_id)&&e.current_revision?.bundle_hash).slice(0,20).map(e=>({candidate_id:e.candidate.candidate_id,expected_revision:e.candidate.revision,expected_hash:e.current_revision!.bundle_hash!,decision}))
 if(items.length)emit('bulk',items)
}

</script>

<template>
  <section class="memory-governance-queue" aria-live="polite">
    <p v-if="error" class="memory-governance-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="memory-governance-muted">{{ t('memory.governance.queue.loading') }}</p>
    <p v-else-if="entries.length === 0" class="memory-governance-muted">
      {{ t('memory.governance.queue.empty') }}
    </p>
    <p class="memory-governance-muted">{{ t('memory.governance.automation.adviceOnly') }}</p>
    <label class="memory-policy-field">{{ t('memory.governance.automation.filter') }}
      <select v-model="filter"><option value="all">{{ t('memory.all_types') }}</option><option value="evidence">{{ t('memory.governance.automation.needsEvidence') }}</option></select>
    </label>
    <div v-if="selected.length" class="memory-governance-actions"><span>{{ selected.length }}/20</span><button class="memory-button" type="button" :disabled="loading" @click="bulk('approve')">{{ t('memory.governance.automation.bulkApprove') }}</button><button class="memory-button" type="button" :disabled="loading" @click="bulk('reject')">{{ t('memory.governance.automation.bulkReject') }}</button></div>
    <ul v-if="bulkResults?.length" class="memory-governance-muted" aria-live="polite"><li v-for="(r,i) in bulkResults" :key="i">{{ r.candidate_id }} · {{ t(`memory.governance.automation.result.${r.status}`) }}</li></ul>
    <article v-for="entry in visible" :key="entry.candidate.candidate_id" class="memory-governance-item">
      <header class="memory-governance-item-header">
        <input v-if="entry.current_revision?.bundle_hash" v-model="selected" type="checkbox" :value="entry.candidate.candidate_id" :aria-label="t('memory.governance.automation.select')" :disabled="loading||(!selected.includes(entry.candidate.candidate_id)&&selected.length>=20)"/>

        <span class="memory-governance-state" :data-state="entry.candidate.state">{{ entry.candidate.state }}</span>
        <span class="memory-governance-revision">r{{ entry.current_revision?.revision_number ?? 1 }}</span>
        <span class="memory-governance-source">{{ entry.candidate.source_scope_kind }}</span>
        <time>{{ new Date(entry.candidate.expires_at).toLocaleDateString() }}</time>
      </header>
      <p class="memory-governance-statement">{{ entry.current_revision?.statement ?? entry.candidate.normalized_key }}</p>
      <p class="memory-governance-muted">
        {{ t('memory.governance.queue.decisions') }}: {{ entry.decisions.map(d => d.decision).join(', ') || '—' }}
      </p>
      <p class="memory-governance-muted">{{ t('memory.governance.automation.mode') }}: {{ entry.automation_mode??'off' }} · {{ entry.automation_advice?.recommendation??t('memory.governance.automation.notEvaluated') }}<span v-if="entry.automation_advice"> · {{ entry.automation_advice.reason }}</span></p>
      <p v-if="governanceEvidenceNeeds(entry)" class="memory-governance-muted">{{ t('memory.governance.automation.needsEvidence') }}</p>
      <dl v-if="entry.current_revision?.applicability" class="memory-fact-grid"><div><dt>{{ t('memory.scope_context') }}</dt><dd>{{ Object.entries(entry.current_revision.applicability as Record<string,unknown>).filter(([k])=>['scopeKind','scopeKey','branch','canonicalRepositoryKey','status'].includes(k)).map(([,v])=>v).filter(Boolean).join(' · ') }}</dd></div></dl>
      <p v-if="entry.evidence_changes" class="memory-governance-muted">{{ t('memory.governance.automation.evidenceDiff') }}: +{{ entry.evidence_changes.added }} / −{{ entry.evidence_changes.removed }} / {{ entry.evidence_changes.retained }}</p>
      <ul v-if="entry.evidence?.length" class="memory-evidence-thread"><li v-for="e in entry.evidence" :key="e.ordinal"><blockquote>{{ e.excerpt }}</blockquote></li></ul>
      <footer class="memory-governance-actions">
        <button class="memory-button" type="button" @click="emit('decide', entry.candidate.candidate_id, 'approve')">
          {{ t('memory.governance.queue.approve') }}
        </button>
        <button class="memory-button" type="button" @click="emit('decide', entry.candidate.candidate_id, 'request_changes')">
          {{ t('memory.governance.queue.requestChanges') }}
        </button>
        <button class="memory-button" type="button" @click="emit('decide', entry.candidate.candidate_id, 'reject')">
          {{ t('memory.governance.queue.reject') }}
        </button>
        <button v-if="entry.candidate.state !== 'conflict'" type="button" class="memory-button memory-governance-publish" @click="emit('publish', entry.candidate.candidate_id, 'new')">
          {{ t('memory.governance.queue.publish') }}
        </button>
      </footer>
      <details v-if="entry.current_revision?.bundle_hash"><summary>{{ t('memory.governance.delegation.title') }}</summary>
        <p class="memory-governance-muted">{{ t('memory.governance.delegation.copy') }} · {{ entry.delegated_publish_mode??'off' }}</p>
        <label class="memory-policy-field">{{ t('memory.governance.delegation.executor') }}<select v-model="executorSelected[entry.candidate.candidate_id]" :disabled="entry.delegated_publish_mode!=='enabled'"><option value="">—</option><option v-for="p in executors??[]" :key="p.principal_id" :value="p.principal_id">{{ p.provider_client_id }}</option></select></label>
        <button type="button" class="memory-button" :disabled="loading||entry.delegated_publish_mode!=='enabled'||!executorSelected[entry.candidate.candidate_id]" @click="emit('delegate',{candidateId:entry.candidate.candidate_id,principalId:executorSelected[entry.candidate.candidate_id]})">{{ t('memory.governance.delegation.create') }}</button>
      </details>
      <details v-if="entry.current_revision?.bundle_hash"><summary>{{ t('memory.edit') }}</summary>
        <label class="memory-policy-field">{{ t('memory.candidate') }}<textarea :value="editStatement[entry.candidate.candidate_id]??entry.current_revision.statement" maxlength="4000" @input="editStatement[entry.candidate.candidate_id]=($event.target as HTMLTextAreaElement).value"/></label>
        <label v-for="e in entry.evidence??[]" :key="e.ordinal" class="memory-policy-field"><input type="checkbox" :checked="!(removed[entry.candidate.candidate_id]??[]).includes(e.ordinal)" @change="removed[entry.candidate.candidate_id]=($event.target as HTMLInputElement).checked?(removed[entry.candidate.candidate_id]??[]).filter(n=>n!==e.ordinal):[...(removed[entry.candidate.candidate_id]??[]),e.ordinal]"/>{{ e.excerpt }}</label>
        <button class="memory-button" type="button" :disabled="loading" @click="emit('revise',{candidateId:entry.candidate.candidate_id,statement:editStatement[entry.candidate.candidate_id]??entry.current_revision.statement,retainedOrdinals:(entry.evidence??[]).filter(e=>!(removed[entry.candidate.candidate_id]??[]).includes(e.ordinal)).map(e=>e.ordinal)})">{{ t('memory.governance.automation.saveRevision') }}</button>
      </details>
    </article>
  </section>
</template>
