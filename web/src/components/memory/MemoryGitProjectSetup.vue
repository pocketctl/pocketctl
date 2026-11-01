<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import { getRelayOrigin } from '../../composables/useEnv'
import { createClientId } from '../../utils/clientId'
import { memoryGitProjects, type GitOpsProject } from '../../services/memoryGitProjects'
import { memoryGit } from '../../services/memoryGit'
import type { GitProjectConnection } from '../../services/memoryGit'
import MemoryGitPanel from './MemoryGitPanel.vue'

const props=defineProps<{project:GitOpsProject}>(),emit=defineEmits<{changed:[]}>()
const {t}=useLocale(),{user}=useAuth()
const connection=ref<GitProjectConnection|null>(null),token=ref(''),consent=ref(false),sharedConsent=ref(false)
const busy=ref(false),loading=ref(false),error=ref(''),unknown=ref(false),expanded=ref(false),confirmDisconnect=ref(false)
const now=ref(Date.now()),clock=setInterval(()=>{now.value=Date.now()},30_000)
const authorizeOpen=ref(false)
let epoch=0,requestKey='',controller:AbortController|undefined
let pendingGeneration:string|null|undefined
const scope=computed(()=>props.project.memory_installation_id??'')
const active=computed(()=>connection.value?.authorized===true&&Date.parse(connection.value.consent_until)>now.value)
const expiry=computed(()=>connection.value?new Date(connection.value.consent_until).toLocaleString():'—')
const canAdmin=ref(false)
const canLinkIdentity=ref(false),identityConsent=ref(false)
const identityToken=ref('')
function failure(reason:unknown) {
  const value=reason as {code?:string;status?:number}
  const keys:Record<string,string>={forbidden:'permission',repository_authorization_failed:'token_failed',repository_not_found:'repo_failed',conflict:'conflict',feature_disabled:'unavailable',source_invalid:'source_invalid',provider_unavailable:'provider_failed',credential_store_unavailable:'credential_store_unavailable'}
  error.value=t(`memory.git_setup.${keys[value.code??'']??'failed'}`)
  if([401,403,404,410].includes(value.status??0)){connection.value=null;expanded.value=false;canAdmin.value=false;token.value='';identityToken.value='';consent.value=false}
}
async function load() {
  controller?.abort();controller=new AbortController();const current=controller,started=epoch
  if(!scope.value||props.project.memory_status!=='active')return
  loading.value=true;error.value=''
  try {
    const result=await memoryGit.project(scope.value,props.project.id,current.signal)
    if(started!==epoch||current.signal.aborted)return
    if(result.project&&(result.project.repository_url!==props.project.repository_url||result.project.target_branch!==props.project.branch))throw {code:'conflict'}
    connection.value=result.project
    canAdmin.value=result.can_configure
    canLinkIdentity.value=result.can_link_identity
    if(active.value&&(!unknown.value||connection.value?.generation!==pendingGeneration)){unknown.value=false;requestKey='';pendingGeneration=undefined}
  } catch(reason) {if(started===epoch&&!current.signal.aborted)failure(reason)}
  finally {if(started===epoch)loading.value=false}
}
async function initialize() {
  if(busy.value||!sharedConsent.value)return
  const started=epoch,actor=user.value?.id??0,origin=getRelayOrigin()
  busy.value=true;error.value=''
  try {await memoryGitProjects.initialize(props.project.team_id,{userId:actor,origin,isCurrent:()=>epoch===started});if(started===epoch)emit('changed')}
  catch(reason){if(started===epoch)failure(reason)}
  finally{if(started===epoch)busy.value=false}
}
async function connect() {
  if(busy.value||!consent.value||!token.value||!canAdmin.value)return
  const started=epoch,scopeId=scope.value
  busy.value=true;error.value='';requestKey||=`connect-${createClientId()}`
  pendingGeneration=connection.value?.generation??null
  try {
    const result=await memoryGit.connectProject(scopeId,props.project.id,{project_id:props.project.id,repository_url:props.project.repository_url,branch:props.project.branch,access_token:token.value,read_consent:true,expected_generation:connection.value?.generation??null},requestKey)
    if(started!==epoch)return
    connection.value=result.project;unknown.value=false;requestKey='';consent.value=false;authorizeOpen.value=false;emit('changed')
  } catch(reason) {if(started===epoch){const status=(reason as {status?:number})?.status??0;unknown.value=status===0||status>=500;if(status>=400&&status<500)requestKey='';failure(reason)}}
  finally {if(started===epoch){token.value='';busy.value=false;const failedMessage=error.value,unconfirmed=unknown.value;await load();if(failedMessage&&(!active.value||!unconfirmed))error.value=failedMessage}}
}
async function disconnect() {
  const current=connection.value;if(!current||busy.value)return
  const started=epoch;busy.value=true;error.value=''
  try {const result=await memoryGit.disconnectProject(scope.value,props.project.id,current.generation);if(started===epoch){connection.value=result.project;expanded.value=false;confirmDisconnect.value=false;emit('changed')}}
  catch(reason){if(started===epoch)failure(reason)}
  finally{if(started===epoch)busy.value=false}
}
async function linkIdentity() {
  const current=connection.value;if(!current||busy.value||!identityToken.value||!identityConsent.value||!canLinkIdentity.value)return
  const started=epoch;busy.value=true;error.value='';expanded.value=false
  try{const result=await memoryGit.linkIdentity(scope.value,props.project.id,{access_token:identityToken.value,expected_generation:current.generation},`identity-${createClientId()}`)
    if(started===epoch){connection.value=result.project;identityConsent.value=false;emit('changed')}}
  catch(reason){if(started===epoch)failure(reason)}
  finally{if(started===epoch){identityToken.value='';busy.value=false;const failedMessage=error.value;await load();if(failedMessage)error.value=failedMessage}}
}
watch(()=>[props.project.id,scope.value,props.project.memory_status,user.value?.id,getRelayOrigin()],()=>{
  epoch++;controller?.abort();connection.value=null;token.value='';identityToken.value='';consent.value=false;sharedConsent.value=false
  busy.value=false;loading.value=false;error.value='';canAdmin.value=false;canLinkIdentity.value=false;identityConsent.value=false;authorizeOpen.value=false;expanded.value=false;confirmDisconnect.value=false;unknown.value=false;requestKey='';pendingGeneration=undefined;void load()
},{immediate:true})
onBeforeUnmount(()=>{epoch++;controller?.abort();token.value='';identityToken.value='';clearInterval(clock)})
</script>

