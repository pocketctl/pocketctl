<template>
  <div class="safg-wrap">
    <div class="safg-card">
      <!-- Header: breadcrumb + title/desc + token pill + chevron -->
      <div class="safg-header" @click="expanded = !expanded">
        <svg class="safg-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        <span class="safg-breadcrumb">{{ parentTitle }} › {{ displayTitle }}</span>
        <!-- Token pill (reuse ToolCallCard token-render style) -->
        <span v-if="tokenUsage" class="safg-tokens">
          <span class="safg-tk" :title="'tokenIn ' + tokenUsage.tokenIn">↑{{ formatTokenCount(tokenUsage.tokenIn) }}</span>
          <span class="safg-tk" :title="'tokenOut ' + tokenUsage.tokenOut">↓{{ formatTokenCount(tokenUsage.tokenOut) }}</span>
          <span v-if="tokenUsage.tokenCache" class="safg-tk" :title="'cache ' + tokenUsage.tokenCache">⚡{{ formatTokenCount(tokenUsage.tokenCache) }}</span>
          <span v-if="tokenUsage.tokenCacheCreate" class="safg-tk" :title="'cacheCreate ' + tokenUsage.tokenCacheCreate">+{{ formatTokenCount(tokenUsage.tokenCacheCreate) }}</span>
        </span>
        <!-- Chevron -->
        <svg class="safg-chevron" :class="{ open: expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </div>

      <!-- Expanded body: render subagent messages reusing existing components -->
      <div v-if="expanded" class="safg-body">
        <template v-for="msg in messages" :key="msg.id">
          <template v-if="!isToolGroupContinuation(msg)">
          <MessageUser v-if="msg.role === 'user'" :content="msg.content" />
          <MessageAgent
            v-else-if="msg.type === 'agent_text'"
            :content="msg.content"
            :streaming="msg.streaming"
          />
          <DiffCard
            v-else-if="msg.type === 'tool_call' && isDiffTool(msg.tool)"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />
          <ToolCallGroup
            v-else-if="toolGroupFor(msg)"
            :messages="toolGroupFor(msg) || [msg]"
          />
          <ToolCallCard
            v-else-if="msg.type === 'tool_call'"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />
          <!-- Fallback: render content text if type is unknown -->
          <div v-else class="safg-fallback">{{ msg.content || msg.input || '' }}</div>
          </template>
        </template>
        <!-- Empty state when no messages yet -->
        <div v-if="messages.length === 0" class="safg-empty">{{ t('session.creating') }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { formatTokenCount } from '../../utils/tokenFormat'
import MessageUser from './MessageUser.vue'
import MessageAgent from './MessageAgent.vue'
import ToolCallGroup from './ToolCallGroup.vue'
import ToolCallCard from './ToolCallCard.vue'
import DiffCard from './DiffCard.vue'
import { isDiffTool } from '../../utils/diffRender'
import { buildToolCallGrouping } from '../../utils/toolGrouping'

const { t } = useLocale()

const props = defineProps<{
  agentId: string
  title: string
  desc: string
  agentType: string
  tokenUsage: { tokenIn: number; tokenOut: number; tokenCache: number; tokenCacheCreate: number } | null
  messages: any[]
  parentTitle: string
}>()

const expanded = ref(true)

const displayTitle = computed(() => props.title || props.desc || props.agentId)
const toolGrouping = computed(() => buildToolCallGrouping(props.messages))
function toolGroupFor(message: any): any[] | undefined {
  return toolGrouping.value.groups.get(message)
}
function isToolGroupContinuation(message: any): boolean {
  return toolGrouping.value.continuations.has(message)
}

</script>

<style scoped>
.safg-wrap {
  width: 100%;
  min-width: 0;
  animation: safg-fade-in 0.2s ease;
}

.safg-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  min-width: 0;
  transition: background var(--transition), border-color var(--transition);
}
.safg-card:hover { border-color: var(--border-light); }

.safg-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  cursor: pointer;
  min-width: 0;
}

.safg-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.safg-breadcrumb {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.safg-tokens {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-tertiary);
  flex-shrink: 0;
}
.safg-tk { font-family: var(--font-mono); }

.safg-chevron {
  color: var(--fg-tertiary);
  flex-shrink: 0;
  transition: transform 0.15s;
}
.safg-chevron.open { transform: rotate(180deg); }

.safg-body {
  border-top: 1px solid var(--border);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
}

.safg-empty {
  font-size: 13px;
  color: var(--fg-tertiary);
  padding: 8px 0;
}

.safg-fallback {
  font-size: 13px;
  color: var(--fg-secondary);
  padding: 4px 0;
  white-space: pre-wrap;
  word-break: break-word;
}

@keyframes safg-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
