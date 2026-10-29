<template>
  <section class="requirements-panel" data-testid="task-requirements-panel">
    <header class="row between"><h3>{{ t('team.requirements.title') }}</h3><button class="text-btn" :disabled="m.busy||m.loading||!m.online||m.revoked" @click="m.load">{{ t('team.requirements.reload') }}</button></header>
    <p v-if="!m.online" role="status">{{ t('team.requirements.offline') }}</p>
    <p v-if="m.error" class="panel-error" role="alert">{{ m.error }}</p>
    <p v-if="m.notice" role="status">{{ m.notice }}</p>
    <p v-if="m.loading">{{ t('common.loading') }}</p>
    <template v-if="m.task">
      <p>{{ !m.task.requirements?t('team.requirements.unsaved'):m.task.requirements.readiness.status==='ready'?t('team.requirements.ready'):t('team.requirements.missing') }}<span v-if="m.task.requirements?.readiness.missing.length">{{ m.task.requirements.readiness.missing.map(key=>t(`team.requirements.${key}`)).join(' · ') }}</span></p>
      <p class="muted">{{ t('team.requirements.advisory') }}</p>
      <div v-if="m.pending" class="recovery" role="status">
        <p>{{ t('team.requirements.unknown') }}</p>
        <button class="btn" data-testid="requirements-resolve" :disabled="m.busy||!m.online" @click="m.resolve">{{ t('team.requirements.resolve') }}</button>
        <p v-if="m.missing">{{ t('team.requirements.absent') }}</p>
        <button v-if="m.missing&&!m.retryConfirm" class="btn" :disabled="m.busy||!m.online||!writesEnabled" @click="m.retryConfirm=true">{{ t('team.requirements.retry') }}</button>
        <div v-if="m.retryConfirm" class="confirmation" role="group" :aria-label="t('team.requirements.retry')"><p>{{ t('team.requirements.retry_confirm') }}</p><button class="btn" :disabled="m.busy" @click="m.retryConfirm=false">{{ t('common.cancel') }}</button><button class="btn primary" :disabled="m.busy||!m.online||!writesEnabled" @click="m.retry">{{ t('team.requirements.confirm') }}</button></div>
      </div>
      <form @submit.prevent="m.prepare('save')">
        <fieldset :disabled="!m.canEdit">
          <label v-for="key in fields" :key="key" class="team-form-field"><span>{{ t(`team.requirements.${key}`) }}</span><textarea v-model="m.draft[key]" :data-testid="`requirements-${key}`" maxlength="10000" rows="3" /></label>
          <label class="team-form-field"><span>{{ t('team.requirements.repository') }}</span><select :value="m.draft.repository?.kind??'git'" @change="repositoryKind"><option value="git">{{ t('team.requirements.git') }}</option><option value="not_applicable">{{ t('team.requirements.not_applicable') }}</option></select></label>
          <label v-if="m.draft.repository?.kind==='not_applicable'" class="team-form-field"><span>{{ t('team.requirements.repository_reason') }}</span><textarea v-model="m.draft.repository.reason" maxlength="1000" rows="2" /></label>
          <label v-else class="team-form-field"><span>{{ t('team.requirements.repository_url') }}</span><input :value="m.draft.repository?.kind==='git'?m.draft.repository.url:''" maxlength="2048" inputmode="url" @input="repositoryURL" /></label>
          <div class="row"><button type="submit" class="btn primary" data-testid="requirements-save">{{ t('common.save') }}</button><button type="button" class="btn" @click="m.discard">{{ t('team.requirements.discard') }}</button></div>
        </fieldset>
      </form>
      <section v-if="m.task.requirements?.override" class="override-record"><h4>{{ t('team.requirements.override_record') }}</h4><p>{{ memberLabel(m.task.requirements.override.actor_user_id) }} · v{{ m.task.requirements.override.requirements_revision }}</p><p class="preserve">{{ m.task.requirements.override.reason }}</p></section>
      <section v-else-if="m.canOverride"><label class="team-form-field"><span>{{ t('team.requirements.override_reason') }}</span><textarea v-model="m.reason" maxlength="1000" rows="2" /></label><button class="btn" :disabled="!m.reason.trim()" @click="m.prepare('override')">{{ t('team.requirements.override') }}</button></section>
      <div v-if="m.confirmation" class="confirmation" role="group" :aria-label="t('team.requirements.confirm')">
        <p>{{ t(m.confirmation.kind==='save'?'team.requirements.save_confirm':'team.requirements.override_confirm') }}</p>
        <button class="btn" @click="m.confirmation=null">{{ t('common.cancel') }}</button><button class="btn primary" data-testid="requirements-confirm" :disabled="!m.canEdit" @click="m.save">{{ t('team.requirements.confirm') }}</button>
      </div>
      <h4>{{ t('team.requirements.history') }}</h4>
      <p v-if="!m.history.events.length" class="muted">{{ t('team.requirements.no_history') }}</p>
      <ol class="history"><li v-for="event in m.history.events" :key="event.event_id"><strong>{{ t(`team.requirements.event_${event.kind}`) }} · v{{ event.requirements_revision }}</strong><p>{{ event.actor_user_id===null?t('team.requirements.former_member'):memberLabel(event.actor_user_id) }} · {{ new Date(event.created_at).toLocaleString() }}</p><details><summary>{{ t('team.requirements.history_details') }}</summary><p v-if="event.kind==='override'" class="preserve">{{ event.details.reason }}</p><dl v-else><template v-for="field in fields" :key="field"><dt>{{ t(`team.requirements.${field}`) }}</dt><dd class="preserve">{{ historyField(event.details.requirements,field) }}</dd></template><dt>{{ t('team.requirements.repository') }}</dt><dd class="preserve">{{ historyRepository(event.details.requirements) }}</dd></dl></details></li></ol>
      <button v-if="m.history.next_before_revision" class="btn" :disabled="m.locked" @click="m.more">{{ t('team.requirements.more') }}</button>
    </template>
  </section>
