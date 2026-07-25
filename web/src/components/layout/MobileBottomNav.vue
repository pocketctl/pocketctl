<template>
  <nav class="mobile-bottom-nav" :aria-label="t('mobile.primary_navigation')">
    <router-link to="/sessions" class="mobile-nav-link" :aria-label="t('nav.sessions')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span>{{ t('nav.sessions') }}</span>
      <span v-if="sessionCount > 0" class="mobile-nav-badge">{{ sessionCount }}</span>
    </router-link>
    <router-link to="/hosts" class="mobile-nav-link" :aria-label="t('nav.hosts')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01" />
      </svg>
      <span>{{ t('nav.hosts') }}</span>
    </router-link>
    <router-link to="/settings" class="mobile-nav-link" :aria-label="t('nav.settings')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3m0 14v3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M2 12h3m14 0h3M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12" />
      </svg>
      <span>{{ t('nav.settings') }}</span>
    </router-link>
  </nav>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'

defineProps<{ sessionCount: number }>()
const { t } = useLocale()
</script>

<style scoped>
.mobile-bottom-nav {
  position: fixed;
  inset: auto 0 0;
  z-index: 70;
  min-height: var(--mobile-bottom-nav-h);
  padding: 6px 16px max(6px, env(safe-area-inset-bottom));
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 94%, transparent);
  backdrop-filter: blur(14px);
}
.mobile-nav-link {
  position: relative;
  min-height: 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border-radius: var(--radius-md);
  color: var(--fg-tertiary);
  text-decoration: none;
  font-size: 11px;
  font-weight: 600;
}
.mobile-nav-link.router-link-active {
  color: var(--accent);
  background: var(--accent-muted);
}
.mobile-nav-link svg {
  width: 21px;
  height: 21px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.mobile-nav-badge {
  position: absolute;
  top: 2px;
  left: calc(50% + 10px);
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: white;
  background: var(--error);
  font-size: 10px;
}
</style>
