<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemorySkillDocument } from '../../types/memorySkills'

const props = defineProps<{ document: MemorySkillDocument; busy: boolean }>()
const emit = defineEmits<{ save: [document: MemorySkillDocument]; cancel: [] }>()
const { t } = useLocale()
const draft = ref<MemorySkillDocument>(JSON.parse(JSON.stringify(props.document)))
watch(() => props.document, value => { draft.value = JSON.parse(JSON.stringify(value)) })
const listFields = ['preconditions', 'validation', 'failure_handling', 'rollback'] as const
const operations: MemorySkillDocument['steps'][number]['operation'][] = [
  'read', 'local_write', 'unknown', 'deployment', 'deletion', 'production_write', 'permission_change', 'data_migration',
]
function setLines(field: typeof listFields[number], event: Event) {
  draft.value[field] = (event.target as HTMLTextAreaElement).value.split('\n').filter(line => line.trim())
}
function save() { emit('save', JSON.parse(JSON.stringify(draft.value))) }
</script>

<template>
  <form class="memory-skill-editor" data-testid="skill-editor" @submit.prevent="save">
    <p class="memory-skill-muted">{{ t('memory.skills.immutable_edit') }}</p>
    <label>{{ t('memory.skills.title') }}<input v-model="draft.title" required maxlength="200" data-testid="skill-edit-title" /></label>
    <label>{{ t('memory.skills.trigger') }}<textarea v-model="draft.trigger" required maxlength="2000" rows="2" /></label>
    <label v-for="field in listFields" :key="field">
      {{ t(`memory.skills.${field}`) }}
      <textarea :value="draft[field].join('\n')" required rows="3" @change="setLines(field, $event)" />
    </label>
    <fieldset v-for="(step, index) in draft.steps" :key="index">
      <legend>{{ t('memory.skills.step') }} {{ index + 1 }}</legend>
      <label>{{ t('memory.skills.instruction') }}<textarea v-model="step.instruction" required maxlength="4000" rows="3" /></label>
      <div class="memory-skill-fields">
        <label>{{ t('memory.skills.tool') }}<input v-model="step.tool" required maxlength="128" /></label>
        <label>{{ t('memory.skills.operation') }}<select v-model="step.operation"><option v-for="operation in operations" :key="operation">{{ operation }}</option></select></label>
      </div>
      <label>{{ t('memory.skills.permissions') }}<input :value="step.permissions.join(', ')" required
        @change="step.permissions = ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean)" /></label>
      <button v-if="draft.steps.length > 1" class="memory-button" type="button" @click="draft.steps.splice(index, 1)">{{ t('memory.skills.remove_step') }}</button>
    </fieldset>
    <button v-if="draft.steps.length < 32" class="memory-button" type="button"
      @click="draft.steps.push({ instruction: '', tool: '', permissions: [], operation: 'unknown' })">{{ t('memory.skills.add_step') }}</button>
    <p class="memory-skill-muted">{{ t('memory.skills.sources_preserved') }} <code>{{ draft.source_tokens.join(', ') }}</code></p>
    <footer class="memory-skill-actions">
      <button type="submit" class="memory-button is-primary" :disabled="busy" data-testid="skill-edit-save">{{ t('memory.skills.save_version') }}</button>
      <button type="button" class="memory-button" :disabled="busy" @click="emit('cancel')">{{ t('memory.skills.cancel') }}</button>
    </footer>
  </form>
</template>
