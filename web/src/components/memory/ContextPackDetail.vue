<template>
  <section v-if="pack" class="context-pack-detail" data-testid="context-pack-detail">
    <header><h3>{{ t('memory.context.detailTitle') }} <code>{{ pack.pack_id.slice(0, 8) }}</code></h3><p class="hint">{{ pack.agent }} · {{ pack.mode }}</p></header>
    <dl class="context-pack-status">
      <div><dt>{{ t('memory.context.state') }}</dt><dd data-testid="detail-state">{{ pack.state }}</dd></div>
      <div><dt>{{ t('memory.context.delivery') }}</dt><dd data-testid="detail-delivery">{{ pack.delivery ? pack.delivery.state : t('memory.context.notAdmitted') }}</dd></div>
      <div><dt>{{ t('memory.ui.context.agentUse') }}</dt><dd data-testid="detail-use">{{ t('memory.ui.context.useUnconfirmed') }}</dd></div>
    </dl>
    <p class="hint">{{ t('memory.ui.context.deliveryHint') }}</p>
    <p v-if="pack.error_code" role="status" class="memory-notice">{{ pack.error_code }}</p>
    <MemorySectionTabs v-model="section" :items="sections" :label="t('memory.ui.context.packSections')" panel-prefix="memory-context-pack" />
    <section id="memory-context-pack-content" v-show="section === 'content'" role="tabpanel" :aria-label="t('memory.ui.context.content')" tabindex="0">
      <h4>{{ t('memory.context.stableSection') }}</h4>
      <pre data-testid="detail-stable">{{ pack.stable_text || '—' }}</pre>
      <h4>{{ t('memory.context.dynamicSection') }}</h4>
      <pre data-testid="detail-dynamic">{{ pack.dynamic_text || '—' }}</pre>
    </section>
    <section id="memory-context-pack-items" v-show="section === 'items'" role="tabpanel" :aria-label="t('memory.ui.context.itemsSources')" tabindex="0">
      <h4>{{ t('memory.context.items') }} · {{ pack.items.length }}</h4>
      <ul data-testid="detail-items">
        <li v-for="item in pack.items" :key="item.item_id">
          <strong>{{ item.layer }} · {{ item.claim_type }} · {{ item.section }}</strong>
          <span>{{ item.reason_codes.join(', ') }}</span>
          <code>{{ item.claim_id }} / {{ item.version_id }}</code>
          <small v-if="item.evidence_ids.length > 0">{{ item.evidence_ids.join(', ') }}</small>
          <small>{{ item.representation }} · {{ t('memory.context.tokens') }} {{ item.token_count }} · #{{ item.ordinal }}</small>
        </li>
      </ul>
    </section>
    <section id="memory-context-pack-trajectory" v-show="section === 'trajectory'" role="tabpanel" :aria-label="t('memory.context.trajectory')" tabindex="0">
      <dl class="context-pack-metadata">
        <dt>{{ t('memory.context.request') }}</dt><dd>{{ pack.client_request_id }}</dd>
        <dt>{{ t('memory.ui.context.packId') }}</dt><dd>{{ pack.pack_id }}</dd>
        <dt>{{ t('memory.context.tokens') }}</dt><dd data-testid="detail-tokens">{{ pack.stable_tokens }} + {{ pack.dynamic_tokens }}</dd>
        <dt>{{ t('memory.context.revisions') }}</dt><dd>{{ pack.policy_revision }} / {{ pack.settings_revision }} / {{ pack.loadout_revision }}</dd>
        <template v-if="pack.delivery?.outcome_code"><dt>{{ t('memory.ui.context.deliveryOutcome') }}</dt><dd>{{ pack.delivery.outcome_code }}</dd></template>
      </dl>
      <section v-if="pack.trajectory" data-testid="detail-trajectory">
        <h4>{{ t('memory.context.trajectory') }}</h4>
        <p>{{ pack.trajectory.result_state }}</p>
        <p v-if="pack.trajectory.degraded_components.length > 0">{{ pack.trajectory.degraded_components.join(', ') }}</p>
        <ul><li v-for="candidate in pack.trajectory.candidates" :key="candidate.version_id">{{ candidate.decision }} · {{ candidate.reason_code }} · {{ candidate.version_id }}<small v-if="candidate.final_ordinal !== null">#{{ candidate.final_ordinal }}</small></li></ul>
      </section>
      <p v-else class="hint">{{ t('memory.ui.context.trajectoryUnknown') }}</p>
    </section>
    <section v-if="feedback" class="context-pack-feedback">
      <h4>{{ t('memory.ui.context.userFeedback') }}</h4>
      <p class="hint">{{ t('memory.ui.context.feedbackHint') }}</p>
      <div role="group" :aria-label="t('memory.ui.context.userFeedback')"><button v-for="action in ['used','ignored','incorrect','harmful'] as const" :key="action" class="memory-button" :data-testid="`feedback-${action}`" :disabled="feedbackBusy" @click="emit('feedback', action)">{{ t(`memory.context.feedback.${action}`) }}</button></div>
      <p v-if="feedbackStatus" role="status" data-testid="pack-feedback-status">{{ t(feedbackStatus) }}</p>
    </section>
    <p class="hint">{{ t('memory.context.replayHint') }}</p>
  </section>
</template>
<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextPackListEntry } from '../../types/memory'
import MemorySectionTabs from './MemorySectionTabs.vue'
const props=defineProps<{pack:ContextPackListEntry|null;feedback?:boolean;feedbackBusy?:boolean;feedbackStatus?:string}>()
const emit=defineEmits<{(event:'feedback',action:'used'|'ignored'|'incorrect'|'harmful'):void}>()
const {t}=useLocale()
const section=ref('content')
const sections=computed(()=>[{id:'content',label:t('memory.ui.context.content')},{id:'items',label:t('memory.ui.context.itemsSources')},{id:'trajectory',label:t('memory.context.trajectory')}])
watch(()=>props.pack?.pack_id,()=>{section.value='content'})
</script>
<style scoped>
.context-pack-detail{min-width:0;font-size:13px}.context-pack-detail h3{font-size:17px;margin:0}.context-pack-detail h4{font-size:13px;margin:20px 0 12px}.context-pack-detail header p{margin:8px 0}.context-pack-detail .hint{font-size:12px;color:var(--muted);line-height:1.7}.context-pack-status{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0 10px}.context-pack-status>div{padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px}.context-pack-detail dt{font-size:12px;color:var(--muted)}.context-pack-detail dd{margin:7px 0 0;overflow-wrap:anywhere}.context-pack-detail pre{font:inherit;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)}.context-pack-detail ul{list-style:none;padding:0}.context-pack-detail li{display:grid;gap:8px;padding:14px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere;line-height:1.6}.context-pack-detail code,.context-pack-detail small{font-size:11px;overflow-wrap:anywhere}.context-pack-detail small{color:var(--muted)}.context-pack-metadata{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px 16px}.context-pack-metadata dd{margin:0}.context-pack-detail [role=tabpanel]{min-width:0}
@media(max-width:600px){.context-pack-status{grid-template-columns:minmax(0,1fr)}.context-pack-detail pre{padding:12px}.context-pack-metadata{grid-template-columns:minmax(0,1fr);gap:6px}.context-pack-metadata dd{margin-bottom:10px}}
.context-pack-feedback{margin-top:24px;padding-top:8px;border-top:1px solid var(--border)}.context-pack-feedback>div{display:flex;gap:8px;flex-wrap:wrap}.context-pack-feedback button{min-height:36px}@media(max-width:600px){.context-pack-feedback button{min-height:44px}}
</style>
