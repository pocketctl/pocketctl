<template>
  <SessionList v-if="isMobile" />
  <SessionDetail v-else />
</template>
<script setup lang="ts">
import SessionList from "./SessionList.vue";
import SessionDetail from "./SessionDetail.vue";
import { useResponsiveLayout } from "../composables/useResponsiveLayout";
const { isMobile } = useResponsiveLayout();
</script>
