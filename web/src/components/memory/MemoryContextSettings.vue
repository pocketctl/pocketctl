<template>
  <section class="memory-context-settings memory-config-card" data-testid="memory-context-settings">
    <h3>{{ t('memory.context.settingsTitle') }}</h3>
    <p class="hint">{{ t('memory.context.settingsHint') }}</p>
    <p class="hint">{{ t('memory.context.configuredOnly') }}</p>
    <div v-if="loadFailed" class="memory-notice is-error" role="alert" data-testid="context-settings-load-error">
      <p>{{ t('workspace.load_failed') }}</p>
      <button class="memory-button" :disabled="loading || busy" @click="refresh">{{ t('common.retry') }}</button>
    </div>
    <p v-else-if="loading" role="status">{{ t('common.loading') }}</p>
    <template v-else>
      <div v-for="row in settings" :key="row.settingId" class="row" :data-testid="`context-setting-${row.scopeKind}`">
        <div class="scope">
          <strong>{{ t(`memory.context.scope.${row.scopeKind}`) }}</strong>
          <span>{{ row.scopeKey }} · {{ row.agent || t('memory.context.allAgents') }}</span>
          <span>{{ t('memory.context.maxTokens') }}: {{ row.maxTokens ?? t('memory.context.inheritTokens') }}</span>
        </div>
        <span class="modes" role="group" :aria-label="`${t('memory.context.modeLabel')} · ${row.scopeKey}`">
          <button v-for="mode in modes" :key="mode" class="memory-button"
            :data-testid="`mode-${mode}-${row.scopeKind}`" :aria-pressed="row.mode === mode"
            :class="{ active: row.mode === mode, danger: mode === 'off' }" :disabled="busy"
            @click="setMode(row, mode)">{{ t(`memory.context.mode.${mode}`) }}</button>
        </span>
        <div v-if="failed === row.settingId" class="row-error" role="alert" :data-testid="failureKind === 'conflict' ? 'cas-conflict' : 'context-settings-request-error'">
          <span class="error">{{ t(failureKind === 'conflict' ? 'memory.context.casConflict' : 'memory.context.requestFailed') }}</span>
          <button class="memory-button" :disabled="busy" @click="refresh">{{ t('memory.context.refresh') }}</button>
          <button v-if="failureKind !== 'conflict'" class="memory-button" :disabled="busy" @click="setMode(row, attemptedMode)">{{ t('common.retry') }}</button>
        </div>
      </div>
      <p v-if="settings.length === 0" class="empty" data-testid="context-settings-empty">{{ t('memory.context.settingsEmpty') }}</p>
      <button class="memory-button" data-testid="context-settings-add" :aria-expanded="adding" :disabled="busy" @click="adding = !adding">{{ t(adding ? 'common.cancel' : 'memory.context.add') }}</button>
      <form v-if="adding" class="context-form" data-testid="context-settings-form" novalidate @submit.prevent="createSetting">
        <label>{{ t('memory.context.scopeLabel') }}<select v-model="draft.scope" :disabled="busy" data-testid="context-scope"><option v-for="scope in scopes" :key="scope" :value="scope">{{ t(`memory.context.scope.${scope}`) }}</option></select></label>
        <label v-if="draft.scope !== 'installation'">{{ t(draft.scope === 'repository' ? 'memory.context.repositoryId' : 'memory.context.sessionPlaceholder') }}<input v-model="draft.key" :disabled="busy" :maxlength="draft.scope === 'repository' ? 36 : 64" data-testid="context-key" required /></label>
        <label>{{ t('memory.context.agent') }}<select v-model="draft.agent" :disabled="busy" data-testid="context-agent"><option value="">{{ t('memory.context.allAgents') }}</option><option v-for="agent in agents" :key="agent" :value="agent">{{ agent }}</option></select></label>
        <label>{{ t('memory.context.modeLabel') }}<select v-model="draft.mode" :disabled="busy" data-testid="context-mode"><option v-for="mode in modes" :key="mode" :value="mode">{{ t(`memory.context.mode.${mode}`) }}</option></select></label>
        <label>{{ t('memory.context.maxTokens') }}<input v-model="draft.tokens" :disabled="busy" type="number" min="1" max="2000" step="1" :placeholder="t('memory.context.inheritTokens')" data-testid="context-tokens" /></label>
        <p class="hint form-wide">{{ t('memory.context.tokensHint') }}</p>
        <p v-if="createError" class="error form-wide" role="alert" data-testid="context-settings-create-error">{{ t(createError) }}</p>
        <div class="actions form-wide"><button class="memory-button" type="submit" :disabled="busy" data-testid="context-settings-create">{{ t('common.save') }}</button><button class="memory-button" type="button" :disabled="busy" @click="refresh">{{ t('memory.context.refresh') }}</button></div>
      </form>
    </template>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { ContextSettings } from '../../types/memory'