<template>
  <div class="git-setup">
    <p v-if="error" class="memory-notice is-error" role="alert">{{error}}</p>
    <template v-if="!scope">
      <p>{{t('memory.git_setup.initialize_copy')}}</p>
      <template v-if="project.can_initialize"><label><input v-model="sharedConsent" type="checkbox" :disabled="busy"> {{t('memory.git_setup.shared_consent')}}</label>
        <button class="memory-button is-primary" :disabled="busy||!sharedConsent" @click="initialize">{{t('memory.git_setup.initialize')}}</button></template>
      <p v-else>{{t('memory.git_setup.creator_required')}}</p>
    </template>
    <template v-else-if="project.memory_status!=='active'"><p role="status">{{t(project.memory_status==='pending'?'memory.git_setup.waiting':'memory.git_setup.memory_unavailable')}}</p><button class="memory-button" :disabled="busy" @click="emit('changed')">{{t('memory.git.refresh')}}</button></template>
    <template v-else>
      <p v-if="loading" role="status">{{t('memory.git.loading')}}</p>
      <p v-if="active" class="memory-notice" role="status">{{t('memory.git_setup.connected')}} · {{t('memory.git_setup.expires')}} {{expiry}}</p>
      <p v-else-if="connection" role="status">{{t('memory.git_setup.authorization_required')}}</p>
      <p v-if="unknown" role="status">{{t('memory.git_setup.unknown')}}</p>
      <form v-if="canAdmin&&(!active||authorizeOpen)" @submit.prevent="connect" autocomplete="off" class="git-setup-form">
        <label>{{t('memory.git_setup.token')}}<input v-model="token" type="password" autocomplete="new-password" :disabled="busy" required maxlength="8192" data-testid="git-setup-token"></label>
        <p>{{t('memory.git_setup.token_help')}}</p>
        <label><input v-model="consent" type="checkbox" :disabled="busy"> {{t('memory.git_setup.read_consent')}}</label>
        <button class="memory-button is-primary" :disabled="busy||!consent||!token" data-testid="git-setup-connect">{{t('memory.git_setup.connect')}}</button>
        <button v-if="active" class="memory-button" type="button" :disabled="busy" @click="authorizeOpen=false;token='';consent=false">{{t('common.cancel')}}</button>
      </form>
      <div class="git-setup-actions"><button class="memory-button" :disabled="busy||loading" @click="load">{{t('memory.git.refresh')}}</button>
        <button v-if="active" class="memory-button is-primary" @click="expanded=!expanded">{{t(expanded?'memory.git_setup.close_workspace':'memory.git_setup.open_workspace')}}</button>
        <button v-if="active&&canAdmin" class="memory-button" :disabled="busy" @click="authorizeOpen=true">{{t('memory.git_setup.renew')}}</button>
        <button v-if="canAdmin&&connection?.authorized" class="memory-button is-danger" :disabled="busy" @click="confirmDisconnect=true">{{t('memory.git_setup.revoke')}}</button></div>
      <div v-if="confirmDisconnect" class="memory-notice"><p>{{t('memory.git_setup.revoke_copy')}}</p><button class="memory-button" :disabled="busy" @click="confirmDisconnect=false">{{t('common.cancel')}}</button><button class="memory-button is-danger" :disabled="busy" @click="disconnect">{{t('memory.git_setup.revoke_confirm')}}</button></div>
      <details v-if="active&&canLinkIdentity"><summary>{{t('memory.git_setup.link_identity')}}</summary>
        <form class="git-setup-form" @submit.prevent="linkIdentity"><p>{{t('memory.git_setup.identity_copy')}}</p>
          <label>{{t('memory.git_setup.token')}}<input v-model="identityToken" type="password" autocomplete="new-password" :disabled="busy" required></label>
          <label><input v-model="identityConsent" type="checkbox" :disabled="busy"> {{t('memory.git_setup.identity_consent')}}</label>
          <button class="memory-button" :disabled="busy||!identityToken||!identityConsent">{{t('memory.git_setup.link_identity')}}</button></form>
      </details>
      <MemoryGitPanel v-if="active&&expanded" :key="`${connection?.connection_id}:${connection?.generation}`" :scope-id="scope" :connection-id="connection?.connection_id" />
    </template>
  </div>
</template>

<style scoped>
.git-setup { border-top:1px solid var(--border);margin-top:16px;padding-top:12px; }
.git-setup p { font-size:13px;line-height:1.7;color:var(--fg-secondary); }
.git-setup label { display:block;font-size:13px;line-height:1.7;margin:12px 0; }
.git-setup-form input[type=password] { display:block;width:min(100%,480px);box-sizing:border-box;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--fg);margin-top:8px; }
.git-setup-actions { display:flex;gap:8px;flex-wrap:wrap;margin-top:12px; }
</style>
