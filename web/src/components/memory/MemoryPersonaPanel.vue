<template>
  <section class="memory-persona" data-testid="memory-persona">
    <h3>{{ t('memory.persona.title') }}</h3>
    <p class="hint">{{ t('memory.persona.hint') }}</p>
		<ul v-if="items.length > 0" data-testid="memory-persona-items">
			<li v-for="item in items" :key="item.claim_id">
				<strong>{{ item.statement }}</strong>
				<small>{{ item.authority }} · {{ item.freshness_at }}</small>
			</li>
		</ul>
		<p v-else-if="error" class="error" data-testid="memory-persona-error">{{ error }}</p>
		<p v-else-if="!busy" class="empty" data-testid="memory-persona-empty">{{ t('memory.persona.empty') }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { listMemoryClaims } from '../../services/memoryClient'
import type { MemoryClaimSummary } from '../../types/memory'
const { t } = useLocale()
const items = ref<MemoryClaimSummary[]>([])
const busy = ref(false)
const error = ref('')

onMounted(async () => {
	busy.value = true
	try {
		const result = await listMemoryClaims()
		items.value = result.claims.filter(item => item.claim_type === 'work_method'
			&& (item.authority === 'user_accepted' || item.authority === 'user_corrected'))
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'load failed'
	} finally {
		busy.value = false
	}
})
</script>
