<template>
  <nav class="mobile-bottom-nav" :aria-label="t('mobile.primary_navigation')">
    <router-link to="/sessions" class="mobile-nav-link" :aria-label="t('nav.sessions')">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
        <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
      </svg>
      <span>{{ t('nav.sessions') }}</span>
      <span v-if="sessionCount > 0" class="mobile-nav-badge">{{ sessionCount }}</span>
    </router-link>
    <router-link to="/inbox" class="mobile-nav-link" :aria-label="t('attention.title')" data-testid="mobile-nav-inbox">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      <span>{{ t('attention.title') }}</span>
      <span v-if="attentionCount > 0" class="mobile-nav-badge">{{ attentionCount > 99 ? '99+' : attentionCount }}</span>
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
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <span>{{ t('nav.settings') }}</span>
    </router-link>
  </nav>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'

withDefaults(defineProps<{ sessionCount: number; attentionCount?: number }>(), { attentionCount: 0 })
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
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
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
