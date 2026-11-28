<template>
  <div class="mention-input" @focusout="leave">
    <div v-if="chips.length" class="mention-chips">
      <button v-for="chip in chips" :key="chip.id" type="button" :disabled="disabled" :aria-label="t('workspace.remove_mention', {name:chip.name})" @click="remove(chip.id)">@{{ chip.name }} ×</button>
    </div>
    <textarea ref="input" :value="text" :disabled="disabled" :placeholder="placeholder" :style="{height:height+'px'}" rows="1" data-testid="team-session-composer"
      :aria-controls="range ? listId : undefined" :aria-activedescendant="range && options.length ? optionId(active) : undefined"
      @input="onInput" @click="update" @keyup.left="update" @keyup.right="update" @compositionstart="composing=true;range=null" @compositionend="composing=false;update()" @keydown="key" />
    <div v-if="range && !disabled" class="mention-menu" :id="listId" role="listbox" :aria-label="t('workspace.mention_people_agents')">
      <button v-for="(option,index) in options" :id="optionId(index)" :key="option.key" :data-kind="option.kind" role="option" type="button" tabindex="-1" :aria-selected="index===active"
        @pointerdown.prevent @click="choose(option)" @pointermove="active=index">
        <AgentBadge v-if="option.provider" :agent="option.provider" size="sm" />
        <span v-else class="mention-avatar" aria-hidden="true">{{ option.name.slice(0,1) }}</span>
        <span class="mention-label">{{ option.name }}<small>{{ option.detail }}</small></span>
      </button>
      <p v-if="!options.length" role="status">{{ t('workspace.mention_no_match') }}</p>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import AgentBadge from '../AgentBadge.vue'
import { useLocale } from '../../composables/useLocale'
import { teamProviderLabel } from '../../utils/teamProvider'
import type { TeamMember, TeamSessionAgentBinding } from '../../types/team'

