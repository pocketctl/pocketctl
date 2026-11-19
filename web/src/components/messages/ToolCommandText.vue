<template>
  <template v-for="(part, index) in parts" :key="index">
    <b v-if="part.kind === 'command'" class="command-name">{{ part.text }}</b>
    <span v-else-if="part.kind === 'string'" class="command-string">{{ part.text }}</span>
    <template v-else>{{ part.text }}</template>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { parseSimpleToolCommand } from '../../utils/toolDisplay'

const props = defineProps<{ tool?: string; text: string }>()
const parts = computed(() => {
  const raw = [{ text: props.text, kind: 'plain' }]
  const match = parseSimpleToolCommand(props.tool, props.text)
  if (!match) return raw
  const tail = match[3].split(/('[^']*'|"[^"]*")/)
  return [{ text: match[1], kind: 'plain' }, { text: match[2], kind: 'command' },
    ...tail.map((text, i) => ({ text, kind: i % 2 ? 'string' : 'plain' }))]
})
</script>

<style scoped>
.command-name { color:var(--session-command); font-weight:650; }
.command-string { color:var(--session-code); }
</style>
