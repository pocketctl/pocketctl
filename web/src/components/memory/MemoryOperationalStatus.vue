<template>
  <div class="memory-operational-status memory-notice" :class="{ 'is-error': attention }"
    :role="attention ? 'alert' : 'status'" data-testid="memory-operational-status">
    <strong>{{ t(`memory.operational.${state}`) }}</strong>
    <span v-if="reason">{{ t(`memory.operational.${reason}`) }}</span>
    <button v-if="state === 'unknown' || attention" type="button" class="memory-button" :disabled="busy" @click="refresh">
      {{ t('memory.operational.refresh') }}
    </button>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { readMemoryOperationalStatus, type MemoryOperationalSnapshot } from '../../services/memoryOperationalStatus'
const props=defineProps<{installationId:string}>()
const {t}=useLocale()
const snapshot=ref<MemoryOperationalSnapshot|null>(null)
const busy=ref(false)
const loaded=ref(false)
let generation=0
let timer:ReturnType<typeof setInterval>|undefined
const state=computed(()=>snapshot.value?.state??(loaded.value?'unknown':'loading'))
const attention=computed(()=>['degraded','error','offline'].includes(state.value))
const reasons=['feed_stalled','budget_blocked','extraction_stalled','evidence_gap','feed_integrity']
const reason=computed(()=>attention.value&&reasons.includes(snapshot.value?.last_error_code??'')?snapshot.value!.last_error_code:null)
async function refresh(){
  if(busy.value)return
  const turn=++generation
  busy.value=true
  snapshot.value=null
  loaded.value=false
  try{const result=await readMemoryOperationalStatus(props.installationId);if(turn===generation)snapshot.value=result}
  catch{if(turn===generation)snapshot.value=null}
  finally{if(turn===generation){loaded.value=true;busy.value=false}}
}
watch(()=>props.installationId,()=>{generation++;busy.value=false;loaded.value=false;snapshot.value=null;void refresh()})
onMounted(()=>{void refresh();timer=setInterval(()=>void refresh(),60000)})
onUnmounted(()=>{generation++;if(timer)clearInterval(timer)})
</script>
<style scoped>
.memory-operational-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
.memory-operational-status span{flex:1;min-width:180px;overflow-wrap:anywhere}
.memory-operational-status strong{font-weight:600}
</style>
