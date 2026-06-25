<template>
  <!-- User message: right-aligned bubble. Preserves whitespace/newlines from
       the textarea input. Long messages collapse with a "展开" toggle. -->
  <div class="msg msg-user" :class="{ collapsed: isCollapsed }">
    <div ref="textEl" class="msg-text">{{ content }}</div>
    <button v-if="isCollapsible" class="msg-toggle" @click="toggleExpand">
      {{ expanded ? '收起' : '展开全部' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'

const props = defineProps<{ content: string }>()

const MAX_COLLAPSED_HEIGHT = 150 // px — ~7 lines at 14px/1.6 line-height

const textEl = ref<HTMLElement | null>(null)
const expanded = ref(false)
const isCollapsible = ref(false)

// collapsed state = !expanded (only relevant when isCollapsible is true)
const isCollapsed = ref(false)

onMounted(async () => {
  await nextTick()
  checkHeight()
})

function checkHeight() {
  if (!textEl.value) return
  const fullHeight = textEl.value.scrollHeight
  if (fullHeight > MAX_COLLAPSED_HEIGHT + 20) {
    isCollapsible.value = true
    isCollapsed.value = true
  }
}

function toggleExpand() {
  expanded.value = !expanded.value
  isCollapsed.value = !expanded.value
}

// Watch expanded to sync isCollapsed
watch(expanded, (val) => {
  isCollapsed.value = !val
})
</script>

<style scoped>
.msg {
  width: fit-content;
  max-width: 85%;
  align-self: flex-end;
  word-break: break-word;
  animation: fade-in 0.2s ease;
}
.msg-user {
  background: var(--user-bubble);
  color: #fff;
  padding: 10px 16px;
  border-radius: 16px 16px 4px 16px;
  font-size: 14px;
  line-height: 1.6;
}

/* Preserve whitespace and newlines from textarea input */
.msg-text {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Collapsed state: clamp height */
.msg-user.collapsed .msg-text {
  max-height: 150px;
  overflow: hidden;
  position: relative;
}
.msg-user.collapsed .msg-text::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 32px;
  background: linear-gradient(transparent, var(--user-bubble));
  pointer-events: none;
}

/* Toggle button */
.msg-toggle {
  display: block;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 0 0;
  text-align: right;
  width: 100%;
}
.msg-toggle:hover {
  color: rgba(255, 255, 255, 0.95);
}

@media (max-width: 768px) {
  .msg { max-width: 90%; }
}
</style>
