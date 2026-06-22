<template>
  <!-- Error: full-width tinted block. No left bar; a small inline error icon
       + tinted background conveys severity without the noisy stripe. -->
  <div class="error-block">
    <svg class="error-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </svg>
    <span class="error-text">{{ content }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{ content: string }>()
</script>

<style scoped>
.error-block {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  background: var(--error-bg);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  animation: fade-in 0.2s ease;
}
.error-icon {
  color: var(--error);
  flex-shrink: 0;
  margin-top: 2px;
}
.error-text {
  font-size: 13px;
  color: var(--error);
  line-height: 1.5;
  word-break: break-word;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
