<template>
  <section class="mcp-card">
    <header>
      <span class="badge">MCP</span>
      <strong>{{ message.mcpServer || 'MCP Server' }}</strong>
      <span v-if="isPending" class="waiting">{{ message.submitting ? 'Submitting…' : 'Waiting for input' }}</span>
    </header>
    <p v-if="message.message" class="prompt">{{ message.message }}</p>

    <a v-if="message.elicitationMode === 'url' && message.url" :href="message.url" target="_blank" rel="noopener noreferrer" class="url">
      {{ message.url }}
    </a>

    <div v-if="message.elicitationMode === 'form' && isPending" class="form">
      <label v-for="field in fields" :key="field.name" class="field">
        <span>{{ field.schema.title || field.name }}<i v-if="field.required"> *</i></span>
        <small v-if="field.schema.description">{{ field.schema.description }}</small>

        <select v-if="singleOptions(field.schema).length" v-model="values[field.name]" :data-field="field.name" :disabled="controlsDisabled">
          <option value="" disabled>Select…</option>
          <option v-for="option in singleOptions(field.schema)" :key="option.value" :value="option.value">{{ option.title }}</option>
        </select>
        <div v-else-if="field.schema.type === 'array'" class="options">
          <label v-for="option in arrayOptions(field.schema)" :key="option.value">
            <input type="checkbox" :data-field="field.name" :data-option="option.value" :checked="arrayValue(field.name).includes(option.value)" :disabled="controlsDisabled" @change="toggleArray(field.name, option.value)">
            {{ option.title }}
          </label>
        </div>
        <label v-else-if="field.schema.type === 'boolean'" class="boolean">
          <input v-model="values[field.name]" type="checkbox" :data-field="field.name" :disabled="controlsDisabled">
          Enabled
        </label>
        <input
          v-else-if="field.schema.type === 'number' || field.schema.type === 'integer'"
          v-model="values[field.name]" type="number" :step="field.schema.type === 'integer' ? 1 : 'any'"
          :min="field.schema.minimum" :max="field.schema.maximum" :data-field="field.name" :disabled="controlsDisabled"
        >
        <input
          v-else v-model="values[field.name]" :type="inputType(field.schema)" :minlength="field.schema.minLength"
          :maxlength="field.schema.maxLength" :data-field="field.name" :disabled="controlsDisabled"
        >
      </label>
      <p v-if="validationError" class="error">{{ validationError }}</p>
    </div>

    <p v-if="message.error" class="error">{{ message.error }}</p>
    <footer v-if="isPending">
      <button v-if="message.elicitationMode === 'form'" class="submit" :disabled="controlsDisabled" @click="submit">Submit</button>
      <button v-else class="submit" :disabled="controlsDisabled" @click="respond('accept')">Continue</button>
      <button class="decline" :disabled="controlsDisabled" @click="respond('decline')">Decline</button>
      <button class="cancel" :disabled="controlsDisabled" @click="respond('cancel')">Cancel</button>
    </footer>
    <p v-else class="resolved">{{ resolvedLabel }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'

type Action = 'accept' | 'decline' | 'cancel'
type Option = { value: string; title: string }
const props = defineProps<{ message: any; disabled?: boolean }>()
const emit = defineEmits<{ (event: 'respond', message: any, action: Action, content?: Record<string, unknown>): void }>()
const schema = computed(() => props.message.elicitationSchema || { properties: {} })
const fields = computed(() => Object.entries(schema.value.properties || {}).map(([name, value]) => ({
  name, schema: value as any, required: (schema.value.required || []).includes(name),
})))
const values = reactive<Record<string, any>>({})
for (const field of fields.value) {
  const fallback = field.schema.type === 'array' ? [] : field.schema.type === 'boolean' ? false : ''
  values[field.name] = field.schema.default ?? fallback
}
const validationError = computed(() => validate())
const isPending = computed(() => props.message.status === 'pending')
const controlsDisabled = computed(() => !!props.disabled || !!props.message.submitting)
const resolvedLabel = computed(() => props.message.reason === 'resolved_elsewhere'
  ? 'Handled on another device'
  : props.message.action === 'accept' ? 'Submitted (values hidden)' : props.message.action === 'cancel' ? 'Canceled' : 'Declined')

function optionList(raw: any[], names: string[] = []): Option[] {
  return (raw || []).map((item, index) => typeof item === 'string'
    ? { value: item, title: names[index] || item }
    : { value: item.const, title: item.title || item.const })
}
function singleOptions(field: any): Option[] { return optionList(field.oneOf || field.enum, field.enumNames) }
function arrayOptions(field: any): Option[] { return optionList(field.items?.anyOf || field.items?.enum) }
function arrayValue(name: string): string[] { return Array.isArray(values[name]) ? values[name] : [] }
function toggleArray(name: string, option: string) {
  const current = arrayValue(name)
  values[name] = current.includes(option) ? current.filter(value => value !== option) : [...current, option]
}
function inputType(field: any): string {
  if (field.format === 'email') return 'email'
  if (field.format === 'date') return 'date'
  if (field.format === 'date-time') return 'datetime-local'
  if (field.format === 'uri') return 'url'
  return 'text'
}
function normalized(field: any): unknown {
  const value = values[field.name]
  if ((field.schema.type === 'integer' || field.schema.type === 'number') && value === '') return undefined
  if (field.schema.type === 'integer' || field.schema.type === 'number') return Number(value)
  if (field.schema.format === 'date-time' && value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString()
  }
  return value
}
function validate(): string {
  for (const field of fields.value) {
    const value = normalized(field)
    if (field.required && (value === '' || value == null || Array.isArray(value) && value.length === 0)) return `${field.schema.title || field.name} is required`
    if (typeof value === 'string' && field.schema.minLength != null && [...value].length < field.schema.minLength) return `${field.schema.title || field.name} is too short`
    if (typeof value === 'string' && field.schema.maxLength != null && [...value].length > field.schema.maxLength) return `${field.schema.title || field.name} is too long`
    if (Array.isArray(value) && field.schema.minItems != null && value.length < field.schema.minItems) return `Select more values for ${field.schema.title || field.name}`
    if (Array.isArray(value) && field.schema.maxItems != null && value.length > field.schema.maxItems) return `Select fewer values for ${field.schema.title || field.name}`
    if ((field.schema.type === 'integer' || field.schema.type === 'number') && value != null) {
      if (!Number.isFinite(value) || field.schema.type === 'integer' && !Number.isInteger(value)) return `${field.schema.title || field.name} must be numeric`
      if (field.schema.minimum != null && value < field.schema.minimum || field.schema.maximum != null && value > field.schema.maximum) return `${field.schema.title || field.name} is out of range`
    }
  }
  return ''
}
function submit() {
  if (controlsDisabled.value || validationError.value) return
  const content: Record<string, unknown> = {}
  for (const field of fields.value) {
    const value = normalized(field)
    if (value !== undefined) content[field.name] = value
  }
  emit('respond', props.message, 'accept', content)
}
function respond(action: Action) {
  if (!controlsDisabled.value) emit('respond', props.message, action, undefined)
}
</script>

<style scoped>
.mcp-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius-lg); background: var(--surface); }
header, footer { display: flex; align-items: center; gap: 8px; }
.badge { color: var(--accent); font-size: 11px; font-weight: 700; }
.waiting { margin-left: auto; color: var(--fg-tertiary); font-size: 12px; }
.prompt, .resolved, .error { margin: 0; }
.url { overflow-wrap: anywhere; }
.form, .field { display: flex; flex-direction: column; gap: 6px; }
.field > span { font-size: 13px; font-weight: 600; }
.field i, .error { color: var(--error); font-style: normal; }
.field small { color: var(--fg-tertiary); }
input, select { padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); color: var(--fg); }
.options { display: flex; flex-wrap: wrap; gap: 10px; }
.boolean { display: flex; align-items: center; gap: 6px; }
button { padding: 7px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.submit { background: var(--accent); color: white; }
</style>
