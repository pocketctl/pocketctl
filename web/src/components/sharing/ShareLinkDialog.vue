<template>
  <Teleport to="body"><dialog ref="dialog" class="design-shell share-dialog" :aria-label="t('sharing.share')" @close="emit('close')" @click="outside"><div class="design-surface share-dialog-content"><button class="share-dialog-close" :aria-label="t('common.close')" @click="dialog?.close()">×</button><ShareLinkManager :session-id="sessionId" :title="title" @manage="emit('manage')" /></div></dialog></Teleport>
</template>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import ShareLinkManager from './ShareLinkManager.vue'
import { useLocale } from '../../composables/useLocale'
defineProps<{sessionId:string;title?:string}>()
const emit=defineEmits<{close:[];manage:[]}>()
const {t}=useLocale(),dialog=ref<HTMLDialogElement>()
let opener:HTMLElement|null=null
function outside(event:MouseEvent){if(event.target!==dialog.value)return;const rect=dialog.value.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.value.close()}
onMounted(()=>{opener=document.activeElement as HTMLElement;dialog.value?.showModal()})
onBeforeUnmount(()=>{dialog.value?.close();opener?.focus()})
</script>
<style scoped>
.share-dialog{position:fixed;margin:auto;padding:0;width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 48px);border:1px solid var(--line);border-radius:14px;background:var(--panel);box-shadow:var(--modal-shadow);overflow:auto;color:var(--ink)}.share-dialog::backdrop{background:#101d3f65}.share-dialog .share-dialog-content{padding:0;max-width:none}.share-dialog-close{z-index:2;position:absolute;right:14px;top:14px;width:32px;height:32px;border:0;background:var(--soft);color:var(--muted);border-radius:8px;font-size:22px;cursor:pointer}.share-dialog.design-shell .share-dialog-content.design-surface :deep(.card-head){padding-right:64px}.share-dialog :deep(.card-head h3){font-size:14px}.share-dialog :deep(.share-session){border:0;display:flex;flex-direction:column;max-height:calc(100dvh - 48px)}.share-dialog :deep(.card-head){flex-shrink:0}.share-dialog :deep(.card-body){overflow:auto;min-height:0}.share-dialog :deep(.btn:disabled){opacity:.45;cursor:default}@media(max-width:600px){.share-dialog{width:100%;max-height:90dvh;margin:auto 0 0;border-radius:18px 18px 0 0}.share-dialog-close{top:10px}.share-dialog :deep(.share-session){max-height:90dvh}}
</style>
