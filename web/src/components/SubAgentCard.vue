<template>
  <div class="subagent-card" :class="{ expanded }">
    <div class="subagent-header" @click="expanded = !expanded">
      <span class="subagent-chevron">{{ expanded ? '▾' : '▸' }}</span>
      <span class="subagent-icon">🤖</span>
      <span class="subagent-type-badge">{{ agentType }}</span>
      <span class="subagent-desc">{{ truncatedDesc }}</span>
      <span class="subagent-status" :class="statusClass">{{ statusLabel }}</span>
      <span class="subagent-count">{{ messages.length }}</span>
    </div>
    <div v-if="expanded" class="subagent-body">
      <div v-if="messages.length === 0" class="subagent-empty">No content</div>
      <template v-for="msg in messages" :key="msg.id">
        <div v-if="msg.type === 'agent_text'" class="sa-msg sa-agent">
          <span>{{ msg.content }}</span>
          <span v-if="msg.streaming" class="cursor">|</span>
        </div>
        <div v-else-if="msg.type === 'tool_call'" class="sa-msg sa-tool" :class="{ open: msg.expanded }">
          <div class="sa-tool-header" @click="msg.expanded = !msg.expanded">
            <span class="sa-chevron">{{ msg.expanded ? '▾' : '▸' }}</span>
            <span class="sa-tool-icon">{{ toolIcon(msg.tool) }}</span>
            <span class="sa-tool-name">{{ msg.tool }}</span>
            <span class="sa-tool-args">{{ toolSummary(msg.tool, msg.input) }}</span>
            <span v-if="!msg.output" class="sa-spinner">⏳</span>
            <span v-else class="sa-check">✓</span>
          </div>
          <div v-if="msg.expanded" class="sa-tool-body">
            <div class="sa-tool-section" v-if="msg.input">
              <div class="sa-tool-section-label">Input</div>
              <pre class="sa-tool-input">{{ formatToolInput(msg.tool, msg.input) }}</pre>
            </div>
            <div class="sa-tool-section" v-if="msg.output">
              <div class="sa-tool-section-label">Output</div>
              <pre class="sa-tool-output" :class="{ collapsed: !msg.outputExpanded && isLong(msg.output) }">{{ msg.output }}</pre>
              <button v-if="isLong(msg.output)" class="sa-tool-toggle" @click="msg.outputExpanded = !msg.outputExpanded">
                {{ msg.outputExpanded ? '收起' : '展开全部' }}
              </button>
            </div>
            <div v-else class="sa-tool-pending">Running...</div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

interface SubAgentMessage {
  id: number
  type: string
  role?: string
  content?: string
  streaming?: boolean
  tool?: string
  input?: any
  output?: string
  call_id?: string
  expanded?: boolean
  outputExpanded?: boolean
}

const props = defineProps<{
  agentId: string
  description: string
  agentType: string
  messages: SubAgentMessage[]
  status: string
}>()

const expanded = ref(false)

const truncatedDesc = computed(() => {
  const d = props.description || 'Sub-agent'
  return d.length > 60 ? d.slice(0, 57) + '…' : d
})

const statusLabel = computed(() => {
  const labels: Record<string, string> = {
    running: 'Running',
    completed: 'Done',
    error: 'Error',
  }
  return labels[props.status] || props.status || 'Done'
})

const statusClass = computed(() => {
  if (props.status === 'running') return 'running'
  if (props.status === 'error') return 'error'
  return 'done'
})

function toolIcon(tool?: string): string {
  const icons: Record<string, string> = {
    'Read': '📖', 'Write': '✏️', 'Edit': '✏️', 'Bash': '⚡', 'Glob': '🔍',
    'Grep': '🔍', 'WebSearch': '🌐', 'WebFetch': '🌐', 'Agent': '🤖',
  }
  return icons[tool || ''] || '🔧'
}

function toolSummary(tool: string | undefined, input: any): string {
  if (!input) return ''
  if (tool === 'Bash') {
    const cmd = input.command || input.description || ''
    return cmd.length > 50 ? cmd.slice(0, 47) + '…' : cmd
  }
  if (tool === 'Read' || tool === 'Write' || tool === 'Edit') {
    const path = input.file_path || input.path || ''
    return path.length > 50 ? '…' + path.slice(-47) : path
  }
  const s = JSON.stringify(input)
  return s.length > 50 ? s.slice(0, 47) + '…' : s
}

