<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <template v-if="module === 'search'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5M8 9h5M8 12h3" />
    </template>
    <template v-else-if="module === 'claims'">
      <path d="M8 3.5h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2Z" />
      <path d="M3 7.5v11a3 3 0 0 0 3 3h9M10 3.5v6l2.5-1.5L15 9.5v-6M10 13h5M10 16h3" />
    </template>
    <template v-else-if="module === 'wiki'">
      <path d="M12 6.5C9.5 4.5 6 4 3 5v14c3-1 6.5-.5 9 1.5 2.5-2 6-2.5 9-1.5V5c-3-1-6.5-.5-9 1.5Zm0 0v14" />
      <path d="M6.5 8.5 9 9M6.5 12l2.5.5M15 9l2.5-.5M15 12.5l2.5-.5" />
    </template>
    <template v-else-if="module === 'codegraph'">
      <rect x="3" y="9" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 12h2a2 2 0 0 0 2-2V8a2 2 0 0 1 2-2M11 12a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2" />
    </template>
    <template v-else-if="module === 'skills'">
      <path d="M14 3 5.5 13h6L10 21l8.5-10h-6L14 3Z" />
      <path d="M4 4.5v3M2.5 6H5.5M20 17v3M18.5 18.5h3" />
    </template>
    <template v-else-if="module === 'review'">
      <path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="8" y="3" width="8" height="4" rx="1.5" />
      <path d="m8 14 2.5 2.5 5.5-6" />
    </template>
    <template v-else-if="module === 'git'">
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M6 7.5v9M6 13.5h7a5 5 0 0 0 5-5" />
    </template>
    <template v-else-if="module === 'context'">
      <path d="M8 3.5H5a1.5 1.5 0 0 0-1.5 1.5v3M16 3.5h3A1.5 1.5 0 0 1 20.5 5v3M20.5 16v3a1.5 1.5 0 0 1-1.5 1.5h-3M8 20.5H5A1.5 1.5 0 0 1 3.5 19v-3" />
      <path d="M8 9h8M8 12h8M8 15h5" />
    </template>
    <template v-else-if="module === 'persona'">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1M9 18h6" />
    </template>
    <template v-else-if="module === 'policies'">
      <path d="M12 3 20 6v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3Z" />
      <path d="m8.5 11.5 2.5 2.5 4.5-5" />
    </template>
    <template v-else-if="module === 'loadouts'">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <path d="M17 14v6M14 17h6" />
    </template>
    <template v-else-if="module === 'settings'">
      <path d="M10 3h4l.5 2.5 2 1.2 2.5-.8 2 3.5-2 1.7v2.3l2 1.7-2 3.5-2.5-.8-2 1.2-.5 2.5h-4l-.5-2.5-2-1.2-2.5.8-2-3.5 2-1.7v-2.3L3 9.4l2-3.5 2.5.8 2-1.2L10 3Z" />
      <circle cx="12" cy="12.25" r="3" />
    </template>
  </svg>
</template>

<script setup lang="ts">
import type { MemoryModule } from './memoryModules'

defineProps<{ module: MemoryModule }>()
</script>
