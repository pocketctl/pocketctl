<template>
  <section ref="region" class="adoption" tabindex="-1" role="region" :aria-label="t('adoption.adopt')">
    <span class="terminal-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></svg></span>
    <div class="copy" role="status" aria-live="polite">
      <strong>{{ t('adoption.' + (archiveChanged && state !== 'managed' ? 'archive_changed' : state)) }}</strong>
      <small v-if="state === 'eligible'">{{ t('session.unmanaged_readonly_badge') }}</small>
      <p>{{ archiveChanged && state !== 'managed' ? t('adoption.' + state) : t('adoption.hint.' + state) }}</p>
      <p v-if="startPaused && !['remote_start_paused','waiting','binding','checking','managed'].includes(state)">{{ t('adoption.remote_start_paused') }}</p>
    </div>
    <button v-for="action in actions" ref="buttons" :key="action" type="button" class="action" :class="{secondary:action === 'cancel' || action === 'query' || (action === 'adopt' && state !== 'eligible')}" @click="act(action)">{{ t('adoption.' + (action === 'adopt' && state !== 'eligible' ? 'retry' : action)) }}</button>
    <Teleport to="body">
      <dialog ref="dialog" class="confirm" aria-labelledby="adoption-title" aria-describedby="adoption-description" @cancel.prevent="close" @click.self="close">
        <h2 id="adoption-title">{{ t('adoption.unarchive') }}</h2>
        <p id="adoption-description">{{ t('adoption.consent') }}</p>
        <div><button ref="cancelButton" autofocus @click="close">{{ t('adoption.dismiss') }}</button><button class="action" @click="accept">{{ t('adoption.unarchive') }}</button></div>
      </dialog>
    </Teleport>
  </section>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
const props = defineProps<{state:string; actions:string[]; archiveChanged?:boolean; startPaused?:boolean; confirming:boolean}>()
const emit = defineEmits<{act:[action:any]; confirm:[open:boolean]; focusHistory:[]}>()
const {t} = useLocale()
const region = ref<HTMLElement>()
const dialog = ref<HTMLDialogElement>()
const cancelButton = ref<HTMLButtonElement>()
const buttons = ref<HTMLButtonElement[]>([])
function act(action:string) { if(action === 'unarchive') emit('confirm',true); else emit('act',action) }
function close() { emit('confirm',false) }
function accept() { if (props.confirming && props.actions.includes('unarchive')) emit('act','unarchive') }
// When an action is replaced by progress, keep keyboard navigation at the
// notice. An untouched reader keeps their current position and focus.
watch(() => props.actions.join(','), async () => {
  const focused = document.activeElement
  if (!focused || !region.value?.contains(focused)) return
  await nextTick()
  if (document.activeElement === document.body || document.activeElement === region.value)
    (buttons.value?.[0] || region.value)?.focus({preventScroll:true})
})
onBeforeUnmount(() => {
  if (document.activeElement && region.value?.contains(document.activeElement)) emit('focusHistory')
})
watch(() => props.confirming, async open => {
  if (open) { dialog.value?.showModal(); await nextTick(); cancelButton.value?.focus() }
  else { dialog.value?.close(); (buttons.value?.[0] || region.value)?.focus({preventScroll:true}) }
})
</script>
<style scoped>
.adoption{width:min(760px,100%);box-sizing:border-box;display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 12px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--fg);box-shadow:var(--shadow-md);pointer-events:auto}
.terminal-icon{display:grid;place-items:center;width:38px;height:38px;background:var(--accent-muted);border-radius:11px;color:var(--accent)}
.terminal-icon svg{width:19px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.copy strong{font-size:13px}.copy small{margin-left:7px;color:var(--accent);background:var(--accent-muted);border-radius:12px;padding:2px 6px;font-size:10px}
.copy p,.confirm p{color:var(--fg-secondary);line-height:1.5}.copy p{font-size:12px;margin:3px 0 0}
.action,.confirm button{cursor:pointer;font:inherit;font-size:13px;font-weight:600;padding:8px 12px;border-radius:8px;border:1px solid var(--border);color:var(--fg);background:var(--surface)}
.action,.confirm button.action{color:#fff;border:0;border-radius:7px;background:var(--accent)}
html[data-theme=dark] .action,html[data-theme=dark] .confirm button.action{color:#0d1117}
.adoption .action.secondary{background:var(--surface-active);color:var(--fg);border:1px solid var(--border)}
.confirm{width:min(420px,calc(100% - 32px));box-sizing:border-box;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px;box-shadow:var(--shadow-md)}.confirm::backdrop{background:#0007}.confirm h2{margin:0;font-size:18px}.confirm div{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:600px){.adoption{grid-template-columns:34px minmax(0,1fr);gap:6px 10px}.adoption>.action{grid-column:2;justify-self:start;min-height:40px}.terminal-icon{width:34px;height:34px}}
</style>
