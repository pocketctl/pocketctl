<template>
  <div class="app">
    <header class="app-header">
      <h1 class="logo">pocketctl</h1>
      <ConnectionBanner />
    </header>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import ConnectionBanner from './components/ConnectionBanner.vue'
</script>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #e6edf3; -webkit-text-size-adjust: 100%; }
.app { min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
.app-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid #21262d; background: #161b22; }
.logo { font-size: 18px; font-weight: 700; color: #58a6ff; }
.app-main { flex: 1; overflow: auto; }

/* Mobile responsive base */
@media (max-width: 768px) {
  .app-header { padding: 10px 14px; }
  .logo { font-size: 16px; }
}
</style>
