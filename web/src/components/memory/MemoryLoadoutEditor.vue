<template>
  <section class="memory-loadout-editor" data-testid="memory-loadout-editor">
    <h3>{{ t('memory.loadout.title') }}</h3>
    <p class="hint">{{ t('memory.loadout.hint') }}</p>
    <p class="inert" data-testid="loadout-inert-note">{{ t('memory.loadout.inertNote') }}</p>
		<ul v-if="items.length > 0" data-testid="loadout-items">
			<li v-for="item in items" :key="item.itemId">
				<span>{{ item.assetKind }} · {{ item.claimId ?? '—' }} · {{ item.status }}</span>
				<button :disabled="busy" @click="remove(item.itemId)">{{ t('memory.loadout.remove') }}</button>
			</li>
		</ul>
		<div class="loadout-form">
			<select v-model="assetKind" data-testid="loadout-kind">
				<option value="claim">claim</option><option value="persona">persona</option><option value="runbook">runbook</option>
			</select>
			<input v-model.trim="claimId" data-testid="loadout-claim-id" :placeholder="t('memory.loadout.claimPlaceholder')">
			<input v-model.number="priority" type="number" min="0" max="100" data-testid="loadout-priority">
			<button data-testid="loadout-add" :disabled="busy || !claimId" @click="add">{{ t('memory.loadout.add') }}</button>
		</div>
		<p v-if="error" class="error" data-testid="loadout-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getContextLoadout, replaceContextLoadout } from '../../services/memoryClient'
import type { LoadoutItemSummary } from '../../types/memory'
import { createClientId } from '../../utils/clientId'
const { t } = useLocale()
const items = ref<LoadoutItemSummary[]>([])
const revision = ref(1)
const busy = ref(false)
const error = ref('')
const assetKind = ref<'claim' | 'persona' | 'runbook'>('claim')
const claimId = ref('')
const priority = ref(50)

async function load(): Promise<void> {
	const result = await getContextLoadout()
	revision.value = result.revision
	items.value = result.items
}

async function save(next: Array<{
	itemId: string; assetKind: string; claimId: string | null; representation: string; priority: number
}>): Promise<void> {
	busy.value = true
	error.value = ''
	try {
		await replaceContextLoadout({
			expected_revision: revision.value,
			items: next.map(item => ({
				item_id: item.itemId,
				asset_kind: item.assetKind as 'claim' | 'persona' | 'runbook',
				claim_id: item.claimId,
				representation: item.representation as 'summary' | 'on_demand' | 'reference',
				priority: item.priority,
			})),
		})
		await load()
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'save failed'
	} finally { busy.value = false }
}

function add(): void {
	const next = items.value.map(item => ({ ...item }))
	next.push({
		itemId: createClientId(), assetKind: assetKind.value, claimId: claimId.value,
		representation: 'summary', priority: priority.value,
		status: 'claim_inactive', claimType: null, versionId: null,
	})
	claimId.value = ''
	void save(next)
}

function remove(itemId: string): void {
	void save(items.value.filter(item => item.itemId !== itemId))
}

onMounted(() => { load().catch(cause => { error.value = cause instanceof Error ? cause.message : 'load failed' }) })
</script>
