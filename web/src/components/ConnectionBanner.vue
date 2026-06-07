<template>
  <div>
    <!-- Relay connection status -->
    <div v-if="!connected" class="banner relay-banner">
      <span class="dot offline"></span>
      <span>{{ reconnecting ? 'Reconnecting...' : 'Disconnected' }}</span>
    </div>
    <div v-else class="banner connected">
      <span class="dot online"></span>
      <span>Connected</span>
    </div>

    <!-- Daemon offline banners -->
    <div v-if="offlineDaemons.length > 0" class="daemon-banners">
      <div v-if="offlineDaemons.length === 1" class="banner daemon-offline">
        <span class="daemon-icon">⚠️</span>
        <span>Daemon "{{ offlineDaemons[0].hostname }}" 离线 {{ formatRelativeTime(offlineDaemons[0].last_seen_at) }}</span>
      </div>
      <div v-else class="banner daemon-offline">
        <span class="daemon-icon">⚠️</span>
        <span>{{ offlineDaemons.length }} 个 Daemons 离线</span>
        <button class="expand-btn" @click="expanded = !expanded">
          {{ expanded ? '收起' : '详情' }}
        </button>
      </div>
      <div v-if="expanded && offlineDaemons.length > 1" class="daemon-list">
        <div v-for="d in offlineDaemons" :key="d.daemon_id" class="daemon-item">
          <span class="daemon-name">{{ d.hostname }}</span>
          <span class="daemon-time">离线 {{ formatRelativeTime(d.last_seen_at) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'

const { connected, reconnecting, daemons } = useWebSocket()
const expanded = ref(false)

const offlineDaemons = computed(() => {
  return Array.from(daemons.value.values()).filter(d => !d.online)
})
</script>

<style scoped>
.banner { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #8b949e; padding: 4px 0; }
.banner.connected { color: #3fb950; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.online { background: #3fb950; }
.dot.offline { background: #f85149; animation: pulse 1.5s infinite; }

.daemon-banners { margin-top: 4px; }
.daemon-offline {
  background: #1c1e26; border: 1px solid #d29922; border-radius: 8px;
  padding: 8px 12px; color: #d29922; margin-bottom: 4px;
}
.daemon-icon { font-size: 14px; }
.expand-btn {
  margin-left: 8px; background: none; border: 1px solid #d29922; color: #d29922;
  padding: 1px 8px; border-radius: 4px; font-size: 12px; cursor: pointer;
}
.expand-btn:hover { background: rgba(210, 153, 34, 0.15); }
.daemon-list {
  background: #161b22; border: 1px solid #30363d; border-radius: 6px;
  padding: 6px 12px; margin-top: 4px;
}
.daemon-item {
  display: flex; justify-content: space-between; padding: 4px 0;
  font-size: 12px; color: #8b949e; border-bottom: 1px solid #21262d;
}
.daemon-item:last-child { border-bottom: none; }
.daemon-name { color: #e6edf3; }
.daemon-time { color: #8b949e; }

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
