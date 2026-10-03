<template>
  <ActionList v-if="actions" :title="title" :width="470" @close="emit('close')"><slot /><template v-if="$slots.footer" #footer><slot name="footer" /></template></ActionList>
  <div v-else
    class="team-overlay"
    @mousedown.self="emit('close')"
    @keydown.esc.stop.prevent="emit('close')"
    @keydown.tab="trapFocus"
  >
    <section
      ref="panel"
      :class="['team-overlay-panel', { drawer, large }]"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
    >
      <header>
        <h2>{{ title }}</h2>
        <button type="button" class="icon-btn flat" :aria-label="t('common.close')" @click="emit('close')"><WorkspaceIcon name="close" /></button>
      </header>
      <div class="team-overlay-content"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </section>
  </div>
</template>
<script setup lang="ts">
import ActionList from '../ActionList.vue';
import WorkspaceIcon from '../WorkspaceIcon.vue';
import { useLocale } from '../../composables/useLocale';
import { nextTick, onMounted, onBeforeUnmount, ref } from "vue";
const props = defineProps<{ title: string; drawer?: boolean; large?: boolean; actions?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const {t}=useLocale();
const panel = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
const controls = () =>
  Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
    ) ?? [],
  ).filter(node=>node.tabIndex>=0 && !node.closest('details:not([open])'));
function trapFocus(event: KeyboardEvent) {
  const list = controls(),
    first = list[0],
    last = list.at(-1);
  if (!first) {
    event.preventDefault();
    return;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === panel.value)
  ) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
onMounted(async () => {
  if (props.actions) return;
  opener = document.activeElement as HTMLElement;
  await nextTick();
  panel.value?.focus();
});
onBeforeUnmount(() => {
  opener?.focus();
});
</script>
<style scoped>
.team-overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: flex;
  justify-content: flex-end;
  background: var(--overlay);
  backdrop-filter: blur(2px);
  color: var(--fg);
  font-size: 14px;
  line-height: 1.5;
}
.team-overlay-panel {
  width: 550px;
  max-width: calc(100vw - 32px);
  max-height: 90dvh;
  margin: auto;
  padding: 24px;
  overflow: auto;
  border: 1px solid var(--border-light);
  border-radius: 12px;
  background: var(--bg);
  box-shadow: var(--shadow-lg);
  outline: none;
  box-sizing: border-box;
}
.team-overlay-panel.drawer {
  width: 470px;
  max-width: 100%;
  height: 100dvh;
  max-height: none;
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  border: 0;
  border-left: 1px solid var(--border-light);
  border-radius: 0;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  gap: 16px;
}
header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 550;
}
header button {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  color: var(--fg-secondary);
  cursor: pointer;
  font-size: 20px;
}
.drawer header {
  margin: 0;
  padding: 23px 24px 18px;
  border-bottom: 1px solid var(--border);
}
.drawer .team-overlay-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 22px 24px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
}
.drawer footer {
  margin: 0;
  padding: 18px 24px;
  border-top: 1px solid var(--border);
}
@media (prefers-reduced-motion: no-preference) {
  .drawer {
    animation: team-drawer-enter 0.16s ease-out;
  }
  @keyframes team-drawer-enter {
    from {
      transform: translateX(25px);
      opacity: 0.6;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
}
</style>
