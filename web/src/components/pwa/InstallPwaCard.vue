<template>
  <section class="install-pwa-card">
    <div class="install-pwa-icon" aria-hidden="true">P</div>
    <div class="install-pwa-copy">
      <strong>{{ t('pwa.install_title') }}</strong>
      <p>{{ installed ? t('pwa.installed_desc') : t('pwa.install_desc') }}</p>
    </div>
    <span v-if="installed" class="install-pwa-status">{{ t('pwa.installed') }}</span>
    <button v-else-if="canInstall" type="button" class="btn btn-accent" @click="promptInstall">
      {{ t('pwa.install_action') }}
    </button>
    <span v-else class="install-pwa-hint">{{ t('pwa.browser_ready') }}</span>
  </section>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { useInstallPrompt } from '../../pwa/installPrompt'

const { t } = useLocale()
const { canInstall, installed, promptInstall } = useInstallPrompt()
</script>

<style scoped>
.install-pwa-card {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.install-pwa-icon {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: var(--bg);
  background: var(--accent);
  font-size: 20px;
  font-weight: 800;
}
.install-pwa-copy { min-width: 0; }
.install-pwa-copy strong { color: var(--fg); font-size: 14px; }
.install-pwa-copy p { margin: 4px 0 0; color: var(--fg-tertiary); font-size: 12px; line-height: 1.5; }
.install-pwa-status { color: var(--success); font-size: 12px; font-weight: 600; }
.install-pwa-hint { max-width: 150px; color: var(--fg-tertiary); font-size: 11px; text-align: right; }
@media (max-width: 768px) {
  .install-pwa-card { grid-template-columns: 44px minmax(0, 1fr); }
  .install-pwa-card > :last-child { grid-column: 1 / -1; width: 100%; text-align: center; }
}
</style>
