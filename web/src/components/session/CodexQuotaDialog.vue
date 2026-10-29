<template>
  <Teleport to="body">
    <div class="quota-overlay" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')">
      <section ref="panel" class="quota-dialog" role="dialog" aria-modal="true" :aria-label="t('codex_quota.title')" tabindex="-1" @keydown.tab="trapFocus">
        <header><h2>{{ t('codex_quota.title') }}</h2><button type="button" :aria-label="t('common.close')" @click="emit('close')">{{ t('common.close') }}</button></header>
        <div class="quota-dialog-content"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { usePanelFocus } from '../../composables/usePanelFocus'
import { useLocale } from '../../composables/useLocale'
const emit=defineEmits<{close:[]}>()
const {t}=useLocale()
const {panel,trapFocus}=usePanelFocus()
</script>
<style scoped>
.quota-overlay{position:fixed;inset:0;z-index:1000;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px}.quota-dialog{width:440px;max-width:100%;max-height:90dvh;display:flex;flex-direction:column;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:14px;box-shadow:0 24px 80px #0005;overflow:hidden}.quota-dialog header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0}.quota-dialog h2{font-size:17px;margin:0}.quota-dialog header button{color:var(--accent);border:0;background:transparent;font:inherit;min-height:36px;cursor:pointer}.quota-dialog-content{padding:16px 20px;overflow:auto}.quota-dialog button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
