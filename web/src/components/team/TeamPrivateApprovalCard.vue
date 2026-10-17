<template><section class="private-approval" :aria-label="'仅你可见的审批'">
 <small>仅你可见 · {{ item.provider }} 所有者审批</small><strong>{{ item.title }}</strong>
 <pre>{{ command }}</pre><p>{{ stateLabel }}</p>
 <div v-if="item.state==='open'||item.state==='snoozed'"><button v-if="item.allowed_actions.some(a=>a.id==='once')" :disabled="!connected||busy" @click="emit('act','once')">允许一次</button><button v-if="item.allowed_actions.some(a=>a.id==='reject')" :disabled="!connected||busy" @click="emit('act','reject')">拒绝</button></div>
 <p v-if="!connected">连接已断开，恢复后可处理</p>
</section></template>
<script setup lang="ts">
import {computed} from 'vue'
import type {AttentionInboxItem} from '../../types/attentionInbox'
const props=defineProps<{item:AttentionInboxItem;connected:boolean;busy:boolean}>(),emit=defineEmits<{act:[action:'once'|'reject']}>()
const command=computed(()=>{const c=props.item.context as Record<string,any>;return c.command||c.input?.command||c.description||props.item.summary})
const stateLabel=computed(()=>props.busy?'提交中':({open:'等待处理',snoozed:'等待处理',submitting:'提交中',result_unknown:'结果未知，正在核对',resolved:'已处理',expired:'已失效'})[props.item.state])
</script>
<style scoped>
.private-approval{margin:16px 0;padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:grid;gap:10px}.private-approval small,.private-approval p{color:var(--fg-secondary);margin:0;font-size:12px}.private-approval pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.private-approval button{margin-right:8px;min-height:36px;padding:8px 14px;background:var(--bg);color:var(--accent);border:1px solid var(--border);border-radius:6px}
</style>
