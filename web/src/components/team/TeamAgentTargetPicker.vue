<template>
  <div class="target-picker" data-testid="team-agent-target-picker">
    <button type="button" :class="{ active: modelValue.mode === 'all' }" :disabled="!callableBindings.length" @click="selectAll">全部 Agent</button>
    <button type="button" :class="{ active: modelValue.mode === 'discussion' }" :disabled="!callableBindings.length" @click="selectDiscussion">仅补充讨论</button>
    <div class="target-agents" aria-label="定向 Agent">
      <button
        v-for="binding in bindings"
        :key="binding.id"
        type="button"
        :class="{ active: modelValue.mode === 'offers' && modelValue.offerIDs.includes(binding.offer_id) }"
        :disabled="binding.availability !== 'online'"
        :title="binding.availability === 'online' ? '发送给此 Agent' : availabilityLabel(binding.availability)"
        :data-offer-id="binding.offer_id"
        @click="toggleOffer(binding.offer_id)"
      >
        {{ binding.provider === 'codex' ? 'Codex' : 'Claude Code' }}
        <span :class="['target-dot', binding.availability]"></span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TeamSessionAgentBinding } from '../../types/team'

export interface TeamAgentTargetValue {
  mode: 'all' | 'offers' | 'discussion'
  offerIDs: string[]
}

const props = defineProps<{ modelValue: TeamAgentTargetValue; bindings: TeamSessionAgentBinding[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: TeamAgentTargetValue] }>()
const callableBindings = computed(() => props.bindings.filter(binding => binding.availability === 'online'))

function availabilityLabel(value: TeamSessionAgentBinding['availability']): string {
  return ({ offline: '离线', unsupported: '不支持团队调用', unmanaged: '未托管', occupied: '被其他团队占用', online: '在线' })[value]
}
function selectAll(): void { emit('update:modelValue', { mode: 'all', offerIDs: [] }) }
function selectDiscussion(): void { emit('update:modelValue', { mode: 'discussion', offerIDs: [] }) }
function toggleOffer(offerID: string): void {
  const selected = props.modelValue.mode === 'offers' ? props.modelValue.offerIDs : []
  const offerIDs = selected.includes(offerID) ? selected.filter(id => id !== offerID) : [...selected, offerID]
  emit('update:modelValue', offerIDs.length ? { mode: 'offers', offerIDs } : { mode: 'all', offerIDs: [] })
}
</script>

<style scoped>
.target-picker { display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }.target-picker::-webkit-scrollbar { display: none; }.target-picker button { flex: 0 0 auto; min-height: 28px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg-secondary); background: transparent; font-size: 10px; cursor: pointer; }.target-picker button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }.target-picker button:disabled { cursor: not-allowed; opacity: .48; }.target-agents { display: flex; gap: 5px; }.target-dot { display: inline-block; width: 5px; height: 5px; margin-left: 4px; border-radius: 50%; background: var(--fg-tertiary); }.target-dot.online { background: var(--success); }.target-dot.offline,.target-dot.occupied { background: var(--warning); }
</style>