export interface TeamAgentTargetValue { mode: 'all'|'offers'|'discussion'|'readonly_offer'; offerIDs: string[] }
type Option = {key:string; kind:'member'|'agent'|'question'|'all'; id:string; name:string; detail:string; provider?:string}
const props=defineProps<{modelValue:TeamAgentTargetValue; text:string; bindings:TeamSessionAgentBinding[]; members:TeamMember[]; participantIds:number[]; disabled:boolean; height:number; placeholder:string}>()
const emit=defineEmits<{'update:modelValue':[value:TeamAgentTargetValue];'update:text':[value:string];send:[]}>()
const {t}=useLocale()
const input=ref<HTMLTextAreaElement>(), range=ref<{start:number;end:number;query:string}|null>(null)
const composing=ref(false), active=ref(0), listId=useId()
const optionId=(index:number)=>listId+'-'+index
function identity(binding:TeamSessionAgentBinding){
  const owner=props.members.find(m=>m.user_id===binding.owner_user_id)
  return [teamProviderLabel(binding.provider),owner?.display_label || t('workspace.member_id',{id:binding.owner_user_id}),binding.daemon_id].join(' · ')
}
const options=computed(()=>{
  const roster:Option[]=[]
  const members=props.members.filter(m=>m.state==='active'&&props.participantIds.includes(m.user_id))
  for(const member of members){
    const label=member.display_label || t('workspace.member_id',{id:member.user_id})
    const name=members.some(m=>m!==member && m.display_label===member.display_label) ? label+' · '+member.user_id : label
    roster.push({kind:'member',key:'m'+member.user_id,id:String(member.user_id),name,detail:t('team.member')})
  }
  const online=props.bindings.filter(b=>b.state==='active' && b.availability==='online')
  for(const b of online){
    if(props.modelValue.mode!=='all' && props.modelValue.mode!=='readonly_offer' && !props.modelValue.offerIDs.includes(b.offer_id))
      roster.push({kind:'agent',key:'a'+b.offer_id,id:b.offer_id,name:identity(b),detail:t('workspace.mention_execute'),provider:b.provider})
    if(b.read_only_question && props.modelValue.mode==='discussion')
      roster.push({kind:'question',key:'q'+b.offer_id,id:b.offer_id,name:identity(b),detail:t('workspace.mention_readonly'),provider:b.provider})
  }
  if(online.length && props.modelValue.mode==='discussion') roster.push({kind:'all',key:'all',id:'all',name:t('workspace.mention_all_agents'),detail:t('workspace.mention_execute')})
  const query=(range.value?.query??'').toLocaleLowerCase()
  return roster.filter(o=>(o.name+' '+o.detail).toLocaleLowerCase().includes(query))
})
const chips=computed(()=>props.modelValue.mode==='all' ? [{id:'all',name:t('workspace.mention_all_agents')}] : props.modelValue.offerIDs.map(id=>{
  const b=props.bindings.find(b=>b.offer_id===id)
  return {id,name:(props.modelValue.mode==='readonly_offer' ? t('workspace.mention_readonly')+' · ' : '')+(b?identity(b):id)}
}))
function update(){
  const el=input.value
  if(!el||composing.value||el.selectionStart!==el.selectionEnd){range.value=null;return}
  const end=el.selectionStart
  const match=/(?:^|[^A-Za-z0-9._%+@-])@([^\s@]*)$/u.exec(el.value.slice(0,end))
  range.value=match?{start:end-match[1].length-1,end,query:match[1]}:null
  active.value=0
}
function onInput(e:Event){emit('update:text',(e.target as HTMLTextAreaElement).value);update()}
function leave(e:FocusEvent){if(!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node|null))range.value=null}
async function choose(option:Option){
  const at=range.value, el=input.value
  if(!at||!el||props.disabled)return
  const suffix=el.value.slice(at.end)
  const mention=option.kind==='member'?'@'+option.name+(/^\s/.test(suffix)?'':' '):''
  if(option.kind!=='member')emit('update:modelValue',option.kind==='all'?{mode:'all',offerIDs:[]}:option.kind==='question'?{mode:'readonly_offer',offerIDs:[option.id]}:{mode:'offers',offerIDs:[...props.modelValue.offerIDs,option.id]})
  emit('update:text',el.value.slice(0,at.start)+mention+suffix)
  range.value=null
  await nextTick()
  el.focus();el.setSelectionRange(at.start+mention.length,at.start+mention.length)
}
function remove(id:string){
  const ids=props.modelValue.offerIDs.filter(i=>i!==id)
  emit('update:modelValue',ids.length?{mode:'offers',offerIDs:ids}:{mode:'discussion',offerIDs:[]})
  input.value?.focus()
}
function key(e:KeyboardEvent){
  if(e.isComposing || composing.value || e.keyCode===229)return
  if(range.value){
    if(e.key==='Escape'){e.preventDefault();range.value=null;return}
    if(['ArrowDown','ArrowUp'].includes(e.key)&&options.value.length){
      e.preventDefault();active.value=(active.value+(e.key==='ArrowDown'?1:-1)+options.value.length)%options.value.length
      document.getElementById(optionId(active.value))?.scrollIntoView({block:'nearest'});return
    }
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(options.value[active.value])void choose(options.value[active.value]);return}
  }
  if(e.key==='Backspace' && !input.value?.selectionStart && !input.value?.selectionEnd && chips.value.length){
    e.preventDefault();remove(chips.value[chips.value.length-1].id)
  }else if(e.key==='Enter'&&!e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey){e.preventDefault();emit('send')}
}
</script>
<style scoped>
.mention-input{position:relative;flex:1;min-width:0}
.mention-input textarea{display:block;box-sizing:border-box;width:100%;padding:8px 14px;border:0;background:transparent;color:var(--fg);font:inherit;resize:none}
.mention-chips{display:flex;flex-wrap:wrap;gap:4px;padding:4px 12px 0}
.mention-chips button{max-width:100%;overflow-wrap:anywhere;border:0;border-radius:6px;padding:4px 8px;background:var(--accent-muted);color:var(--accent);text-align:start}
.mention-menu{position:absolute;z-index:5;bottom:calc(100% + 6px);left:0;width:min(350px,100%);max-height:min(280px,35dvh);overflow:auto;overscroll-behavior:contain;box-sizing:border-box;padding:4px;border:1px solid var(--border-light);border-radius:10px;background:var(--surface);box-shadow:var(--shadow-lg)}
.mention-menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:6px 10px;border:0;border-radius:6px;background:none;color:var(--fg);text-align:start;cursor:pointer}
.mention-menu button[aria-selected=true]{background:var(--surface-hover)}.mention-avatar{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--surface-active);color:var(--fg-secondary)}
.mention-menu :deep(.agent-text){display:none}.mention-label{min-width:0;overflow-wrap:anywhere}.mention-label small,.mention-menu p{display:block;color:var(--fg-secondary);font-size:12px}.mention-menu p{padding:8px}
@media(max-width:768px){.mention-input textarea{font-size:16px}}
</style>
