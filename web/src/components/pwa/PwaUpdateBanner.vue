<template>
  <aside v-if="pwaUpdateAvailable" class="pwa-update-banner" role="status">
    <span>{{ t('pwa.update_available') }}</span>
    <button type="button" @click="confirmPwaUpdate">{{ t('pwa.update_action') }}</button>
  </aside>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { confirmPwaUpdate, pwaUpdateAvailable } from '../../pwa/registerServiceWorker'

const { t } = useLocale()
</script>

<style scoped>
.pwa-update-banner {
  position: fixed;
  z-index: 100;
  right: 16px;
  bottom: max(16px, env(safe-area-inset-bottom));
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 32px);
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  color: var(--fg);
  box-shadow: 0 8px 30px rgba(0, 0, 0, .35);
  font-size: 12px;
}
button { min-height: 36px; padding: 0 12px; border: 0; border-radius: var(--radius-md); background: var(--accent); color: white; font-weight: 600; }
@media (max-width: 768px) {
  .pwa-update-banner { right: 10px; bottom: max(10px, env(safe-area-inset-bottom)); left: 10px; justify-content: space-between; }
}
</style>
