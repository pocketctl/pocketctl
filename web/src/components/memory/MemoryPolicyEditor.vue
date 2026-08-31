<template>
  <section class="memory-policy-editor" data-testid="memory-policy-editor">
    <h3>{{ t('memory.policy.title') }}</h3>
    <label>
      {{ t('memory.policy.kind') }}
      <select v-model="kind" data-testid="policy-kind">
        <option value="extraction">extraction</option>
        <option value="context">context</option>
        <option value="ranking">ranking</option>
      </select>
    </label>
    <button data-testid="policy-load" :disabled="busy" @click="load">{{ t('memory.policy.load') }}</button>
    <pre v-if="effective" class="document" data-testid="policy-effective">{{ JSON.stringify(effective.document, null, 2) }}</pre>
    <p v-if="effective" class="hash" data-testid="policy-hash">{{ effective.effective_policy_hash.slice(0, 16) }}…</p>
		<textarea v-model="draft" rows="12" data-testid="policy-draft" :disabled="busy" />
		<div class="actions">
			<button data-testid="policy-preview" :disabled="busy" @click="preview">{{ t('memory.policy.preview') }}</button>
			<button data-testid="policy-create" :disabled="busy" @click="create">{{ t('memory.policy.create') }}</button>
		</div>
		<pre v-if="diff.length > 0" data-testid="policy-diff">{{ JSON.stringify(diff, null, 2) }}</pre>
		<ul v-if="versions.length > 0" data-testid="policy-versions">
			<li v-for="version in versions" :key="version.policy_version_id">
				<span>v{{ version.version_number }} {{ version.active ? t('memory.policy.active') : '' }}</span>
				<button v-if="!version.active && activeVersion" :disabled="busy" @click="activate(version.policy_version_id)">
					{{ t('memory.policy.activate') }}
				</button>
			</li>
		</ul>
		<p v-if="error" class="error" data-testid="policy-error">{{ error }}</p>
    <p class="hint">{{ t('memory.policy.immutableHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { EffectivePolicy, PolicyVersionSummary } from '../../types/memory'
import {
	activatePolicy, createPolicyVersion, getEffectivePolicy, listPolicyVersions, previewPolicyDiff,
} from '../../services/memoryClient'

const { t } = useLocale()
const kind = ref<'extraction' | 'context' | 'ranking'>('context')
const effective = ref<EffectivePolicy | null>(null)
const busy = ref(false)
const draft = ref('{}')
const diff = ref<Array<{ path: string; before: unknown; after: unknown }>>([])
const versions = ref<PolicyVersionSummary[]>([])
const error = ref('')
const layer = 'user' as const
const scopeKey = 'global'
const activeVersion = computed(() => versions.value.find(version => version.active) ?? null)

async function load(): Promise<void> {
  busy.value = true
	error.value = ''
  try {
    effective.value = await getEffectivePolicy(kind.value)
		draft.value = JSON.stringify(effective.value.document, null, 2)
		versions.value = (await listPolicyVersions({ kind: kind.value, layer, scope_key: scopeKey })).versions
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'load failed'
  } finally {
    busy.value = false
  }
}

function parsedDraft(): Record<string, unknown> {
	return JSON.parse(draft.value) as Record<string, unknown>
}

async function preview(): Promise<void> {
	busy.value = true
	error.value = ''
	try {
		diff.value = (await previewPolicyDiff({ kind: kind.value, document: parsedDraft() })).diff
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'preview failed'
	} finally { busy.value = false }
}

async function create(): Promise<void> {
	busy.value = true
	error.value = ''
	try {
		await createPolicyVersion({ kind: kind.value, layer, scope_key: scopeKey, document: parsedDraft() })
		await load()
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'create failed'
	} finally { busy.value = false }
}

async function activate(policyVersionId: string): Promise<void> {
	const active = activeVersion.value
	if (!active) return
	busy.value = true
	try {
		await activatePolicy({
			kind: kind.value, policy_version_id: policyVersionId,
			expected_active_version_id: active.policy_version_id,
			expected_revision: active.head_revision,
		})
		await load()
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : 'activate failed'
	} finally { busy.value = false }
}
void load()
</script>
