<template>
  <button ref="trigger" type="button" class="project-create-trigger" title="创建项目" aria-label="创建项目" @click="open">＋</button>
  <Teleport to="body">
    <div v-if="visible" class="project-modal-backdrop" @click.self="close">
      <form class="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title" @submit.prevent="submit" @keydown.esc.stop.prevent="close">
        <h2 id="project-modal-title">创建项目</h2>
        <p>把同一件工作的会话放在一起。</p>
        <label for="project-name-input">项目名称</label>
        <input id="project-name-input" ref="nameInput" v-model="name" maxlength="36" autocomplete="off" :disabled="saving" />
        <span v-if="error" class="project-modal-error" role="alert">{{ error }}</span>
        <div class="project-modal-actions">
          <button type="button" :disabled="saving" @click="close">取消</button>
          <button type="submit" class="primary" :disabled="saving || !name.trim()">{{ saving ? '创建中…' : '创建项目' }}</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { createProject } from '../services/sessionOrganization'

const emit = defineEmits<{ (event: 'created'): void }>()
const trigger = ref<HTMLButtonElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const name = ref('')
const error = ref('')
const visible = ref(false)
const saving = ref(false)

function open() {
  name.value = ''
  error.value = ''
  visible.value = true
  void nextTick(() => nameInput.value?.focus())
}

function close() {
  if (saving.value) return
  visible.value = false
  error.value = ''
  void nextTick(() => trigger.value?.focus())
}

async function submit() {
  if (saving.value || !name.value.trim()) return
  saving.value = true
  error.value = ''
  try {
    await createProject(name.value.trim())
    saving.value = false
    close()
    emit('created')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创建项目失败'
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.project-create-trigger { display: grid; width: 28px; height: 28px; place-items: center; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--fg-secondary); font-size: 19px; line-height: 1; cursor: pointer; }
.project-create-trigger:hover { background: var(--surface-active); color: var(--accent); }
.project-create-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.project-modal-backdrop { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 18px; background: rgba(0, 0, 0, .65); }
.project-modal { width: min(380px, 100%); padding: 22px; border: 1px solid var(--border-light); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-lg); }
.project-modal h2 { margin: 0 0 7px; color: var(--fg); font-size: 17px; }
.project-modal p { margin: 0 0 20px; color: var(--fg-secondary); font-size: 11px; line-height: 1.6; }
.project-modal label { display: block; margin-bottom: 7px; color: var(--fg-secondary); font-size: 11px; }
.project-modal input { width: 100%; height: 40px; padding: 0 11px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg); color: var(--fg); }
.project-modal-error { display: block; margin-top: 8px; color: var(--danger, #f85149); font-size: 11px; }
.project-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.project-modal-actions button { padding: 9px 14px; border: 1px solid var(--border-light); border-radius: 8px; background: transparent; color: var(--fg); cursor: pointer; }
.project-modal-actions .primary { border-color: var(--primary-btn); background: var(--primary-btn); color: #fff; }
.project-modal-actions button:disabled { opacity: .5; cursor: not-allowed; }
</style>
