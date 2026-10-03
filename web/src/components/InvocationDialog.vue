<template>
  <ActionList v-if="value" :title="value.title || 'Codex'" :width="480" @close="$emit('close')">
    <div ref="dialog" class="invocation-dialog">
        <template v-if="value.kind === 'choose'"><button v-for="(option, i) in value.options" :key="i" class="invocation-option" @click="$emit('choose', option.arguments)">{{ option.label }}</button></template>
        <form v-else-if="value.kind === 'input'" @submit.prevent="$emit('choose', input)"><input v-model="input" autofocus aria-label="命令参数"/><button type="submit">确认</button></form>
        <template v-else><pre>{{ value.text }}</pre><button v-if="value.kind === 'copy'" @click="copy">复制回复</button><a v-if="value.kind === 'export'" :href="downloadURL" :download="value.filename">下载 Markdown</a><p role="status">{{ feedback }}</p></template>
    </div>
  </ActionList>
</template>
<script setup lang="ts">
import ActionList from './ActionList.vue'
import { ref, nextTick, onUnmounted, watch } from 'vue'
const props = defineProps<{ value: any }>()
defineEmits<{ close: []; choose: [argumentsText: string] }>()
const input = ref(''), feedback = ref('')
const dialog = ref<HTMLElement | null>(null), downloadURL = ref('')
let previousFocus: HTMLElement | null = null
function revokeDownload() { if (downloadURL.value) URL.revokeObjectURL(downloadURL.value); downloadURL.value = '' }
watch(() => props.value, async (value, oldValue) => {
  input.value = ''; feedback.value = ''; revokeDownload()
  if (value) {
    if (!oldValue) previousFocus = document.activeElement as HTMLElement | null
    if (value.kind === 'export') downloadURL.value = URL.createObjectURL(new Blob([value.text], {type:'text/markdown;charset=utf-8'}))
    await nextTick()
    ;(dialog.value?.querySelector<HTMLElement>('input,button,a[href]') || dialog.value)?.focus()
  } else { previousFocus?.focus(); previousFocus = null }
}, {immediate:true})
function trapFocus(event: KeyboardEvent) {
  const nodes = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') || [])
  const first=nodes[0], last=nodes.at(-1)
  if(!first) {event.preventDefault();dialog.value?.focus();return}
  if(event.shiftKey && (document.activeElement===first || document.activeElement===dialog.value)) {event.preventDefault();last?.focus()}
  else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first.focus()}
}
async function copy() { try { await navigator.clipboard.writeText(props.value.text || ''); feedback.value = '已复制' } catch { feedback.value = '复制失败，请手动选择内容复制' } }
onUnmounted(() => { revokeDownload(); previousFocus?.focus() })
</script>
<style scoped>
.invocation-backdrop{position:fixed;inset:0;z-index:1000;background:#0009;display:flex;align-items:center;justify-content:center;padding:20px}.invocation-dialog{min-width:0;max-width:100%;color:var(--fg)}.invocation-dialog header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.invocation-dialog button,.invocation-dialog input{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;cursor:pointer}.invocation-option{display:block;width:100%;text-align:left;margin:6px 0;min-height:44px}.invocation-dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.invocation-dialog a{color:var(--accent)}
</style>
