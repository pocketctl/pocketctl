<template>
  <div class="dsh-model-settings">
    <button class="model-trigger" type="button" :aria-label="t('session.dsh.model')" aria-haspopup="dialog" :aria-expanded="open" @click="show">
      <span class="model-symbol" aria-hidden="true">✦</span>
      <span class="trigger-name">{{ currentName }}</span>
      <span class="trigger-chevron" aria-hidden="true">⌄</span>
    </button>
    <button class="effort-trigger" type="button" :aria-label="t('session.dsh.effort')" aria-haspopup="dialog" :aria-expanded="open" @click="show">
      <span class="effort-bars" aria-hidden="true"><i></i><i></i><i></i></span>
      {{ effort || t('session.dsh.default') }}
    </button>
    <span v-if="pending" class="saving-dot" :aria-label="t('session.dsh.saving')"></span>
    <Teleport to="body">
      <div v-if="open" class="dsh-settings-overlay" @click.self="close" @keydown.esc.stop.prevent="close">
        <section ref="dialog" class="dsh-settings-panel" role="dialog" aria-modal="true" :aria-label="t('session.dsh.title')" tabindex="-1" @keydown.tab="trapFocus">
          <div class="sheet-handle" aria-hidden="true"></div>
          <header class="settings-header">
            <div><span class="settings-eyebrow">DEEPSEEK HARNESS</span><h2>{{ t('session.dsh.title') }}</h2></div>
            <button class="close-settings" type="button" :aria-label="t('session.dsh.close')" @click="close">×</button>
          </header>
          <div class="settings-content">
            <label class="model-search"><span aria-hidden="true">⌕</span><input v-model="search" :placeholder="t('session.dsh.search')" :aria-label="t('session.dsh.search')" type="search"></label>
            <div class="model-options" :aria-label="t('session.dsh.model')">
              <div v-for="group in groups" :key="group.provider" class="provider-group">
                <h3>{{ group.provider }}</h3>
                <button v-for="option in group.models" :key="option.alias" type="button" class="model-option" :class="{ selected: draftModel === option.alias }" :aria-pressed="draftModel === option.alias" :disabled="disabled || pending" @click="chooseModel(option.alias)">
                  <span class="option-icon" aria-hidden="true">✦</span>
                  <span class="option-name">{{ option.name }}</span>
                  <span v-if="draftModel === option.alias" class="selection-check" aria-hidden="true">✓</span>
                </button>
              </div>
              <p v-if="!groups.length" class="empty-models">{{ t(models.length ? 'session.dsh.noMatches' : 'session.dsh.noModels') }}</p>
            </div>
            <div class="reasoning-section">
              <div class="section-heading"><h3>{{ t('session.dsh.effort') }}</h3><span>{{ t('session.dsh.perModel') }}</span></div>
              <div class="effort-options">
                <button v-for="value in ['', ...efforts]" :key="value" type="button" :class="{ selected: draftEffort === value }" :aria-pressed="draftEffort === value" :disabled="disabled || pending || !selectedModel" @click="draftEffort = value">{{ value || t('session.dsh.default') }}</button>
              </div>
              <p v-if="selectedModel && !efforts.length" class="settings-note">{{ t('session.dsh.noEffort') }}</p>
            </div>
            <p v-if="disabledReason" class="settings-status" role="status">{{ disabledReason }}</p>
            <p v-if="error" class="settings-error" role="alert">{{ error }}</p>
          </div>
          <footer class="settings-footer">
            <p>{{ t('session.dsh.scope') }}</p>
            <div><button class="cancel-settings" type="button" @click="close">{{ t('session.dsh.cancel') }}</button><button class="apply-settings" type="button" :disabled="disabled || pending || !selectedModel || !changed" @click="apply">{{ t(pending ? 'session.dsh.saving' : 'session.dsh.apply') }}</button></div>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
