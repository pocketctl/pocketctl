<template>
  <details class="reasoning-card">
    <summary>
      <span class="reasoning-icon" aria-hidden="true">◇</span>
      <span>{{ t('session.opencode_reasoning') }}</span>
      <span v-if="streaming" class="reasoning-live">{{ t('session.opencode_reasoning_live') }}</span>
    </summary>
    <div class="reasoning-content">{{ content }}</div>
  </details>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'

defineProps<{ content: string; streaming?: boolean }>()
const { t } = useLocale()
</script>

<style scoped>
.reasoning-card { width: min(720px, 100%); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--fg-secondary); overflow: hidden; }
.reasoning-card summary { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; color: var(--fg-tertiary); font-size: 12px; font-weight: 600; user-select: none; list-style: none; }
.reasoning-card summary::-webkit-details-marker { display: none; }
.reasoning-card summary::after { content: '›'; margin-left: auto; font-size: 16px; transform: rotate(90deg); transition: transform .15s ease; }
.reasoning-card[open] summary::after { transform: rotate(-90deg); }
.reasoning-icon { color: var(--accent); font-size: 13px; }
.reasoning-live { font-weight: 400; color: var(--accent); }
.reasoning-content { padding: 0 12px 12px; border-top: 1px solid var(--border); padding-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
</style>
