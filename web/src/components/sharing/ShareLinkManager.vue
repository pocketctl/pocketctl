<template>
  <section class="card share-manager" :class="{'share-session':sessionId}">
    <header class="card-head"><h3>{{ t(sessionId?'sharing.share':'sharing.manage') }}</h3><button class="btn small" :disabled="busy||loading" @click="load">{{ t('sharing.refresh') }}</button></header>
    <div class="card-body">
      <p v-if="title" class="sub">{{ title }}</p>
      <p class="share-disclosure">{{ t('sharing.disclosure') }}</p>
      <details class="share-details"><summary>{{ t('sharing.details') }}</summary><p>{{ t('sharing.scope') }}</p></details>
      <div v-if="loading" role="status" class="share-empty">{{ t('sharing.loading') }}</div>
      <div v-if="error" role="alert" class="notice amber">{{ t(`sharing.errors.${error}`) }} <button v-if="!pending" class="btn small" :disabled="busy||loading" @click="load">{{ t('sharing.retry') }}</button></div>
      <div v-if="pending" role="status" class="notice amber"><p>{{ t(pending.kind==='create'?'sharing.create_unknown':'sharing.revoke_unknown') }}</p><button class="btn" :disabled="busy" @click="reconcile">{{ t('sharing.reconcile') }}</button></div>
      <p v-if="message" role="status" class="share-feedback">{{ t(`sharing.messages.${message}`) }}</p>
      <template v-if="loaded">
        <template v-if="sessionId">
          <section v-if="selected" class="share-selected"><div class="row between"><strong>{{ t('sharing.selected') }}</strong><span class="badge green">{{ remaining(selected) }}</span></div><strong class="share-expiry">{{ formatTime(selected.expires_at) }}</strong><p>{{ t('sharing.no_renew') }}</p><p class="sub">{{ t('sharing.created_at') }} {{ formatTime(selected.created_at) }}</p><button class="btn primary" :disabled="blocked" @click="copy(selected)">{{ t('sharing.copy') }}</button></section>
          <div v-else class="share-empty"><h3>{{ t('sharing.empty') }}</h3><p>{{ t('sharing.empty_share') }}</p></div>
          <button class="btn" :class="{primary:!selected}" :disabled="blocked" @click="mutate('create')">{{ t(busy?'sharing.working':'sharing.create') }}</button>
          <p class="sub">{{ t('sharing.new_expiry') }}</p>
          <div class="row between share-list-heading"><h3>{{ t('sharing.current') }} · {{ links.length }}</h3><button class="text-btn" @click="emit('manage')">{{ t('sharing.all') }} ›</button></div>
        </template>
        <p v-else class="sub">{{ t('sharing.active') }} {{ links.length }} · {{ t('sharing.generated_only') }}</p>
        <div v-if="!links.length&&!sessionId" class="share-empty">{{ t('sharing.empty') }}</div>
        <section v-for="group in groups" :key="group.rows[0]?.session_id" class="share-group">
          <header v-if="!sessionId"><h3>{{ group.title }}</h3></header>
          <div v-for="link in group.rows" :key="link.id" class="share-row">
            <div class="grow"><strong>{{ t('sharing.link') }} {{ link.id.slice(0,8) }}</strong><span v-if="sessionId&&link.id===selected?.id" class="badge blue">{{ t('sharing.selected') }}</span><p>{{ formatTime(link.created_at) }} → {{ formatTime(link.expires_at) }}</p><span class="share-remaining">{{ remaining(link) }}</span></div>
            <div class="row wrap"><button v-if="sessionId" class="btn small" :disabled="blocked||link.id===selected?.id" @click="selectedId=link.id">{{ t('sharing.use') }}</button><button v-else class="btn small" :disabled="blocked" @click="copy(link)">{{ t('sharing.copy') }}</button><button class="btn small danger" :disabled="blocked" @click="confirm=link">{{ t('sharing.revoke') }}</button></div>
          </div>
        </section>
      </template>
      <dialog v-if="confirm" class="share-confirm" role="alertdialog" aria-modal="true" :aria-label="t('sharing.confirm_title')" tabindex="-1" ref="confirmPanel" @cancel.prevent="!busy && (confirm=null)">
        <h3>{{ t('sharing.confirm_title') }}</h3><p>{{ confirm.title }} · {{ confirm.id.slice(0,8) }} · {{ formatTime(confirm.expires_at) }}</p><p>{{ t('sharing.confirm_copy') }}</p><div class="row"><button class="btn" :disabled="busy" @click="confirm=null">{{ t('sharing.cancel') }}</button><button class="btn danger" :disabled="busy" @click="revokeConfirmed">{{ t('sharing.revoke') }}</button></div>
      </dialog>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { useShareLinks } from '../../composables/useShareLinks'
