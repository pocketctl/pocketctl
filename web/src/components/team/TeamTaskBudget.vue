<template>
 <section class="delivery-section" aria-label="执行预算">
  <template v-if="budget">
   <dl><dt>调用次数</dt><dd>{{ budget.invocation_count }} / {{ budget.invocation_limit }}</dd>
    <dt>在途调用</dt><dd>{{ budget.in_flight }} / {{ budget.policy.max_concurrent_calls ?? '未设置并发限制' }}</dd>
    <dt>时长上限</dt><dd>{{ budget.policy.max_duration_seconds ? `${budget.policy.max_duration_seconds} 秒` : '未设置' }}{{ budget.duration_exhausted?' · 已达到':'' }}</dd>
    <dt>开始计时</dt><dd>{{ budget.started_at?new Date(budget.started_at).toLocaleString():'未知' }}</dd>
    <dt>Token 用量</dt><dd>{{ budget.usage.observed_tokens ?? '未知' }}{{ budget.usage.coverage==='partial'?' · 部分已归因':'' }}</dd>
    <dt>Token 提醒阈值</dt><dd>{{ budget.policy.token_warning_limit ?? '未设置' }}{{ budget.usage.token_warning_exceeded?' · 已达到':'' }}</dd>
    <dt>子 Agent 用量归属</dt><dd>未知</dd><dt>费用估算</dt><dd>不可用</dd>
   </dl>
   <p>调用次数、并发与时长限制仅控制新步骤预留。已发出的调用继续运行；暂停和恢复不会重置预算。</p>
   <p>Token 仅观察和提醒，包含可明确关联的部分事实，数据可能晚到。缺失数据不代表零用量；不支持 Token 或费用硬上限。</p>
  </template><p v-else>计划尚未激活，没有执行预算。</p>
 </section>
</template>
<script setup lang="ts">
import type { TaskBudget } from '../../types/teamPlan'
defineProps<{budget:TaskBudget|null}>()
</script>
<style scoped>
dl{display:grid;grid-template-columns:minmax(100px,1fr) 2fr;gap:8px;margin:12px 0}dd{margin:0;overflow-wrap:anywhere}dt,p{color:var(--fg-secondary)}
</style>