function formatToolInput(tool: string | undefined, input: any): string {
  if (!input) return ''
  if (tool === 'Bash') {
    return `$ ${input.command || ''}`
  }
  return JSON.stringify(input, null, 2)
}

function isLong(output: string): boolean {
  if (!output) return false
  return output.split('\n').length > 10 || output.length > 1000
}
</script>

<style scoped>
.subagent-card {
  border-left: 3px solid #7c3aed;
  border-radius: 8px;
  background: #161b22;
  overflow: hidden;
}

.subagent-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  cursor: pointer;
  user-select: none;
  font-size: 13px;
}
.subagent-header:hover {
  background: #1c2129;
}

.subagent-chevron {
  color: #484f58;
  font-size: 11px;
  width: 12px;
  flex-shrink: 0;
}

.subagent-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.subagent-type-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: #2d1a3e;
  color: #c084fc;
  flex-shrink: 0;
  text-transform: capitalize;
}

.subagent-desc {
  color: #e6edf3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-size: 13px;
}

.subagent-status {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}
.subagent-status.running { background: #1f6feb; color: white; }
.subagent-status.done { background: #238636; color: white; }
.subagent-status.error { background: #da3633; color: white; }

.subagent-count {
  font-size: 11px;
  color: #484f58;
  flex-shrink: 0;
}

.subagent-body {
  border-top: 1px solid #21262d;
  padding: 12px 14px;
  max-height: 400px;
  overflow-y: auto;
}

.subagent-empty {
  color: #484f58;
  font-style: italic;
  font-size: 12px;
}

/* Sub-agent message styles — reuse parent patterns */
.sa-msg {
  margin-bottom: 8px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.sa-msg:last-child { margin-bottom: 0; }

.sa-agent {
  background: #21262d;
  color: #e6edf3;
  padding: 8px 12px;
  border-radius: 8px;
  border-bottom-left-radius: 4px;
}

.sa-tool {
  background: #0d1117;
  border: 1px solid #1c2533;
  border-radius: 8px;
  padding: 0;
  overflow: hidden;
}

.sa-tool-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  cursor: pointer;
  font-family: monospace;
  font-size: 12px;
  user-select: none;
}
.sa-tool-header:hover { background: #161b22; }

.sa-chevron { color: #484f58; font-size: 10px; width: 10px; }
.sa-tool-icon { font-size: 12px; }
.sa-tool-name { color: #58a6ff; font-weight: 600; }
.sa-tool-args { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.sa-spinner { font-size: 11px; animation: spin 1s linear infinite; }
.sa-check { color: #3fb950; font-size: 12px; }

.sa-tool-body { padding: 0 10px 10px; }
.sa-tool-section { margin-bottom: 6px; }
.sa-tool-section:last-child { margin-bottom: 0; }
.sa-tool-section-label { font-size: 10px; color: #484f58; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; font-weight: 600; }
.sa-tool-input, .sa-tool-output {
  margin: 0; padding: 6px 8px; background: #0d1117; border-radius: 4px;
  font-size: 11px; overflow-x: auto; border: 1px solid #1c2533;
}
.sa-tool-input { color: #79c0ff; }
.sa-tool-output { color: #e6edf3; white-space: pre-wrap; word-break: break-all; }
.sa-tool-output.collapsed { max-height: 120px; overflow: hidden; }
.sa-tool-pending { color: #8b949e; font-style: italic; padding: 4px 0; font-size: 12px; }
.sa-tool-toggle {
  background: none; border: 1px solid #30363d; color: #58a6ff;
  padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; margin-top: 3px;
}
.sa-tool-toggle:hover { background: #21262d; }

.cursor { animation: blink 0.7s infinite; color: #58a6ff; }

@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Mobile */
@media (max-width: 768px) {
  .subagent-header { padding: 8px 10px; font-size: 12px; }
  .subagent-body { padding: 10px; max-height: 300px; }
  .sa-msg { font-size: 12px; }
  .sa-tool-header { font-size: 11px; }
  .subagent-type-badge { display: none; }
}
</style>
