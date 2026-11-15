<script setup lang="ts">
import ActionSelect from '../ActionSelect.vue'
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemorySkillDocument } from '../../types/memorySkills'

const props = defineProps<{ document: MemorySkillDocument; busy: boolean }>()
const emit = defineEmits<{ save: [document: MemorySkillDocument]; cancel: []; dirty: [value: boolean] }>()
const { t } = useLocale()
const listFields = ['preconditions', 'validation', 'failure_handling', 'rollback'] as const
const draft = ref<MemorySkillDocument>(JSON.parse(JSON.stringify(props.document)))
const textFields = ref({ preconditions: '', validation: '', failure_handling: '', rollback: '' })
const permissionFields = ref<string[]>([])
function reset(document: MemorySkillDocument) {
  draft.value = JSON.parse(JSON.stringify(document))
  for (const field of listFields) textFields.value[field] = document[field].join('\n')
  permissionFields.value = document.steps.map(step => step.permissions.join(', '))
}
watch(() => props.document, reset, { immediate: true })
const isDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.document)
  || listFields.some(field => textFields.value[field] !== props.document[field].join('\n'))
  || permissionFields.value.some((value, index) => value !== props.document.steps[index]?.permissions.join(', ')))
watch(isDirty, value => emit('dirty', value), { flush: 'sync' })
const operations: MemorySkillDocument['steps'][number]['operation'][] = [
  'read', 'local_write', 'unknown', 'deployment', 'deletion', 'production_write', 'permission_change', 'data_migration',
]
function addStep() {
  if (draft.value.steps.length >= 32) return
  draft.value.steps.push({ instruction: '', tool: '', permissions: [], operation: 'unknown' })
  permissionFields.value.push('')
}
function removeStep(index: number) {
  if (draft.value.steps.length <= 1) return
  draft.value.steps.splice(index, 1); permissionFields.value.splice(index, 1)
}
function save() {
  const document: MemorySkillDocument = JSON.parse(JSON.stringify(draft.value))
  for (const field of listFields) document[field] = textFields.value[field].split('\n').filter(line => line.trim())
  document.steps.forEach((step, index) => { step.permissions = (permissionFields.value[index] ?? '').split(',').map(value => value.trim()).filter(Boolean) })
  emit('save', document)
}
</script>

<template>
  <form class="memory-skill-editor" data-testid="skill-editor" @submit.prevent="save">
    <p class="memory-skill-muted">{{ t('memory.skills.immutable_edit') }}</p>
    <p class="memory-skill-muted">{{ t('memory.assistance.productGate') }} · {{ t('memory.assistance.toolApproval') }}</p>
    <label>{{ t('memory.skills.title') }}<input v-model="draft.title" required maxlength="200" data-testid="skill-edit-title" /></label>
    <label>{{ t('memory.skills.trigger') }}<textarea v-model="draft.trigger" required maxlength="2000" rows="2" /></label>
    <label v-for="field in listFields" :key="field">
      {{ t(`memory.skills.${field}`) }}
      <textarea v-model="textFields[field]" required rows="3" />
    </label>
    <fieldset v-for="(step, index) in draft.steps" :key="index">
      <legend>{{ t('memory.skills.step') }} {{ index + 1 }}</legend>
      <label>{{ t('memory.skills.instruction') }}<textarea v-model="step.instruction" required maxlength="4000" rows="3" /></label>
      <div class="memory-skill-fields">
        <label>{{ t('memory.skills.tool') }}<input v-model="step.tool" required maxlength="128" /></label>
        <label>{{ t('memory.skills.operation') }}<ActionSelect><select v-model="step.operation"><option v-for="operation in operations" :key="operation">{{ operation }}</option></select></ActionSelect></label>
      </div>
      <label>{{ t('memory.skills.permissions') }}<input v-model="permissionFields[index]" required /></label>
      <button v-if="draft.steps.length > 1" class="memory-button" type="button" @click="removeStep(index)">{{ t('memory.skills.remove_step') }}</button>
    </fieldset>
    <button v-if="draft.steps.length < 32" class="memory-button" type="button"
      @click="addStep">{{ t('memory.skills.add_step') }}</button>
    <p class="memory-skill-muted">{{ t('memory.skills.sources_preserved') }} <code>{{ draft.source_tokens.join(', ') }}</code></p>
    <footer class="memory-skill-actions">
      <button type="submit" class="memory-button is-primary" :disabled="busy" data-testid="skill-edit-save">{{ t('memory.skills.save_version') }}</button>
      <button type="button" class="memory-button" :disabled="busy" @click="emit('cancel')">{{ t('memory.skills.cancel') }}</button>
    </footer>
  </form>
</template>
