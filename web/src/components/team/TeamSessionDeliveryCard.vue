<template>
 <section class="session-delivery" aria-label="任务交付">
  <div class="delivery-body"><header><WorkspaceIcon name="file" /><span>任务交付{{ item.version ? ` · v${item.version}` : '' }}</span><strong>{{ label }}</strong></header>
   <h3>{{ item.title }}</h3><p>{{ item.summary || '尚无主交付结果。文件准备并发布后才能验收。' }}</p>
   <p v-if="item.decision_reason">修改意见：{{ item.decision_reason }}</p>
   <ul v-if="item.files.length" aria-label="交付文件"><li v-for="file in item.files" :key="file.id">{{ file.name }}{{ item.revoked_artifact_ids.includes(file.id)?' · 已撤销':'' }}</li></ul>
  </div>
  <footer><span>{{ cached?'上次同步的只读内容':historical?'规格已修订，等待符合新规格的交付':item.decision==='accepted'?'本版已验收，任务状态以任务详情为准':item.decision==='changes_requested'?'等待修订后重新提交':item.latest_submission_id?`验收人 ${reviewer} · 等待确认`:'执行与交付保存分别记录' }}</span><button type="button" @click="$emit('open',item.task_id)">查看交付 <span aria-hidden="true">›</span></button></footer>
 </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import WorkspaceIcon from '../WorkspaceIcon.vue'
import type { SessionDeliveryCard } from '../../types/teamDelivery'
const props=defineProps<{item:SessionDeliveryCard;cached:boolean;reviewer:string}>()
defineEmits<{open:[task:string]}>()
const historical=computed(()=>props.item.submission_spec_revision!==null&&props.item.submission_spec_revision!==props.item.spec_revision)
const label=computed(()=>historical.value?'历史规格':props.item.decision==='accepted'?'本版已验收':props.item.decision==='changes_requested'?'需修改':props.item.latest_submission_id?'待验收':props.item.execution_pending?'等待执行结果':'等待交付')
</script>
<style scoped>
.session-delivery{border:1px solid var(--border);border-radius:10px;background:var(--surface);margin:12px 0;color:var(--fg);font-size:12px;overflow:hidden;max-width:680px}.delivery-body{padding:16px}header{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--fg-secondary)}header>span{flex:1}header strong{font-weight:500;color:var(--accent)}header svg{width:16px;height:16px}h3{font-size:14px;margin:12px 0 8px;overflow-wrap:anywhere}p{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg-secondary);line-height:1.7}ul{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:6px}li{padding:4px 8px;background:var(--surface-active);border-radius:5px;overflow-wrap:anywhere;max-width:100%}footer{display:flex;align-items:center;gap:12px;justify-content:space-between;border-top:1px solid var(--border);padding:12px 16px}footer>span{color:var(--fg-secondary);min-width:0}button{flex-shrink:0;background:none;border:0;color:var(--accent);font:inherit;cursor:pointer;padding:8px 0}
@media(max-width:480px){footer{align-items:flex-start;flex-direction:column;gap:4px}}
</style>
