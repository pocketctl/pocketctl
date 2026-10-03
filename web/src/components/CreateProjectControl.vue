<template>
  <button ref="trigger" type="button" class="project-create-trigger" :class="{ labeled }" :title="t('workspace.create_project')" :aria-label="t('workspace.create_project')" @click="open"><template v-if="labeled"><WorkspaceIcon name="folder" />{{ t('workspace.create_project') }}</template><template v-else>＋</template></button>
  <ActionList v-if="visible" :mobile-sheet="labeled" :anchor="trigger" :title="t('workspace.create_project')" @close="close">
      <form id="create-project-form" @submit.prevent="submit">
        <p>{{ t('workspace.project_hint') }}</p>
        <label for="project-name-input">{{ t('workspace.project_name') }}</label>
        <input id="project-name-input" ref="nameInput" v-model="name" maxlength="36" autocomplete="off" :disabled="saving" />
        <span v-if="error" class="project-modal-error" role="alert">{{ error }}</span>
      </form>
      <template #footer>
        <button type="button" :disabled="saving" @click="close">{{ t('common.cancel') }}</button>
        <button type="submit" form="create-project-form" class="primary" :disabled="saving || !name.trim()">{{ saving ? t('workspace.creating') : t('workspace.create_project') }}</button>
      </template>
  </ActionList>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import ActionList from './ActionList.vue'
import WorkspaceIcon from './WorkspaceIcon.vue'
defineProps<{ labeled?: boolean }>()
import { useLocale } from '../composables/useLocale'
const { t } = useLocale()
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
    error.value = cause instanceof Error ? cause.message : t('workspace.create_project_failed')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.project-create-trigger { display: grid; width: 28px; height: 28px; place-items: center; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--fg-secondary); font-size: 19px; line-height: 1; cursor: pointer; }
.project-create-trigger.labeled { display: flex; gap: 5px; width: auto; min-height: 44px; font-size: 12px; color: var(--accent); white-space: nowrap; }
.project-create-trigger.labeled svg { width: 12px; height: 12px; }
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
