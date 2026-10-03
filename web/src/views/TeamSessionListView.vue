<template>
  <div class="team-session-list-workspace" data-testid="team-session-list-view">
    <aside class="session-panel"><TeamSessionBrowser v-if="browseScope.type === 'team'" :key="browseScope.teamId" :team-id="browseScope.teamId" @update:scope="browseScope = $event" /><PersonalSessionBrowser v-else @update:scope="browseScope = $event" /></aside>
    <main class="empty-conversation"><TopbarGithubLink class="empty-github" /><h2>{{ browseScope.type === 'team' ? t('workspace.start_team_collaboration') : t('workspace.start_from_hosts') }}</h2><p>{{ browseScope.type === 'team' ? t('workspace.team_session_empty_hint') : t('workspace.personal_session_empty_hint') }}</p></main>
  </div>
</template>
<script setup lang="ts">
import TopbarGithubLink from '../components/TopbarGithubLink.vue'
import { useLocale } from '../composables/useLocale'
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import TeamSessionBrowser from '../components/session/TeamSessionBrowser.vue'
import PersonalSessionBrowser from '../components/session/PersonalSessionBrowser.vue'
import type { SessionScope } from '../composables/useScopedSessionState'
const { t } = useLocale()
const route=useRoute(),browseScope=ref<SessionScope>(route.query.scope === 'personal' ? {type:'personal'} : {type:'team',teamId:String(route.params.teamId??'')})
watch([()=>route.params.teamId,()=>route.query.scope],([value,scope])=>{browseScope.value=scope === 'personal' ? {type:'personal'} : {type:'team',teamId:String(value??'')}})
</script>
<style scoped>
.team-session-list-workspace{height:100dvh;display:flex;overflow:hidden;color:var(--fg);background:var(--bg)}.session-panel{width:282px;flex:0 0 282px;min-height:0;border-right:1px solid var(--sidebar-border,var(--border))}.empty-conversation{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:var(--fg-secondary)}h2{font-size:19px;color:var(--fg);font-weight:550;margin:0 0 8px}p{font-size:12px;line-height:1.9;max-width:420px}
.empty-github{position:absolute;top:14px;right:18px}
@media(max-width:768px){.session-panel{display:flex;flex-direction:column;width:100%;flex:1}.empty-conversation{display:none}}
</style>
