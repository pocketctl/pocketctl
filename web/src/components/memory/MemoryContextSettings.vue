<template>
  <section class="memory-context-settings memory-config-card" data-testid="memory-context-settings">
    <h3>{{ t('memory.context.settingsTitle') }}</h3>
    <p class="hint">{{ t('memory.context.settingsHint') }}</p>
    <div v-if="loadFailed" class="memory-notice is-error" role="alert" data-testid="context-settings-load-error">
      <p>{{ t('workspace.load_failed') }}</p>
      <button class="memory-button" :disabled="loading" @click="refresh">{{ t('common.retry') }}</button>
    </div>
    <p v-else-if="loading" role="status">{{ t('common.loading') }}</p>
    <template v-else>
    <div v-for="row in settings" :key="row.settingId" class="row" :data-testid="`context-setting-${row.scopeKind}`">
      <span class="scope">{{ row.scopeKind }}:{{ row.scopeKey }}{{ row.agent ? `@${row.agent}` : '' }}</span>
      <span class="modes">
        <button class="memory-button"
          v-for="mode in ['off', 'shadow', 'enabled'] as const"
          :key="mode"
          :data-testid="`mode-${mode}-${row.scopeKind}`"
          :class="{ active: row.mode === mode, danger: mode === 'off' }"
          :disabled="busy"
          @click="setMode(row, mode)"
        >{{ t(`memory.context.mode.${mode}`) }}</button>
      </span>
      <span v-if="failed === row.settingId" class="error" data-testid="cas-conflict">{{ t('memory.context.casConflict') }}</span>
    </div>
		<div v-if="settings.length === 0" class="empty" data-testid="context-settings-empty">
			<span>{{ t('memory.context.settingsEmpty') }}</span>
			<span class="modes">
				<button class="memory-button"
					v-for="mode in ['off', 'shadow', 'enabled'] as const"
					:key="mode"
					:data-testid="`initial-mode-${mode}`"
					:disabled="busy"
					@click="setInitialMode(mode)"
				>{{ t(`memory.context.mode.${mode}`) }}</button>
			</span>
			<span v-if="failed === 'initial'" class="error" data-testid="context-settings-create-error">{{ t('memory.context.casConflict') }}</span>
		</div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextSettings } from '../../types/memory'
import { listContextSettings, putContextSetting } from '../../services/memoryClient'

const { t } = useLocale()
const settings = ref<ContextSettings[]>([])
const busy = ref(false)
const failed = ref('')
const loading = ref(false)
const loadFailed = ref(false)

async function refresh(): Promise<void> {
  loading.value = true
  loadFailed.value = false
  try {
    const result = await listContextSettings()
    settings.value = result.settings
  } catch {
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

function setMode(row: ContextSettings, mode: 'off' | 'shadow' | 'enabled'): void {
  busy.value = true
  failed.value = ''
  putContextSetting({
    scope_kind: row.scopeKind,
    scope_key: row.scopeKey,
    agent: row.agent,
    mode,
    max_tokens: row.maxTokens,
    expected_revision: row.revision,
  })
    .then(() => {
      row.mode = mode
      row.revision += 1
    })
    .catch(() => {
      failed.value = row.settingId
    })
    .finally(() => {
      busy.value = false
    })
}

function setInitialMode(mode: 'off' | 'shadow' | 'enabled'): void {
	busy.value = true
	failed.value = ''
	putContextSetting({
		scope_kind: 'installation', scope_key: 'global', agent: null,
		mode, max_tokens: null, expected_revision: 1,
	})
		.then(refresh)
		.catch(() => { failed.value = 'initial' })
		.finally(() => { busy.value = false })
}

defineExpose({ refresh })
void refresh()
</script>
