<template>
  <div class="team-session-list-workspace" data-testid="team-session-list-view">
    <aside class="session-panel"><TeamSessionBrowser v-if="browseScope.type === 'team'" :key="browseScope.teamId" :team-id="browseScope.teamId" @update:scope="browseScope = $event" /><PersonalSessionBrowser v-else @update:scope="browseScope = $event" /></aside>
    <main class="empty-conversation"><h2>{{ browseScope.type === 'team' ? '开始团队协作' : '从自己的主机开始' }}</h2><p>{{ browseScope.type === 'team' ? '选择共享会话继续讨论，或带上团队的在线 Agent 新建会话。' : '选择个人会话继续，或连接主机后新建会话。' }}</p></main>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import TeamSessionBrowser from '../components/session/TeamSessionBrowser.vue'
import PersonalSessionBrowser from '../components/session/PersonalSessionBrowser.vue'
import type { SessionScope } from '../composables/useScopedSessionState'
const route=useRoute(),browseScope=ref<SessionScope>(route.query.scope === 'personal' ? {type:'personal'} : {type:'team',teamId:String(route.params.teamId??'')})
watch([()=>route.params.teamId,()=>route.query.scope],([value,scope])=>{browseScope.value=scope === 'personal' ? {type:'personal'} : {type:'team',teamId:String(value??'')}})
</script>
<style scoped>
.team-session-list-workspace{height:100dvh;display:flex;overflow:hidden;color:var(--fg);background:var(--bg)}.session-panel{width:282px;flex:0 0 282px;min-height:0;border-right:1px solid var(--sidebar-border,var(--border))}.empty-conversation{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--fg-secondary)}h2{font-size:19px;color:var(--fg);font-weight:550;margin:0 0 8px}p{font-size:12px;line-height:1.9;max-width:420px}
@media(max-width:768px){.session-panel{display:flex;flex-direction:column;width:100%;flex:1}.empty-conversation{display:none}}
</style>
