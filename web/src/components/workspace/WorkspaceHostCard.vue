<template>
  <article class="card host-card" :class="{ selected }">
    <button type="button" class="host-card-main" @click="$emit('select')">
      <div class="row"><span class="host-glyph"><WorkspaceIcon :name="/linux|ubuntu/i.test(daemon.os || '') ? 'hosts' : 'laptop'" class="icon" /></span><div class="grow"><h3>{{ daemon.daemon_alias || daemon.hostname || daemon.daemon_id?.slice(0,8) }}</h3><div class="host-meta">{{ [daemon.os,daemon.arch].filter(Boolean).join(' · ') || '—' }}</div></div><span class="badge" :class="daemon.daemon_online ? 'green' : ''">{{ t(daemon.daemon_online?'dashboard.online':'dashboard.offline') }}</span></div>
      <div class="host-bottom"><span><strong>{{ activeSessions }}</strong> {{ t('dashboard.active_sessions') }}</span><span>{{ activityLabel || t(daemon.daemon_online?'attention.time_now':'dashboard.offline') }}</span></div>
    </button>
    <button class="host-card-more icon-btn flat" type="button" :aria-label="t('session.actions.more')" @click.stop="$emit('more',$event)"><svg class="icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
    <slot />
  </article>
</template>
<script setup lang="ts">
import WorkspaceIcon from '../WorkspaceIcon.vue'
import { useLocale } from '../../composables/useLocale'
defineProps<{daemon:any;activeSessions:number;selected?:boolean;activityLabel?:string}>()
defineEmits<{select:[];more:[event:MouseEvent]}>()
const { t } = useLocale()
</script>
