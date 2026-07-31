<template>
  <div class="mobile-app-shell">
    <MobileTopBar
      :title="title"
      :connected="connected"
      :reconnecting="reconnecting"
      :is-session="isSession"
      :show-new-session="showNewSession"
      @new-session="$emit('new-session')"
    />
    <MobileBottomNav v-if="showBottomNav" :session-count="sessionCount" />
  </div>
</template>

<script setup lang="ts">
import MobileBottomNav from './MobileBottomNav.vue'
import MobileTopBar from './MobileTopBar.vue'

defineProps<{
  title: string
  connected: boolean
  reconnecting: boolean
  isSession: boolean
  showBottomNav: boolean
  showNewSession: boolean
  sessionCount: number
}>()

defineEmits<{ (event: 'new-session'): void }>()
</script>