</template>
<script setup lang="ts">
import {reactive} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {useTeamTaskRequirements} from '../../composables/useTeamTaskRequirements'
import type {TeamMember,TeamTask} from '../../types/team'
const props=withDefaults(defineProps<{taskId:string;teamId:string;currentUserId:number;teamCreatorId:number;writesEnabled:boolean;members?:TeamMember[]}>(),{members:()=>[]})
const emit=defineEmits<{changed:[task:TeamTask];revoked:[]}>(),{t}=useLocale()
const m=reactive(useTeamTaskRequirements(props,task=>emit('changed',task),()=>emit('revoked')))
const fields=['goal','scope','acceptance'] as const
const memberLabel=(id:number)=>props.members.find(m=>m.user_id===id)?.display_label??t('replica.member_id',{id})
function historyField(value:unknown,key:string){return value&&typeof value==='object'&&typeof (value as Record<string,unknown>)[key]==='string'?(value as Record<string,string>)[key]:''}
function historyRepository(value:unknown){const repo=value&&typeof value==='object'?(value as {repository?:unknown}).repository:null;return historyField(repo,'url')||historyField(repo,'reason')}
function repositoryKind(e:Event){m.draft.repository=(e.target as HTMLSelectElement).value==='git'?null:{kind:'not_applicable',reason:''}}
function repositoryURL(e:Event){const url=(e.target as HTMLInputElement).value;m.draft.repository=url?{kind:'git',url}:null}
</script>
<style scoped>
.requirements-panel { margin:16px 0; padding:16px; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface); font-size:12px; line-height:1.7; }
fieldset { border:0; padding:0; margin:0; display:grid; gap:12px; min-width:0; }
.team-form-field { display:grid; gap:6px; margin-bottom:10px; }
input,textarea,select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--border); border-radius:var(--radius-md); background:var(--bg); color:var(--fg); font:inherit; }
textarea { resize:vertical; } .muted { color:var(--fg-secondary); } .panel-error { color:var(--danger); }
.confirmation,.recovery,.override-record { margin:12px 0; padding:12px; border:1px solid var(--border); border-radius:var(--radius-md); } .confirmation button+button { margin-left:8px; }
.history { padding-left:20px; } .history li { margin:12px 0; } .preserve,pre { white-space:pre-wrap; overflow-wrap:anywhere; } pre { font:inherit; } h3,h4 { font-weight:550; } button:disabled,fieldset:disabled { opacity:.6; }
</style>
