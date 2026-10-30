<template>
  <router-view v-slot="{ Component }">
    <component v-if="allowed" :is="Component" :key="identity" />
  </router-view>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../composables/useAuth'

const route = useRoute()
const router = useRouter()
const { isLoggedIn, user, canReadOfflineTeams } = useAuth()
const offlineTeams = computed(() => !!canReadOfflineTeams?.value && route.path === '/teams')
// Gate rendering independently of navigation: a slow guard must never retain
// a revoked account's loaded page or let its pending responses render again.
const allowed = computed(() => !route.meta.requiresAuth || isLoggedIn.value || offlineTeams.value)
const identity = computed(() => user.value?.id ?? 'signed-out')
watch([isLoggedIn, () => canReadOfflineTeams?.value, () => route.fullPath], () => {
  if (route.meta.requiresAuth && !allowed.value) {
    void router.replace(canReadOfflineTeams?.value ? '/teams' : '/login')
  }
}, { immediate: true, flush: 'post' })
</script>
