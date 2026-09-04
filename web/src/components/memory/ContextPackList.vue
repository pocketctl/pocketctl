<template>
  <section class="context-pack-list" data-testid="context-pack-list">
    <h3>{{ t('memory.context.packTitle') }}</h3>
    <input
      v-model="sessionId"
      :placeholder="t('memory.context.sessionPlaceholder')"
      data-testid="pack-session-input"
      @keyup.enter="refresh"
    >
    <button data-testid="pack-refresh" :disabled="busy" @click="refresh">{{ t('memory.context.refresh') }}</button>
    <ul v-if="packs.length > 0" data-testid="pack-rows">
      <li v-for="pack in packs" :key="pack.pack_id" :data-testid="`pack-${pack.state}`">
				<button class="pack-select" :data-testid="`pack-select-${pack.pack_id}`" @click="emit('select', pack)">
					{{ pack.pack_id.slice(0, 8) }}
				</button>
        <span class="state" :class="pack.state">{{ stateLabel(pack.state) }}</span>
        <span class="meta">{{ pack.client_request_id }} · {{ new Date(pack.created_at).toLocaleString() }}</span>
        <span v-if="pack.delivery" class="delivery">{{ t('memory.context.delivery') }}: {{ pack.delivery.state }}</span>
        <span class="feedback">
          <button
            v-for="action in ['used', 'ignored', 'incorrect', 'harmful'] as const"
            :key="action"
            :data-testid="`feedback-${action}`"
            :class="{ danger: action === 'harmful' }"
            :disabled="busy"
            @click="sendFeedback(pack, action)"
          >{{ t(`memory.context.feedback.${action}`) }}</button>
        </span>
      </li>
    </ul>
    <div v-else-if="loaded" class="empty" data-testid="pack-empty">{{ t('memory.context.packEmpty') }}</div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextPackListEntry } from '../../types/memory'
import { listContextPacks, submitContextFeedback } from '../../services/memoryClient'

const { t } = useLocale()
const emit = defineEmits<{ (event: 'select', pack: ContextPackListEntry): void }>()
const sessionId = ref('')
const packs = ref<ContextPackListEntry[]>([])
const busy = ref(false)
const loaded = ref(false)

function stateLabel(state: string): string {
  return t(`memory.context.packState.${state}`, { state })
}

async function refresh(): Promise<void> {
  if (!sessionId.value) return
  busy.value = true
  try {
    const result = await listContextPacks(sessionId.value)
    packs.value = result.packs
    loaded.value = true
  } finally {
    busy.value = false
  }
}

function sendFeedback(pack: ContextPackListEntry, action: 'used' | 'ignored' | 'incorrect' | 'harmful'): void {
  busy.value = true
  submitContextFeedback({ packId: pack.pack_id, action })
    .finally(() => {
      busy.value = false
    })
}
</script>