type Model = { alias: string; name: string; supported_reasoning_efforts?: string[]; default_reasoning_effort?: string }
const props = defineProps<{ models: Model[]; model: string; effort: string; disabled: boolean; disabledReason: string; pending: boolean; error: string }>()
const emit = defineEmits<{ select: [model: string, effort: string] }>()
const { t } = useLocale()
const open = ref(false), search = ref(''), draftModel = ref(''), draftEffort = ref('')
const dialog = ref<HTMLElement>()
let opener: HTMLElement | null = null
let submitted = false
const currentName = computed(() => props.models.find(m => m.alias === props.model)?.name || props.model.split('/').pop() || t('session.dsh.model'))
const selectedModel = computed(() => props.models.find(m => m.alias === draftModel.value))
const efforts = computed(() => selectedModel.value?.supported_reasoning_efforts || [])
const changed = computed(() => draftModel.value !== props.model || draftEffort.value !== props.effort)
const groups = computed(() => {
  const result = new Map<string, Model[]>()
  for (const model of props.models) {
    if (!(model.name + ' ' + model.alias).toLowerCase().includes(search.value.trim().toLowerCase())) continue
    const provider = model.alias.split('/')[0] || 'DeepSeek'
    result.set(provider, [...(result.get(provider) || []), model])
  }
  return Array.from(result, ([provider, models]) => ({ provider, models }))
})
async function show() {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  draftModel.value = props.model
  draftEffort.value = props.effort
  search.value = ''
  submitted = false
  open.value = true
  await nextTick()
  dialog.value?.focus()
}
function close() { open.value = false; opener?.focus() }
function chooseModel(alias: string) {
  if (draftModel.value === alias) return
  draftModel.value = alias
  draftEffort.value = props.models.find(m => m.alias === alias)?.default_reasoning_effort || ''
}
function apply() { submitted = true; emit('select', draftModel.value, draftEffort.value) }
watch(() => props.pending, (pending, wasPending) => { if (wasPending && !pending && submitted && !props.error) close() })
function trapFocus(event: KeyboardEvent) {
  const nodes = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]') || [])
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first?.focus() }
}
</script>

