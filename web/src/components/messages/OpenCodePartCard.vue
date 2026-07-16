<template>
  <section class="part-card" :data-part-type="message.type">
    <header>
      <span class="part-icon" aria-hidden="true">{{ icon }}</span>
      <div class="part-heading">
        <strong>{{ title }}</strong>
        <span v-if="subtitle">{{ subtitle }}</span>
      </div>
    </header>

    <template v-if="message.type === 'agent_file'">
      <code v-if="message.url" class="mono-row">{{ message.url }}</code>
      <code v-if="sourceText" class="source-row">{{ sourceText }}</code>
    </template>

    <template v-else-if="message.type === 'agent_patch'">
      <ul v-if="files.length" class="file-list">
        <li v-for="file in files" :key="file"><span>↳</span><code>{{ file }}</code></li>
      </ul>
      <code v-if="message.hash" class="source-row">{{ message.hash }}</code>
    </template>

    <template v-else-if="message.type === 'agent_todo'">
      <div v-if="todos.length" class="todo-list">
        <div v-for="(todo, index) in todos" :key="`${index}:${todo.content}`" class="todo-row">
          <span :class="['todo-state', todo.status]">{{ todoMark(todo.status) }}</span>
          <span class="todo-content">{{ todo.content }}</span>
          <span v-if="todo.priority" :class="['priority', todo.priority]">{{ todo.priority }}</span>
        </div>
      </div>
      <div v-else class="empty">{{ t('session.opencode_todo_empty') }}</div>
    </template>

    <template v-else-if="message.type === 'agent_subtask'">
      <p v-if="message.prompt" class="body-copy">{{ message.prompt }}</p>
      <code v-if="message.command" class="source-row">{{ message.command }}</code>
    </template>

    <template v-else-if="message.type === 'agent_profile'">
      <code v-if="sourceText" class="source-row">{{ sourceText }}</code>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{ message: any }>()
const { t } = useLocale()
const files = computed<string[]>(() => Array.isArray(props.message.files) ? props.message.files : [])
const todos = computed<any[]>(() => Array.isArray(props.message.todos) ? props.message.todos : [])

const icon = computed(() => ({
  agent_file: '▤', agent_patch: '±', agent_todo: '☑', agent_subtask: '⌁', agent_profile: '@',
}[props.message.type as string] || '◇'))

const title = computed(() => {
  switch (props.message.type) {
    case 'agent_file': return props.message.filename || t('session.opencode_file')
    case 'agent_patch': return t('session.opencode_patch', { n: files.value.length })
    case 'agent_todo': return t('session.opencode_todo', { n: todos.value.length })
    case 'agent_subtask': return props.message.description || t('session.opencode_subtask')
    case 'agent_profile': return props.message.profile_name || t('session.opencode_agent')
    default: return ''
  }
})

const subtitle = computed(() => {
  if (props.message.type === 'agent_file') return props.message.mime || ''
  if (props.message.type === 'agent_subtask') return [props.message.agent, props.message.model].filter(Boolean).join(' · ')
  return ''
})

const sourceText = computed(() => {
  const source = props.message.part_source
  if (!source) return ''
  if (typeof source === 'string') return source.slice(0, 1000)
  try { return JSON.stringify(source).slice(0, 1000) } catch { return '' }
})

function todoMark(status: string): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '•'
  if (status === 'cancelled') return '×'
  return '○'
}
</script>

<style scoped>
.part-card { width: min(720px, 100%); padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); color: var(--fg-secondary); font-size: 12px; }
header { display: flex; align-items: center; gap: 9px; min-width: 0; }
.part-icon { display: grid; place-items: center; width: 24px; height: 24px; flex: 0 0 auto; border-radius: 7px; background: var(--accent-muted); color: var(--accent); font-family: var(--font-mono); font-weight: 700; }
.part-heading { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.part-heading strong { color: var(--fg); font-size: 12px; overflow-wrap: anywhere; }
.part-heading span { color: var(--fg-tertiary); font-size: 11px; }
.mono-row, .source-row { display: block; margin-top: 9px; padding: 7px 8px; border-radius: var(--radius-sm); background: var(--bg); color: var(--fg-tertiary); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.file-list { display: grid; gap: 5px; margin: 10px 0 0; padding: 0; list-style: none; }
.file-list li { display: flex; align-items: center; gap: 7px; min-width: 0; }
.file-list li span { color: var(--fg-tertiary); }
.file-list code { overflow-wrap: anywhere; color: var(--fg-secondary); }
.todo-list { display: grid; gap: 7px; margin-top: 10px; }
.todo-row { display: flex; align-items: flex-start; gap: 8px; }
.todo-state { width: 15px; color: var(--fg-tertiary); font-weight: 700; text-align: center; }
.todo-state.in_progress { color: var(--accent); }
.todo-state.completed { color: var(--success); }
.todo-state.cancelled { color: var(--danger); }
.todo-content { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--fg-secondary); }
.priority { padding: 1px 5px; border-radius: 999px; background: var(--surface-hover); color: var(--fg-tertiary); font-size: 10px; }
.priority.high { color: var(--danger); }
.priority.medium { color: var(--warning); }
.body-copy { margin: 9px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.empty { margin-top: 8px; color: var(--fg-tertiary); }
</style>
