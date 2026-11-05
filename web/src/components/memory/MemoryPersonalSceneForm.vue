<template>
 <section class="memory-settings-card" data-testid="memory-personal-scenes">
  <h3>{{ t('memory.personal_scenes') }}</h3><p class="memory-notice">{{ t('memory.personal_scenes_copy') }}</p>
  <ul v-if="scenes.length"><li v-for="scene in scenes" :key="scene.id">{{ scene.name }}</li></ul>
  <label>{{ t('memory.scene_name') }}<input v-model="name" class="field" :disabled="busy" maxlength="200" data-testid="memory-scene-name"/></label>
  <button type="button" class="memory-button" :disabled="busy || !name.trim()" data-testid="memory-scene-create" @click="create">{{ t(busy?'common.loading':'memory.create_personal_scene') }}</button>
  <p v-if="error" class="memory-error" role="alert" data-testid="memory-scene-error">{{ error }}</p>
 </section>
</template>
<script setup lang="ts">
import {onMounted,ref,onBeforeUnmount} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {listMemoryScenes,createMemoryPersonalScene} from '../../services/memoryClient'
import type {MemoryScene} from '../../types/memory'
const props=defineProps<{installationId:string}>(),{t}=useLocale()
const scenes=ref<MemoryScene[]>([]),name=ref(''),busy=ref(false),error=ref('')
let alive=true
onBeforeUnmount(()=>{alive=false})
onMounted(async()=>{try{const result=await listMemoryScenes(props.installationId);if(alive)scenes.value=result.scenes}catch(e){if(alive)error.value=e instanceof Error?e.message:t('memory.scene_load_failed')}})
async function create(){
 if(busy.value||!name.value.trim())return
 busy.value=true;error.value='';const value=name.value.trim()
 try{
  // Stable across reloads: an unknown response must not create the same scene
  // again. The authenticated installation remains the server-side boundary.
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(props.installationId+'\0'+value))
  const key='personal-scene:'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')
  const result=await createMemoryPersonalScene(props.installationId,value,key)
  if(alive){if(!scenes.value.some(s=>s.id===result.space_id))scenes.value.push({id:result.space_id,name:result.name,domain:result.domain,destinations:result.destinations});name.value=''}
 }catch(e){if(alive)error.value=e instanceof Error?e.message:t('memory.scene_create_failed')}
 finally{if(alive)busy.value=false}
}
</script>