import { useLocale } from '../../composables/useLocale'
import type { ShareLink } from '../../services/shareLinks'
const props=defineProps<{sessionId?:string;title?:string}>()
const emit=defineEmits<{manage:[]}>()
const {t,locale}=useLocale()
const {links,selected,selectedId,groups,loading,loaded,busy,error,message,pending,now,load,mutate,reconcile,copy}=useShareLinks(toRef(props,'sessionId'))
const confirm=ref<ShareLink|null>(null),confirmPanel=ref<HTMLDialogElement>()
const blocked=computed(()=>busy.value||loading.value||!loaded.value||!!pending.value||!!confirm.value)
const formatTime=(value:string)=>new Date(value).toLocaleTimeString(locale.value,{hour:'2-digit',minute:'2-digit'})
const remaining=(link:ShareLink)=>`${Math.max(0,Math.ceil((Date.parse(link.expires_at)-now.value)/60000))} ${t('sharing.minutes')}`
let confirmOpener:HTMLElement|null=null
watch(confirm,async value=>{if(value){confirmOpener=document.activeElement as HTMLElement;await nextTick();confirmPanel.value?.showModal()}else{confirmPanel.value?.close();await nextTick();if(confirmOpener?.isConnected)confirmOpener.focus()}})
async function revokeConfirmed(){const id=confirm.value?.id;if(!id)return;await mutate('revoke',id);confirm.value=null}
</script>
<style scoped>
.share-manager .card-head h3{font-size:14px;font-weight:600}.share-manager .grow{flex:1;min-width:0}.share-manager button:disabled{opacity:.45;cursor:default}.share-manager h3,.share-manager strong{overflow-wrap:anywhere}.share-manager{color:var(--text-primary,var(--ink));overflow:hidden}.share-disclosure,.share-details{font-size:12px;color:var(--text-secondary,var(--muted));line-height:1.7}.share-details{margin:12px 0}.share-selected{border:1px solid var(--brand,var(--border));border-radius:12px;padding:18px;margin:16px 0}.share-expiry{display:block;font-size:30px;font-variant-numeric:tabular-nums;margin:12px 0}.share-selected p,.share-row p{font-size:12px;color:var(--text-secondary,var(--muted));margin:8px 0}.share-list-heading{margin:22px 0 12px}.share-group{border:1px solid var(--line,var(--border));border-radius:12px;margin:12px 0;overflow:hidden}.share-group>header{padding:14px 16px;border-bottom:1px solid var(--line,var(--border));background:var(--soft)}.share-group h3{font-size:14px}.share-row{display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid var(--line,var(--border))}.share-row:last-child{border-bottom:0}.share-row strong{font-size:13px;margin-right:6px}.share-remaining,.share-feedback{color:var(--green);font-size:12px}.share-empty{text-align:center;padding:28px 16px}.share-confirm{margin:auto;width:min(460px,calc(100vw - 32px));max-height:85dvh;overflow:auto;color:var(--ink);background:var(--panel);border:1px solid var(--red);padding:22px;border-radius:12px}.share-confirm::backdrop{background:#101d3f65}.share-confirm p{font-size:13px;line-height:1.6}.share-session{border:0;box-shadow:none}.share-manager .notice{margin:12px 0}@media(max-width:600px){.share-row{flex-wrap:wrap}.share-row>.row{width:100%;justify-content:flex-end}.share-manager button{min-height:44px}}
</style>
