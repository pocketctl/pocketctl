<template>
  <div ref="root" class="target-picker" data-testid="team-agent-target-picker" @keydown.esc.stop="closeMenu">
    <button ref="trigger" type="button" class="target-trigger" aria-haspopup="menu" :aria-expanded="open" @click="open = !open"><svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg><span>{{ selectionLabel }}</span><span>⌄</span></button>
    <div v-show="open" class="target-menu" role="menu" :aria-label="t('workspace.reply_agent')">
    <button type="button" :class="{ active: modelValue.mode === 'all' }" :disabled="!callableBindings.length" @click="selectAll"> {{ t('session.agent_filter_all') }} </button>
    <button type="button" :class="{ active: modelValue.mode === 'discussion' }" @click="selectDiscussion"> {{ t('workspace.discussion_only') }} </button>
    <div class="target-agents" :aria-label="t('workspace.target_agents')">
      <button
        v-for="binding in bindings"
        :key="binding.id"
        type="button"
        :class="{ active: modelValue.mode === 'offers' && modelValue.offerIDs.includes(binding.offer_id) }"
        :disabled="binding.availability !== 'online'"
        :title="`${bindingLabel(binding)} · ${binding.availability === 'online' ? t('workspace.send_this_agent') : availabilityLabel(binding.availability)}`"
        :data-offer-id="binding.offer_id"
        @click="toggleOffer(binding.offer_id)"
      >
        {{ bindingLabel(binding) }}
        <span :class="['target-dot', binding.availability]"></span>
      </button>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { teamProviderLabel } from '../../utils/teamProvider'
import { useLocale } from "../../composables/useLocale"
const { t } = useLocale()
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import type { TeamMember, TeamSessionAgentBinding } from '../../types/team'

export interface TeamAgentTargetValue {
  mode: 'all' | 'offers' | 'discussion'
  offerIDs: string[]
}

const props = withDefaults(defineProps<{ modelValue: TeamAgentTargetValue; bindings: TeamSessionAgentBinding[]; members?: TeamMember[] }>(), { members: () => [] })
const emit = defineEmits<{ 'update:modelValue': [value: TeamAgentTargetValue] }>()
const root=ref<HTMLElement|null>(null),trigger=ref<HTMLButtonElement|null>(null),open=ref(false)
function closeMenu(){open.value=false;trigger.value?.focus()}
function outside(event:MouseEvent){if(!root.value?.contains(event.target as Node))open.value=false}
onMounted(()=>document.addEventListener('click',outside));onBeforeUnmount(()=>document.removeEventListener('click',outside))
const selectionLabel=computed(()=>props.modelValue.mode==='discussion'?t('workspace.discussion_only'):props.modelValue.mode==='all'?t('workspace.available_agents_count', {count:callableBindings.value.length}):props.bindings.filter(binding=>props.modelValue.offerIDs.includes(binding.offer_id)).map(bindingLabel).join(' + '))
const callableBindings = computed(() => props.bindings.filter(binding => binding.availability === 'online'))

function bindingLabel(binding: TeamSessionAgentBinding): string {
  const provider = teamProviderLabel(binding.provider)
  const owner = props.members.find(member => member.user_id === binding.owner_user_id)?.display_label ?? t('workspace.member_id', {id:binding.owner_user_id})
  return `${provider} · ${owner} · ${binding.daemon_id}`
}

function availabilityLabel(value: TeamSessionAgentBinding['availability']): string {
  return ({ offline: t('team.availability.offline'), unsupported: t('team.availability.unsupported'), unmanaged: t('team.availability.unmanaged'), occupied: t('team.availability.occupied'), online: t('team.online'), access_disabled: t('team.availability.access_disabled') })[value]
}
function selectAll(): void { emit('update:modelValue', { mode: 'all', offerIDs: [] }); closeMenu() }
function selectDiscussion(): void { emit('update:modelValue', { mode: 'discussion', offerIDs: [] }); closeMenu() }
function toggleOffer(offerID: string): void {
  const selected = props.modelValue.mode === 'offers' ? props.modelValue.offerIDs : []
  const offerIDs = selected.includes(offerID) ? selected.filter(id => id !== offerID) : [...selected, offerID]
  emit('update:modelValue', offerIDs.length ? { mode: 'offers', offerIDs } : { mode: 'all', offerIDs: [] })
}
</script>

<style scoped>
.target-picker { display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }.target-picker::-webkit-scrollbar { display: none; }.target-picker button { flex: 0 0 auto; min-height: 28px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--fg-secondary); background: transparent; font-size: 10px; cursor: pointer; }.target-picker button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }.target-picker button:disabled { cursor: not-allowed; opacity: .48; }.target-agents { display: flex; gap: 5px; }.target-dot { display: inline-block; width: 5px; height: 5px; margin-left: 4px; border-radius: 50%; background: var(--fg-tertiary); }.target-dot.online { background: var(--success); }.target-dot.offline,.target-dot.occupied { background: var(--warning); }

.target-picker { position:relative; overflow:visible; min-width:0; }.target-picker .target-trigger { display:flex; align-items:center; gap:6px; padding:5px 7px; border-color:transparent; color:var(--fg-secondary); background:none; font-size:11px; border-radius:6px; }.target-trigger span:nth-child(2) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:220px; }.target-trigger svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.6; }.target-menu { position:absolute; z-index:60; bottom:calc(100% + 10px); left:0; width:260px; max-width:calc(100vw - 40px); padding:6px; border:1px solid var(--border-light); border-radius:8px; background:var(--surface); box-shadow:var(--shadow-lg); display:grid; gap:3px; }.target-menu > button,.target-menu .target-agents button { width:100%; border:0; padding:9px 10px; border-radius:5px; text-align:left; justify-content:flex-start; font-size:12px; }.target-agents { display:grid; border-top:1px solid var(--border); margin-top:3px; padding-top:3px; }.target-menu button:hover { background:var(--surface-hover); }
</style>
