<template>
  <section class="memory-panel" data-testid="memory-settings-card">
    <header><strong>{{ t('memory.settings_title') }}</strong></header>
    <dl>
      <div class="row">
        <dt>{{ t('memory.extraction_mode') }}</dt>
        <dd>
          <select v-model="extractionMode" :disabled="busy" data-testid="memory-extraction-mode">
            <option value="off">off</option>
            <option value="shadow" :disabled="!extractionReady">shadow</option>
            <option value="enabled" :disabled="!extractionReady">enabled</option>
          </select>
        </dd>
      </div>
      <div class="row">
        <dt>{{ t('memory.embedding_mode') }}</dt>
        <dd>
          <select v-model="embeddingMode" :disabled="busy" data-testid="memory-embedding-mode">
            <option value="off">off</option>
            <option value="shadow" :disabled="!embeddingReady">shadow</option>
            <option value="enabled" :disabled="!embeddingReady">enabled</option>
          </select>
        </dd>
      </div>
    </dl>
    <p v-if="!extractionReady || !embeddingReady" class="hint" data-testid="memory-adapter-hint">
      {{ t('memory.adapter_not_configured') }}
    </p>
    <div v-if="extractionMode !== 'off' && settings?.extraction_adapter" class="adapter-disclosure" data-testid="memory-extraction-disclosure">
      <strong>Extraction</strong>
      <span>{{ settings.extraction_adapter.provider }} · {{ settings.extraction_adapter.model }}</span>
      <code>{{ settings.extraction_adapter.origin }}</code>
      <span>{{ t(settings.extraction_adapter.pricing_configured ? 'memory.cost_estimate_configured' : 'memory.cost_estimate_unconfigured') }}</span>
    </div>
    <div v-if="embeddingMode !== 'off' && settings?.embedding_adapter" class="adapter-disclosure" data-testid="memory-embedding-disclosure">
      <strong>Embedding</strong>
      <span>{{ settings.embedding_adapter.provider }} · {{ settings.embedding_adapter.model }}</span>
      <code>{{ settings.embedding_adapter.origin }}</code>
      <span>{{ t(settings.embedding_adapter.pricing_configured ? 'memory.cost_estimate_configured' : 'memory.cost_estimate_unconfigured') }}</span>
    </div>
    <div v-if="needsConfirmation" class="confirm-box" data-testid="memory-mode-confirm">
      <p v-if="needsExtractionConfirmation" data-testid="memory-extraction-confirm-copy">
        {{ t('memory.extraction_confirm_copy') }}
      </p>
      <p v-if="needsEmbeddingConfirmation" data-testid="memory-embedding-confirm-copy">
        {{ t('memory.embedding_confirm_copy') }}
      </p>
      <p>{{ t('memory.provider_retention_copy') }}</p>
      <button type="button" data-testid="memory-mode-confirm-yes" @click="save">{{ t('common.confirm') }}</button>
      <button type="button" @click="revert">{{ t('common.cancel') }}</button>
    </div>
    <div v-else-if="hasChanges" class="actions" data-testid="memory-mode-actions">
      <button type="button" data-testid="memory-mode-save" @click="save">{{ t('common.save') }}</button>
      <button type="button" @click="revert">{{ t('common.cancel') }}</button>
    </div>
    <p v-if="error" class="error" data-testid="memory-settings-error">{{ error }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getMemorySettings, patchMemorySettings } from '../../services/memoryClient'
import type { MemoryFeatureSettings } from '../../types/memory'

const { t } = useLocale()
const emit = defineEmits<{ (e: 'changed'): void }>()

const settings = ref<MemoryFeatureSettings | null>(null)
const extractionMode = ref('off')
const embeddingMode = ref('off')
const busy = ref(false)
const error = ref('')

const extractionReady = computed(() => settings.value?.extraction_ready ?? false)
const embeddingReady = computed(() => settings.value?.embedding_ready ?? false)
// Any step away from off requires an explicit confirmation of what may
// leave PocketCtl and at what cost.
const needsExtractionConfirmation = computed(() => extractionMode.value !== 'off' && (
  (settings.value?.extraction_mode ?? 'off') === 'off'
  || (settings.value?.extraction_consent_required ?? false)))
const needsEmbeddingConfirmation = computed(() => embeddingMode.value !== 'off' && (
  (settings.value?.embedding_mode ?? 'off') === 'off'
  || (settings.value?.embedding_consent_required ?? false)))
const needsConfirmation = computed(() =>
  needsExtractionConfirmation.value || needsEmbeddingConfirmation.value)
const hasChanges = computed(() => Boolean(settings.value) && (
  extractionMode.value !== settings.value!.extraction_mode
  || embeddingMode.value !== settings.value!.embedding_mode
))

onMounted(load)

async function load(): Promise<void> {
  try {
    settings.value = await getMemorySettings()
    extractionMode.value = settings.value.extraction_mode
    embeddingMode.value = settings.value.embedding_mode
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'load failed'
  }
}

function revert(): void {
  extractionMode.value = settings.value?.extraction_mode ?? 'off'
  embeddingMode.value = settings.value?.embedding_mode ?? 'off'
}

async function save(): Promise<void> {
  if (!settings.value) return
  busy.value = true
  error.value = ''
  try {
    settings.value = await patchMemorySettings(
      settings.value.revision,
      {
        ...(extractionMode.value !== settings.value.extraction_mode ? { extraction_mode: extractionMode.value } : {}),
        ...(embeddingMode.value !== settings.value.embedding_mode ? { embedding_mode: embeddingMode.value } : {}),
        ...(needsExtractionConfirmation.value && settings.value.extraction_adapter
          ? { confirm_extraction_fingerprint: settings.value.extraction_adapter.fingerprint }
          : {}),
        ...(needsEmbeddingConfirmation.value && settings.value.embedding_adapter
          ? { confirm_embedding_fingerprint: settings.value.embedding_adapter.fingerprint }
          : {}),
      },
      `web-settings-${Date.now()}`,
    )
    extractionMode.value = settings.value.extraction_mode
    embeddingMode.value = settings.value.embedding_mode
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'save failed'
    await load()
  } finally {
    busy.value = false
  }
}
</script>
