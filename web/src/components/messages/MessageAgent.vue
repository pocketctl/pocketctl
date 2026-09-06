<template>
  <!-- Agent text: clean full-width text block, no left bar.
       A subtle agent label + relaxed typography separates turns —
       closer to codex / zcode client content-first layout. While streaming,
       the growing text renders as plain pre-wrapped text nodes: re-running
       markdown + highlight + sanitize on every chunk dominates output latency.
       The final content switches back to the full markdown renderer. -->
  <div class="agent-block">
    <div class="block-role">{{ agentReplyLabel(agentType) }}</div>
    <div :class="['agent-body', { streaming }]">
      <div v-if="streaming" class="streaming-text">{{ content }}</div>
      <MarkdownRenderer v-else :content="content" />
      <span v-if="streaming" class="blink-cursor"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import MarkdownRenderer from '../MarkdownRenderer.vue'
import { agentReplyLabel } from '../../utils/agentDisplay'

defineProps<{ content: string; streaming?: boolean; agentType?: string }>()
</script>

<style scoped>
.agent-block {
  width: 100%;
  min-width: 0;
  animation: fade-in 0.2s ease;
}

.block-role {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg-tertiary);
  letter-spacing: 0.6px;
  margin-bottom: 6px;
}

.agent-body {
  font-size: 14px;
  line-height: 1.65;
  color: var(--fg);
  word-break: break-word;
  min-width: 0;
}

.streaming-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Streaming cursor */
.streaming .blink-cursor::after {
  content: '▎';
  animation: blink-cursor 0.8s step-end infinite;
  color: var(--accent);
  margin-left: 2px;
}
@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
