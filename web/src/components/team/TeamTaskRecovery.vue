<template>
 <section class="delivery-section" aria-label="恢复上下文">
  <h4>恢复上下文</h4><p>只读取已保存的任务资料与诊断，不创建调用，也不探测原生进程。</p>
  <p v-if="loading" role="status">正在读取…</p>
  <template v-else-if="context">
   <p>{{ context.scope==='attempt'?`第 ${context.attempt?.attempt_no} 次尝试`:'任务范围' }} · 规格 v{{ context.spec.revision }}<span v-if="context.attempt"> · Context v{{ context.attempt.context_version }}</span></p>
   <h4>任务目标</h4><p class="copy">{{ context.spec.goal }}</p><h4>验收要求</h4><p class="copy">{{ context.spec.acceptance }}</p>
   <h4>未决事项</h4><p v-for="item in context.diagnostics" :key="item.code">{{ taskDiagnosticLabel(item.code) }}</p><p v-if="!context.diagnostics.length">暂无已记录的诊断；不代表执行已完成。</p>
   <h4>冻结输入</h4><p v-if="!context.inputs.length">{{ context.attempt?'本次尝试没有上游输入。':'选择具体尝试后查看其冻结输入。' }}</p>
   <article v-for="source in context.inputs" :key="source.submission_id"><p>{{ source.step_id }} · 交付 v{{ source.submission_version }} · 规格 v{{ source.spec_revision }}</p>
    <details><summary>来源身份与文件完整性</summary><p class="copy">提交：{{ source.submission_id }}<br>验收：{{ source.decision_id }}</p>
     <p v-for="file in source.artifacts" :key="file.id" class="copy">{{ file.name }} · {{ file.byte_size }} 字节 · {{ file.revoked?'已撤销':'已冻结' }}<br>SHA-256：{{ file.sha256 }}</p></details>
   </article>
   <h4>最近验收意见</h4><p v-if="!context.decisions.length">暂无已保存的验收意见。</p>
   <p v-for="decision in context.decisions" :key="decision.decision_id" class="copy">v{{ decision.version }} · {{ decision.decision==='accepted'?'已验收':'要求修改' }}<br>{{ decision.reason }}</p>
  </template>
 </section>
</template>
<script setup lang="ts">
import { taskDiagnosticLabel, type TaskContext } from '../../types/teamPlan'
defineProps<{context:TaskContext|null;loading:boolean}>()
</script>
<style scoped>
p{color:var(--fg-secondary)}.copy{white-space:pre-wrap;overflow-wrap:anywhere}article{padding:8px 0;border-bottom:1px solid var(--border)}details{font-size:12px}summary{cursor:pointer}
</style>