import { listContextSettings, putContextSetting } from '../../services/memoryClient'

const { t } = useLocale()
const modes = ['off', 'shadow', 'enabled'] as const
const scopes = ['installation', 'repository', 'session'] as const
const agents = ['codex', 'claude-code', 'opencode'] as const
const settings = ref<ContextSettings[]>([])
const busy = ref(false)
const failed = ref('')
const failureKind = ref<'request' | 'conflict'>('request')
const attemptedMode = ref<ContextSettings['mode']>('off')
const loading = ref(false)
const loadFailed = ref(false)
const adding = ref(false)
const createError = ref('')
const draft = reactive({ scope: 'installation' as ContextSettings['scopeKind'], key: '', agent: '', mode: 'off' as ContextSettings['mode'], tokens: '' })
const isConflict = (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === 409

async function refresh(): Promise<void> {
  loading.value = true
  loadFailed.value = false
  try {
    settings.value = (await listContextSettings()).settings
    failed.value = ''
  } catch {
    loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function setMode(row: ContextSettings, mode: ContextSettings['mode']): Promise<void> {
  if (busy.value) return
  busy.value = true
  failed.value = ''
  attemptedMode.value = mode
  try {
    const result = await putContextSetting({ scope_kind: row.scopeKind, scope_key: row.scopeKey, agent: row.agent, mode, max_tokens: row.maxTokens, expected_revision: row.revision })
    row.mode = mode
    row.revision = result.revision
  } catch (error) {
    failed.value = row.settingId
    failureKind.value = isConflict(error) ? 'conflict' : 'request'
  } finally { busy.value = false }
}

async function createSetting(): Promise<void> {
  if (busy.value) return
  createError.value = ''
  const key = draft.scope === 'installation' ? 'global'
    : draft.scope === 'repository' ? draft.key.trim().toLowerCase() : draft.key.trim()
  const tokens = String(draft.tokens).trim() === '' ? null : Number(draft.tokens)
  if (draft.scope === 'repository' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
    createError.value = 'memory.context.invalidRepository'; return
  }
  if (draft.scope === 'session' && (!key || key.length > 64)) { createError.value = 'memory.context.invalidSession'; return }
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > 2000)) { createError.value = 'memory.context.invalidTokens'; return }
  const input = { scope_kind: draft.scope, scope_key: key, agent: draft.agent || null, mode: draft.mode, max_tokens: tokens, expected_revision: 1, create_only: true }
  busy.value = true
  try {
    // Re-read before creation so stale lists cannot silently edit another row.
    settings.value = (await listContextSettings()).settings
    if (settings.value.some(row => row.scopeKind === input.scope_kind
      && (row.scopeKind === 'repository' ? row.scopeKey.toLowerCase() : row.scopeKey) === key
      && row.agent === input.agent)) {
      createError.value = 'memory.context.duplicate'; return
    }
    await putContextSetting(input)
    adding.value = false
    draft.mode = 'off'
    await refresh()
  } catch (error) {
    createError.value = isConflict(error) ? 'memory.context.createConflict' : 'memory.context.requestFailed'
  } finally { busy.value = false }
}

defineExpose({ refresh })
void refresh()
</script>

<style scoped>
.scope { display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.scope span { color: var(--fg-secondary); }
.row-error { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; flex-basis: 100%; }
.context-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.context-form label { display: grid; gap: 7px; min-width: 0; font-size: 12px; color: var(--fg-secondary); }
.form-wide { grid-column: 1 / -1; }
@media (max-width: 600px) { .context-form { grid-template-columns: minmax(0, 1fr); } }
</style>
