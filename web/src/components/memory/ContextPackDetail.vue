<template>
  <section v-if="pack" class="context-pack-detail" data-testid="context-pack-detail">
    <h3>{{ t('memory.context.detailTitle') }} {{ pack.pack_id.slice(0, 8) }}</h3>
    <dl>
      <dt>{{ t('memory.context.state') }}</dt>
      <dd data-testid="detail-state">{{ pack.state }}</dd>
      <dt>{{ t('memory.context.delivery') }}</dt>
      <dd data-testid="detail-delivery">{{ pack.delivery ? pack.delivery.state : t('memory.context.notAdmitted') }}</dd>
      <dt>{{ t('memory.context.request') }}</dt>
      <dd>{{ pack.client_request_id }}</dd>
      <dt>{{ t('memory.context.tokens') }}</dt>
      <dd data-testid="detail-tokens">{{ pack.stable_tokens }} + {{ pack.dynamic_tokens }}</dd>
      <dt>{{ t('memory.context.revisions') }}</dt>
      <dd>{{ pack.policy_revision }} / {{ pack.settings_revision }} / {{ pack.loadout_revision }}</dd>
    </dl>
    <section>
      <h4>{{ t('memory.context.stableSection') }}</h4>
      <pre data-testid="detail-stable">{{ pack.stable_text || '—' }}</pre>
      <h4>{{ t('memory.context.dynamicSection') }}</h4>
      <pre data-testid="detail-dynamic">{{ pack.dynamic_text || '—' }}</pre>
    </section>
    <section>
      <h4>{{ t('memory.context.items') }}</h4>
      <ul data-testid="detail-items">
        <li v-for="item in pack.items" :key="item.item_id">
          <strong>{{ item.layer }} · {{ item.claim_type }} · {{ item.section }}</strong>
          <span>{{ item.reason_codes.join(', ') }}</span>
          <code>{{ item.claim_id }} / {{ item.version_id }}</code>
          <small v-if="item.evidence_ids.length > 0">{{ item.evidence_ids.join(', ') }}</small>
        </li>
      </ul>
    </section>
    <section v-if="pack.trajectory" data-testid="detail-trajectory">
      <h4>{{ t('memory.context.trajectory') }}</h4>
      <p>{{ pack.trajectory.result_state }}</p>
      <p v-if="pack.trajectory.degraded_components.length > 0">
        {{ pack.trajectory.degraded_components.join(', ') }}
      </p>
      <ul>
        <li v-for="candidate in pack.trajectory.candidates" :key="candidate.version_id">
          {{ candidate.decision }} · {{ candidate.reason_code }} · {{ candidate.version_id }}
        </li>
      </ul>
    </section>
    <p class="hint">{{ t('memory.context.replayHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { ContextPackListEntry } from '../../types/memory'

defineProps<{ pack: ContextPackListEntry | null }>()
const { t } = useLocale()
</script>