<style scoped>
.dsh-model-settings { display:flex; align-items:center; min-width:0; gap:4px; }
.model-trigger,.effort-trigger { display:flex; align-items:center; gap:7px; min-height:36px; border:0; border-radius:9px; padding:0 9px; background:transparent; color:var(--fg-secondary); font:inherit; font-size:12px; cursor:pointer; }
.model-trigger { min-width:0; }
.model-trigger:hover,.effort-trigger:hover { background:var(--surface-hover); color:var(--fg); }
.trigger-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:210px; font-weight:600; }
.model-symbol { color:var(--accent); font-size:18px; }
.trigger-chevron { color:var(--fg-tertiary); }
.effort-trigger { flex-shrink:0; border:1px solid var(--border); font-size:11px; }
.effort-bars { display:flex; gap:2px; align-items:flex-end; height:12px; }
.effort-bars i { width:2px; background:currentColor; height:5px; border-radius:1px; }
.effort-bars i:nth-child(2) { height:8px; }.effort-bars i:nth-child(3) { height:12px; }
.saving-dot { width:6px; height:6px; flex-shrink:0; border-radius:50%; background:var(--accent); }
.dsh-settings-overlay { position:fixed; inset:0; z-index:1200; background:rgba(0,0,0,.36); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; padding:24px; }
.dsh-settings-panel { width:480px; max-width:100%; max-height:calc(100dvh - 48px); display:flex; flex-direction:column; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:20px; box-shadow:0 24px 80px #0004; outline:none; overflow:hidden; }
.settings-header { padding:24px 24px 18px; display:flex; justify-content:space-between; align-items:center; gap:16px; }
.settings-eyebrow { font-size:10px; font-weight:650; letter-spacing:1.5px; color:var(--fg-tertiary); }
.settings-header h2 { font-size:20px; letter-spacing:-.4px; margin:6px 0 0; }
.close-settings { width:36px; height:36px; border:0; border-radius:50%; color:var(--fg-secondary); background:var(--surface-hover); font-size:24px; cursor:pointer; }
.settings-content { min-height:0; overflow:auto; padding:0 24px 20px; overscroll-behavior:contain; }
.model-search { display:flex; align-items:center; gap:10px; padding:0 13px; border:1px solid var(--border); border-radius:10px; color:var(--fg-tertiary); }
.model-search input { width:100%; height:42px; border:0; outline:none; background:transparent; color:var(--fg); font:inherit; font-size:13px; }
.model-search:focus-within { border-color:var(--accent); }
.model-options { max-height:280px; overflow:auto; margin-top:18px; overscroll-behavior:contain; }
.provider-group + .provider-group { margin-top:16px; }
.provider-group h3 { margin:0 8px 6px; color:var(--fg-tertiary); font-size:11px; font-weight:500; }
.model-option { display:flex; align-items:center; width:100%; min-height:48px; gap:10px; padding:10px 12px; border:1px solid transparent; border-radius:10px; background:transparent; color:var(--fg); text-align:left; cursor:pointer; font:inherit; font-size:13px; }
.model-option:hover:not(:disabled) { background:var(--surface-hover); }
.model-option.selected { border-color:color-mix(in srgb,var(--accent) 35%,transparent); background:color-mix(in srgb,var(--accent) 8%,transparent); }
.option-icon { color:var(--fg-tertiary); font-size:20px; }.selected .option-icon,.selection-check { color:var(--accent); }
.option-name { flex:1; overflow-wrap:anywhere; font-weight:550; }
.selection-check { font-size:17px; }
.reasoning-section { border-top:1px solid var(--border); padding-top:18px; margin-top:18px; }
.section-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.section-heading h3 { font-size:13px; margin:0; }.section-heading span { color:var(--fg-tertiary); font-size:11px; }
.effort-options { display:flex; flex-wrap:wrap; gap:6px; }
.effort-options button { flex:1; min-width:54px; min-height:40px; padding:7px 10px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--fg-secondary); cursor:pointer; font:inherit; font-size:12px; }
.effort-options button.selected { background:var(--fg); border-color:var(--fg); color:var(--bg); }
.settings-note,.settings-status,.settings-error,.empty-models { font-size:12px; line-height:1.6; color:var(--fg-tertiary); margin:12px 0 0; }
.settings-status { padding:10px 12px; border-radius:8px; background:var(--surface-hover); }.settings-error { color:var(--error,#d34b4b); }
.settings-footer { border-top:1px solid var(--border); padding:16px 24px 20px; }
.settings-footer p { color:var(--fg-tertiary); font-size:11px; line-height:1.5; margin:0 0 14px; }
.settings-footer > div { display:flex; justify-content:flex-end; gap:8px; }
.settings-footer button { min-height:40px; padding:0 20px; border-radius:9px; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.cancel-settings { border:1px solid var(--border); background:transparent; color:var(--fg-secondary); }
.apply-settings { border:1px solid var(--accent); background:var(--accent); color:#fff; }
button:disabled { opacity:.45; cursor:not-allowed; }
button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.sheet-handle { display:none; }
@media(max-width:640px) {
  .model-trigger,.effort-trigger { min-height:44px; padding:0 6px; gap:5px; }
  .trigger-name { max-width:160px; font-size:11px; }.effort-trigger { border:0; font-size:11px; }
  .dsh-settings-overlay { align-items:flex-end; padding:0; }
  .dsh-settings-panel { width:100%; max-height:90dvh; border-radius:22px 22px 0 0; border-bottom:0; }
  .sheet-handle { display:block; flex-shrink:0; width:32px; height:4px; border-radius:4px; background:var(--border); margin:10px auto 0; }
  .settings-header { padding:16px 20px; }.settings-header h2 { font-size:19px; }
  .settings-content { padding:0 20px 20px; }.model-options { max-height:32dvh; }
  .settings-footer { padding:14px 20px max(20px,env(safe-area-inset-bottom)); }
  .settings-footer > div button { flex:1; min-height:46px; }.effort-options button { min-height:44px; }
  .close-settings { width:44px; height:44px; }
}
</style>
