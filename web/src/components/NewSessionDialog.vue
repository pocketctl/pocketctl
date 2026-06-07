<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <h3>New Session</h3>
      <div class="field">
        <label>Agent</label>
        <select v-model="form.agent">
          <option value="claude-code">Claude Code</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>
      <div class="field">
        <label>Working Directory</label>
        <input v-model="form.cwd" placeholder="/path/to/project" />
      </div>
      <div class="field">
        <label>Initial Prompt</label>
        <textarea v-model="form.prompt" rows="3" placeholder="What should the agent do?" />
      </div>
      <div class="actions">
        <button class="btn" @click="$emit('close')">Cancel</button>
        <button class="btn primary" @click="$emit('create', form)" :disabled="!form.prompt.trim()">Create</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
defineEmits<{ close: []; create: [data: { agent: string; cwd: string; prompt: string }] }>()
const form = reactive({ agent: 'claude-code', cwd: localStorage.getItem('pocketctl_default_cwd') || '', prompt: '' })
</script>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.dialog { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; width: 400px; max-width: 90vw; }
.dialog h3 { margin-bottom: 16px; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; }
.field input, .field select, .field textarea { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #e6edf3; font-size: 14px; outline: none; }
.field textarea { resize: vertical; font-family: inherit; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 14px; }
.btn.primary { background: #238636; border-color: #238636; }
.btn.primary:hover { background: #2ea043; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Mobile: fullscreen dialog */
@media (max-width: 768px) {
  .overlay { align-items: flex-end; }
  .dialog { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; padding: 20px 16px; padding-bottom: max(20px, env(safe-area-inset-bottom)); }
  .field input, .field select, .field textarea { font-size: 16px; /* prevent iOS zoom */ min-height: 44px; }
  .btn { min-height: 44px; }
}
</style>
