<template>
  <!--
    Tool icon as inline SVG (outline / stroke style) — replaces emoji to keep
    visual consistency with the rest of the app (sidebar/topbar use the same
    stroke-icon language). Each tool maps to a 24x24 viewBox glyph drawn with
    currentColor so it inherits the tool-name accent color.
  -->
  <svg
    class="tool-icon-svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-label="tool"
  >
    <component :is="iconPath" />
  </svg>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'

const props = defineProps<{ tool: string }>()

// Each tool → a render function returning the inner SVG paths.
// Icons follow the Lucide/Feather outline aesthetic used elsewhere in the app.
const iconPath = computed(() => {
  switch (props.tool) {
    case 'Read':
      // open book
      return () => [
        h('path', { d: 'M12 7v14' }),
        h('path', { d: 'M3 5a2 2 0 0 1 2-2h6v18H5a2 2 0 0 1-2-2z' }),
        h('path', { d: 'M21 5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z' }),
      ]
    case 'Write':
    case 'Edit':
      // pencil / edit
      return () => [
        h('path', { d: 'M12 20h9' }),
        h('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z' }),
      ]
    case 'Bash':
      // terminal prompt
      return () => [
        h('path', { d: 'M4 17l6-5-6-5' }),
        h('path', { d: 'M12 19h8' }),
      ]
    case 'Glob':
    case 'Grep':
      // search
      return () => [
        h('circle', { cx: '11', cy: '11', r: '7' }),
        h('path', { d: 'M21 21l-4.3-4.3' }),
      ]
    case 'WebSearch':
      // globe
      return () => [
        h('circle', { cx: '12', cy: '12', r: '9' }),
        h('path', { d: 'M3 12h18' }),
        h('path', { d: 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z' }),
      ]
    case 'WebFetch':
      // download from cloud
      return () => [
        h('path', { d: 'M12 3v12' }),
        h('path', { d: 'M7 10l5 5 5-5' }),
        h('path', { d: 'M5 21h14' }),
      ]
    case 'Agent':
    case 'Task':
      // sparkle / agent
      return () => [
        h('path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }),
        h('path', { d: 'M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z' }),
      ]
    default:
      // wrench (generic tool)
      return () => [
        h('path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-2.1z' }),
      ]
  }
})
</script>

<style scoped>
.tool-icon-svg {
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
}
</style>
