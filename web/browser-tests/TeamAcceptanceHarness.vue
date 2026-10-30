<template>
 <div class="design-shell"><main class="design-surface teams-page"><h1>Team 本地组件回归 · 合成数据</h1>
 <p>未连接 Relay；模拟传输即使断线也能响应，用于检查页面是否阻止写入。</p>
 <p role="status">写请求次数：{{ writes }} · 已保存说明：{{ saved.background }}</p>
 <TeamAgentTargetPicker v-model="target" :bindings="bindings" :members="members" />
 <TeamTasksPanel team-id="local-team" :team-creator-id="1" :current-user-id="1" :writes-enabled="true" :members="members" />
 </main></div>
</template>
<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import TeamTasksPanel from '../src/components/team/TeamTasksPanel.vue'
import TeamAgentTargetPicker, { type TeamAgentTargetValue } from '../src/components/team/TeamAgentTargetPicker.vue'
import { useAuth } from '../src/composables/useAuth'
import type { TeamTask, TeamSessionAgentBinding, TeamMember } from '../src/types/team'
import '../src/assets/web-shared.css'
import '../src/assets/reference-workspace.css'
import '../src/assets/reference-teams.css'
import '../src/assets/action-select.css'
const writes=ref(0)
const saved=ref({id:'local-task',team_id:'local-team',creator_user_id:1,title:'QA 本地离线任务',background:'ONLINE-ORIGINAL',state:'in_progress',holder_user_ids:[1],session_ids:[],revision:1,has_delivery_contract:false} as TeamTask)
const members=[{id:'local-member',team_id:'local-team',user_id:1,display_label:'本地验收人',state:'active',revision:1,joined_at:'2026-10-30T00:00:00Z',ended_at:null}] as TeamMember[]
const bindings=['codex','claude-code'].map((provider,i)=>({id:`binding-${i}`,offer_id:`offer-${i}`,owner_user_id:1,daemon_id:'local-host',provider,state:'active',revision:1,native_session_id:null,availability:i?'offline':'online'})) as TeamSessionAgentBinding[]
const target=ref<TeamAgentTargetValue>({mode:'discussion',offerIDs:[]})
const previousFetch=window.fetch
const auth=useAuth(), previousUser=auth.user.value
// No credentials, real API calls or persisted authentication. All JS fetches are intercepted.
auth.user.value={id:1,email:null,phone:null,display_name:'本地验收人'}
window.fetch=async (input,init)=>{
 const path=new URL(String(input),location.origin).pathname
 if(!path.startsWith('/api/team/'))throw new Error(`Harness refuses request: ${path}`)
 if(init?.method && init.method!=='GET'){
  writes.value++
  const body=JSON.parse(String(init.body))
  if(body.expected_revision!==saved.value.revision)return Response.json({error:{code:'revision_conflict',message:'revision mismatch'}},{status:409})
  saved.value={...saved.value,...body,revision:saved.value.revision+1}
 }
 return Response.json(path.endsWith('/tasks')?{tasks:[saved.value]}:{task:saved.value})
}
onBeforeUnmount(()=>{window.fetch=previousFetch;auth.user.value=previousUser})
</script>
<style>
body{margin:0;background:#f6f8fa;color:#17212d;font-family:system-ui}main{max-width:1100px;margin:auto;padding:40px}h1{font-size:22px}.target-picker{margin:250px 0 30px}.task-actions button:disabled,button:disabled{opacity:.5;cursor:not-allowed}
</style>
