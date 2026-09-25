<template>
  <aside class="context-panel" data-testid="team-context-panel">
    <header><div><span>共享 Context</span><strong>{{ context ? `v${context.version}` : '未建立' }}</strong></div><button type="button" aria-label="关闭 Context" @click="$emit('close')">×</button></header>
    <div v-if="context" class="context-body">
      <section><small>目标</small><p>{{ context.goal }}</p></section>
      <section><small>共识</small><ul v-if="context.consensus.length"><li v-for="item in context.consensus" :key="item">{{ item }}</li></ul><p v-else>暂无</p></section>
      <section><small>开放问题</small><ul v-if="context.open_questions.length"><li v-for="item in context.open_questions" :key="item">{{ item }}</li></ul><p v-else>暂无</p></section>
      <section><small>引用</small><p>{{ context.references.length }} 个共享事件引用</p></section>
    </div>
    <div v-else class="context-empty">此会话还没有 Context 快照。消息仍会按当前事件历史发送给 Agent。</div>
  </aside>
</template>

<script setup lang="ts">
import type { TeamContextSnapshot } from '../../types/team'
defineProps<{ context: TeamContextSnapshot | null }>()
defineEmits<{ close: [] }>()
</script>

<style scoped>
.context-panel { width: 300px; min-width: 260px; border-left: 1px solid var(--border); color: var(--fg); background: var(--surface); overflow-y: auto; }.context-panel header { min-height: 62px; display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); }.context-panel header div { display: grid; gap: 3px; }.context-panel header span { color: var(--fg-secondary); font-size: 10px; }.context-panel header strong { font-size: 12px; }.context-panel header button { border: 0; color: var(--fg-secondary); background: none; font-size: 22px; cursor: pointer; }.context-body { padding: 16px; }.context-body section { margin-bottom: 22px; }.context-body small { color: var(--accent); font: 650 9px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }.context-body p,.context-body li { color: var(--fg-secondary); font-size: 11px; line-height: 1.65; }.context-body ul { padding-left: 17px; }.context-empty { padding: 22px 16px; color: var(--fg-tertiary); font-size: 11px; line-height: 1.7; }
@media (max-width: 900px) { .context-panel { position: absolute; inset: 62px 0 0 auto; z-index: 80; width: min(330px, 88vw); box-shadow: -12px 0 30px rgba(0,0,0,.18); } }
</style>
