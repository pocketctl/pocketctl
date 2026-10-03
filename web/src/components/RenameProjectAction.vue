<template>
  <ActionList mobile-sheet :title="t('workspace.rename_project')" @close="!busy && emit('close')">
    <form id="rename-project-form" @submit.prevent="save">
      <label for="rename-project-name">{{ t('workspace.project_name') }}</label>
      <input id="rename-project-name" ref="field" v-model="name" maxlength="36" required :disabled="busy" />
      <p v-if="error" role="status">{{ error }}</p>
    </form>
    <template #footer><button type="button" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</button><button type="submit" form="rename-project-form" class="primary" :disabled="busy || !name.trim() || name.trim() === project.name">{{ t('common.save') }}</button></template>
  </ActionList>
</template>
<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import ActionList from './ActionList.vue'
import { useLocale } from '../composables/useLocale'
import { renameProject, type SessionProject } from '../services/sessionOrganization'
const props = defineProps<{ project: SessionProject }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const { t } = useLocale()
const name = ref(props.project.name), busy = ref(false), error = ref(''), field = ref<HTMLInputElement>()
onMounted(async () => { await nextTick(); field.value?.focus(); field.value?.select() })
async function save() {
  if (busy.value || !name.value.trim() || name.value.trim() === props.project.name) return
  busy.value = true; error.value = ''
  try { await renameProject(props.project.id, name.value.trim(), Number(props.project.revision)); emit('saved'); emit('close') }
  catch (failure) { error.value = failure instanceof Error ? failure.message : t('workspace.rename_failed') }
  finally { busy.value = false }
}
</script>
