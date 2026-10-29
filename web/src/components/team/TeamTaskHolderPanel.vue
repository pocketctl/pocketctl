<template>
 <section class="holder-panel" data-testid="task-holder-panel" :aria-label="t('team.holder.title')">
  <p class="muted">{{ t('team.holder.advisory') }}</p>
  <p v-if="!m.online" role="status">{{ t('team.holder.offline') }}</p>
  <p v-if="m.error" role="alert" class="panel-error">{{ m.error }}</p>
  <p v-if="m.notice" role="status">{{ m.notice }}</p>
  <p v-if="m.loading">{{ t('common.loading') }}</p>
  <template v-if="!m.revoked">
   <div v-if="m.pending" class="confirmation" role="status">
    <p>{{ t('team.holder.unknown') }}</p>
    <p>{{ t(m.pending.active?'team.claim':'team.unclaim') }}</p>
    <button class="btn" data-testid="holder-resolve" :disabled="m.busy||m.loading||!m.online" @click="m.resolve">{{ t('team.holder.resolve') }}</button>
    <p v-if="m.missing">{{ t('team.holder.absent') }}</p>
    <button v-if="m.missing&&!m.retryConfirm" class="btn" data-testid="holder-retry-open" :disabled="m.busy||!m.online||!writesEnabled||!m.ready" @click="m.retryConfirm=true">{{ t('team.holder.retry') }}</button>
    <div v-if="m.retryConfirm" role="group" :aria-label="t('team.holder.retry')"><p>{{ t('team.holder.retry_confirm') }}</p><button class="btn" @click="m.retryConfirm=false">{{ t('common.cancel') }}</button><button class="btn primary" data-testid="holder-retry" :disabled="m.busy||!m.online||!writesEnabled" @click="m.retry">{{ t('team.holder.confirm') }}</button></div>
   </div>
   <button v-if="!m.pending" class="btn" data-testid="holder-open" :disabled="!m.canChange" @click="m.prepare">{{ t(m.held?'team.unclaim':'team.claim') }}</button>
   <div v-if="m.confirmation" class="confirmation" role="group" :aria-label="t('team.holder.confirm')">
    <p>{{ t(m.confirmation.active?'team.holder.claim_confirm':'team.holder.release_confirm') }}</p>
    <button class="btn" @click="m.confirmation=null">{{ t('common.cancel') }}</button><button class="btn primary" data-testid="holder-confirm" :disabled="!m.canChange" @click="m.confirm">{{ t('team.holder.confirm') }}</button>
   </div>
   <button class="text-btn" :disabled="m.busy||m.loading||!m.online" @click="m.load">{{ t('team.holder.reload') }}</button>
  </template>
 </section>
</template>
<script setup lang="ts">
import {reactive} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {useTeamTaskHolder} from '../../composables/useTeamTaskHolder'
const props=defineProps<{taskId:string;teamId:string;currentUserId:number;writesEnabled:boolean}>()
const emit=defineEmits<{changed:[];revoked:[]}>(),{t}=useLocale()
const m=reactive(useTeamTaskHolder(props,()=>emit('changed'),()=>emit('revoked')))
</script>
<style scoped>
.holder-panel{border-top:1px solid var(--border);padding-top:12px;margin:12px 0;font-size:13px}.muted{color:var(--fg-secondary)}.confirmation{padding:12px;margin:8px 0;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.holder-panel button{margin:4px 8px 4px 0}
</style>
