<template>
  <div class="session-layout">
    <!-- Session List Panel -->
    <div class="session-panel">
      <div class="session-panel-header">
        <h3>{{ daemonName }}</h3>
        <button class="btn-icon" style="width:28px;height:28px;border:none;background:var(--accent);color:#fff;" :title="t('session.new_session')" @click="emitNewSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div v-if="!hasNoSessions" style="padding:4px 8px;display:flex;align-items:center;gap:6px;">
        <span :class="['status-dot', { online: isDaemonOnline }]" style="width:6px;height:6px;"></span>
        <span style="font-size:11px;color:var(--fg-tertiary);">{{ isDaemonOnline ? t('dashboard.online') : t('dashboard.offline') }} · {{ statusSubtext }}</span>
      </div>
      <div v-if="hostFilter" class="host-filter-chip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="3"/><path d="M7 2v20M17 2v20M2 12h20"/></svg>
        <span class="hfc-name">{{ daemonName }}</span>
        <button class="hfc-clear" @click="clearHostFilter" :title="t('session.show_all_hosts')">✕</button>
      </div>
      <div class="session-list">
        <div v-for="s in visibleSessions" :key="s.session_id"
          :class="['session-list-item', { active: s.session_id === sessionId, 'pending-delete': (s as any).__pendingDelete }]"
          @click="!(s as any).__pendingDelete && $router.push(`/session/${s.session_id}`)">
          <span :class="['status-dot', s.statusEffective || s.status]" style="width:7px;height:7px;"></span>
          <div class="sl-info">
            <div :class="['sl-title', { mono: !s.title || s.title.startsWith('Terminal Session') }]">
              <svg v-if="s.pinned" class="pin-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;"><path d="M16 3l5 5-3 1-3 3-1 5-2-2-5 5-1-1 5-5-2-2 5-1 3-3z"/></svg>
              <input v-if="renamingId === s.session_id" class="ss-rename-input" v-model="renameInput" maxlength="60"
                @click.stop @keydown.enter="commitRename(s)" @keydown.escape="cancelRename" @blur="commitRename(s)" />
              <template v-else>{{ s.title || s.session_id.slice(0, 8) }}</template>
            </div>
            <div class="sl-meta">{{ formatRelativeTime(s.last_activity_at || s.updated_at) }}<span v-if="s.subagent_count > 0"> · {{ t('session.sub_agents', { n: s.subagent_count }) }}</span></div>
          </div>
          <SessionActions :session="s" @startRename="startRename" @deleted="onDeleted" @pinned="onPinned" />
        </div>
      </div>
    </div>

    <!-- Chat Main Area -->
    <div class="chat-area">
      <!-- Full-area empty state when no sessions exist at all -->
      <div v-if="hasNoSessions" class="chat-welcome">
        <svg class="welcome-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
        <h2 class="welcome-title">{{ isDaemonOnline ? t('session.empty_no_session_title') : t('session.empty_no_host_title') }}</h2>
        <p class="welcome-desc">{{ isDaemonOnline ? t('session.empty_no_session_desc') : t('session.empty_no_host_desc') }}</p>
        <button v-if="isDaemonOnline" class="btn btn-accent welcome-btn" @click="emitNewSession">{{ t('session.new_session') }}</button>
      </div>

      <!-- Normal chat UI (only when sessions exist) -->
      <template v-else>
      <!-- Chat Toolbar -->
      <div class="chat-toolbar">
        <div class="session-label">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" @click="$router.push('/')"><path d="M15 18l-6-6 6-6"/></svg>
          {{ sessionTitle || sessionId?.slice(0, 8) }}
          <span class="daemon-name">· {{ daemonName }}</span>
        </div>
        <span :class="['status-pill', statusClass]"><span class="pulse"></span>{{ statusLabel }}</span>
        <span v-if="contextTokens" class="context-pill" :title="t('session.context_usage')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          {{ contextTokens }}
        </span>
        <span v-if="currentModel" class="model-pill" :title="'当前模型：' + currentModel">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          {{ currentModel }}
        </span>
        <div class="session-id-box">
          <code class="session-id-text">{{ sessionId?.slice(0, 8) }}</code>
          <button class="copy-btn" @click="copySessionId" :title="copied ? t('common.copied') : t('session.actions.copy_id')">
            <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
          <button v-if="currentSessionAgent !== 'opencode'" class="copy-btn" style="margin-left:6px;" :title="resumeCopied ? t('session.actions.resume_toast') : t('session.actions.resume') + t('session.actions.resume_hint')" @click="copyResumeCmd">
            <svg v-if="!resumeCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div class="chat-messages" ref="messagesEl" @scroll="onMessagesScroll">
        <!-- Exit Banner -->
        <div v-if="status === 'exited'" class="banner banner-info" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span>{{ t('session.exited_banner') }}</span>
          <span v-if="exitReason" style="margin-left:4px;">· {{ exitReasonLabel(exitReason) }}</span>
          <button v-if="isDaemonOnline" class="btn btn-accent" style="margin-left:auto;padding:4px 12px;font-size:12px;" @click="focusResumeInput">Resume</button>
        </div>

        <!-- Disconnected Banner -->
        <div v-if="isDisconnected" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{{ t('session.daemon_offline') }}</span>
        </div>
        <!-- L1: send failed (ws not open at send time) -->
        <div v-if="sendError" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{{ t('session.send_failed') }}</span>
        </div>

        <!-- Timeline -->
        <div class="timeline" v-if="milestones.length > 0">
          <template v-for="(m, i) in milestones" :key="i">
            <div class="milestone">
              <div :class="['dot', m.state]"></div>
              <span :class="['label', m.state === 'current' || m.state === 'active' ? 'active' : '']">{{ m.label }}</span>
              <span class="time">{{ m.time }}</span>
            </div>
            <div v-if="i < milestones.length - 1" :class="['line', { done: m.state === 'active' }]"></div>
          </template>
        </div>

        <!-- Empty state when no messages -->
        <div v-if="messages.length === 0" class="chat-empty-state">
          <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <div class="empty-title">{{ chatEmptyTitle }}</div>
          <div class="empty-desc">{{ chatEmptyDesc }}</div>
        </div>

        <!-- Messages -->
        <template v-for="msg in messages" :key="msg.id">
          <!-- User message (right bubble) -->
          <MessageUser v-if="msg.role === 'user'" :content="cleanContent(msg.content)" />

          <!-- Agent text message (full-width block) -->
          <MessageAgent
            v-else-if="msg.type === 'agent_text'"
            :content="cleanContent(msg.content)"
            :streaming="msg.streaming"
          />

          <!-- AskUserQuestion (question card, not a tool card) -->
          <QuestionCard
            v-if="msg.type === 'tool_call' && msg.tool === 'AskUserQuestion'"
            :message="msg"
          />

          <!-- Tool call / subagent (full-width block) -->
          <DiffCard
            v-else-if="msg.type === 'tool_call' && isDiffTool(msg.tool)"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />
          <ToolCallCard
            v-else-if="msg.type === 'tool_call' || msg.type === 'subagent'"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />

          <!-- Error message (full-width block) -->
          <MessageError v-else-if="msg.type === 'error'" :content="msg.content || msg.error" />

          <!-- Command execution receipt -->
          <CommandReceiptCard v-else-if="msg.type === 'command_receipt'" :command="msg.command" :status="msg.receiptStatus" :message="msg.message" />

          <!-- Tool-use approval request (non-bypass sessions) -->
          <ApprovalCard v-else-if="msg.type === 'approval_request'" :message="msg" @respond="onApprovalRespond" />

          <!-- PTY selection menu (host-hook confirmation, TUI prompt, etc.) -->
          <InteractiveChoiceCard v-else-if="msg.type === 'interactive_prompt'" :message="msg" @respond="onChoiceRespond" />
        </template>

        <!-- Turn status bar: lives inside the message stream (visually part of
             it), below the last message. Live timer while working; on completion
             shows total duration + output tokens + a copy button. -->
        <div v-if="isExecuting || awaitingStart || lastTurnDuration !== null || completedBarVisible" class="turn-status-bar" :class="{ done: lastTurnDuration !== null || completedBarVisible }">
          <template v-if="isExecuting || awaitingStart">
            <span class="status-dot working"></span>
            <span class="status-text">{{ t('session.creating') }}</span>
            <span class="status-timer">{{ fmtDuration(turnElapsed) }}</span>
          </template>
          <template v-else>
            <svg class="status-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            <span class="status-text">{{ t('session.completed') }}</span>
            <span v-if="lastTurnDuration !== null" class="status-timer">{{ fmtDuration(lastTurnDuration) }}</span>
            <span v-if="lastAgentUsage?.output_tokens" class="status-tokens">{{ t('session.output_tokens', { n: fmtTokens(lastAgentUsage.output_tokens) }) }}</span>
            <button v-if="hasLastAgentReply" class="status-copy-btn" @click="copyLastReply">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>{{ replyCopied ? t('common.copied') : t('common.copy') }}</span>
            </button>
            <button v-if="hasLastUserPrompt && canInput" class="status-copy-btn" @click="retryLastPrompt" :title="t('common.retry')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
              <span>{{ t('common.retry') }}</span>
            </button>
          </template>
        </div>
      </div>

      <!-- Chat Input — unified container with embedded controls -->
      <div class="chat-input-area" :class="{ ended: !canInput }">
        <!-- Scroll-to-bottom: absolute child of chat-input-area, floats above
             its top edge. Doesn't take up flex space in chat-messages. -->
        <Transition name="scroll-btn">
          <button v-if="messages.length > 0 && !autoScroll" class="scroll-to-bottom" :title="t('session.scroll_to_bottom')" @click="scrollToBottom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
          </button>
        </Transition>
        <template v-if="canInput">
          <div class="chat-input-container" :class="{ focused: isInputFocused }">
            <!-- Slash command popover -->
            <CommandPopover
              v-if="showPopover"
              :commands="filteredCommands"
              :active-index="selectedIndex"
              @select="applyCommand"
              @hover="selectedIndex = $event"
            />
            <!-- Drag handle to resize textarea height (sits above the textarea;
                 follows the container's top edge as the height changes) -->
            <div class="textarea-resize-handle" @mousedown="startResize"></div>

            <!-- Textarea (multi-line) -->
            <textarea
              v-model="messageInput"
              class="chat-textarea"
              :style="{ height: textareaHeight + 'px' }"
              :placeholder="isPendingSession ? t('session.input_creating') : (isDaemonSession && isTerminal ? t('session.input_resume') : t('session.input_send'))"
              @keydown="onInputKeydown"
              @focus="isInputFocused = true"
              @blur="isInputFocused = false"
              :disabled="isDisconnected || isPendingSession || isLoading"
              ref="inputEl"
              rows="3"
            ></textarea>

            <!-- Bottom control row -->
            <div class="input-controls">
              <!-- Left: permission mode dropdown -->
              <div class="perm-dropdown" ref="permDropdownEl">
                <button class="perm-trigger" @click="showPermMenu = !showPermMenu" :title="`当前: ${t(currentPermLabel)}`">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span class="perm-label">{{ t(currentPermLabel) }}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <Transition name="perm-menu">
                  <div v-if="showPermMenu" class="perm-menu">
                    <button v-for="m in PERMISSION_MODES" :key="m.value"
                      :class="['perm-menu-item', { active: currentPermissionMode === m.value }]"
                      @click="setPermissionMode(m.value); showPermMenu = false">
                      <span class="perm-menu-name">{{ t(m.label) }}</span>
                      <svg v-if="currentPermissionMode === m.value" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                    </button>
                  </div>
                </Transition>
              </div>

              <!-- Right: model + effort + context usage + send/stop button -->
              <div class="input-right">
                <!-- Current model (resolved from session_meta) -->
                <span v-if="currentModel" class="model-pill" :title="t('session.current_model')">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>
                  <span class="model-name">{{ currentModel }}</span>
                </span>

                <!-- Effort level dropdown (Claude Code thinking strength) -->
                <div v-if="canInput && currentSessionAgent === 'claude-code'" class="effort-dropdown" ref="effortDropdownEl">
                  <button class="effort-trigger" @click="showEffortMenu = !showEffortMenu"
                    :title="t('session.effort_level')">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z"/><path d="M6 10v2a6 6 0 0 0 12 0v-2"/><path d="M12 18v3"/></svg>
                    <span class="effort-label">{{ currentEffort || t('session.effort_unknown') }}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  <Transition name="perm-menu">
                    <div v-if="showEffortMenu" class="perm-menu">
                      <button v-for="lvl in EFFORT_LEVELS" :key="lvl"
                        :class="['perm-menu-item', { active: currentEffort === lvl }]"
                        @click="setEffort(lvl)">
                        <span class="perm-menu-name">{{ lvl }}</span>
                        <svg v-if="currentEffort === lvl" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                      </button>
                    </div>
                  </Transition>
                </div>

                <div v-if="contextTokens" class="ctx-indicator" :title="contextTooltip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                  <span class="ctx-value">{{ contextTokens }}</span>
                </div>

                <!-- Send button (idle) -->
                <button v-if="!isExecuting" class="action-btn send-btn"
                  @click="sendMessage"
                  :disabled="isDisconnected || isPendingSession || isLoading || !messageInput.trim()"
                  :title="t('session.send_enter')">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
                </button>

                <!-- Stop button (executing). 1st click = graceful Ctrl+C;
                     clicking again within 2.5s escalates to force-kill (SIGKILL).
                     Disabled while disconnected so a stale "running" status
                     (relay restart / daemon offline with no status echo) can't
                     trigger an unroutable session_interrupt that errors out. -->
                <button v-else class="action-btn stop-btn" :class="{ escalated: stopEscalated }"
                  @click="interruptSession"
                  :disabled="isDisconnected"
                  :title="isDisconnected ? t('session.daemon_offline') : (stopEscalated ? t('session.force_stop') : t('session.stop_gen'))">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                </button>
              </div>
            </div>
          </div>
        </template>
        <div v-else class="ended-text">{{ t('session.ended') }}</div>
      </div>
      </template><!-- /v-else hasNoSessions -->
    </div>
  </div>

  <NewSessionDialog
    v-if="showNewSession"
    :daemons="daemonList"
    :preSelectedDaemonId="hostFilter"
    @close="showNewSession = false"
  />
  <CommandHelpModal
    v-if="showHelpModal"
    :commands="commandsCache"
    @close="showHelpModal = false"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import SessionActions from '../components/SessionActions.vue'
import CommandPopover from '../components/CommandPopover.vue'
import CommandReceiptCard from '../components/CommandReceiptCard.vue'
import CommandHelpModal from '../components/CommandHelpModal.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageError from '../components/messages/MessageError.vue'
import { useLocale } from '../composables/useLocale'
import ToolCallCard from '../components/messages/ToolCallCard.vue'
import QuestionCard from '../components/messages/QuestionCard.vue'
import ApprovalCard from '../components/messages/ApprovalCard.vue'
import InteractiveChoiceCard from '../components/messages/InteractiveChoiceCard.vue'
import DiffCard from '../components/messages/DiffCard.vue'
import { buildResumeCommand } from '../utils/resumeCommand'
import { formatToolInput } from '../utils/toolDisplay'
import { isDiffTool } from '../utils/diffRender'
import { useSessionRename } from '../composables/useSessionRename'
import type { CommandItem } from '../composables/useWebSocket'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()

const route = useRoute()
const router = useRouter()
const { connect, send, onEvent } = useWebSocket()
const { t } = useLocale()

const sessionId = computed(() => route.params.id as string)
const messages = ref<any[]>([])
const allSessions = ref<any[]>([])
const messageInput = ref('')
const commandsCache = ref<CommandItem[]>([])
const currentModel = ref('')            // resolved model name from session_meta event
const currentEffort = ref('')           // thinking-effort level from session_meta (low/medium/high/xhigh/max/ultracode)
const showEffortMenu = ref(false)       // effort dropdown visibility
// Claude Code TUI exposes these effort levels via the /effort command.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
// Persist the last-set effort per session so it survives refresh / session switch
// (effort is a runtime TUI state, not stored in JSONL or settings.json).
const effortStorageKey = (sid: string) => `pocketctl:effort:${sid}`
const showHelpModal = ref(false)        // /help local command → full-screen modal
const replayReqId = ref(0)
const isLoading = ref(false)
// session-history-pagination: backward pagination state
const pageSize = computed(() => 50)  // session-history-pagination: 一次加载 50 条（平衡首屏/翻页性能）
const loadedMinId = ref(0)      // oldest loaded event id (backward cursor)
const isLoadingBackward = ref(false)  // a pagination (scroll-up) request in flight
const hasMore = ref(false)      // relay signaled older events exist
const resumeCopied = ref(false)  // session-resume-command: 复制恢复命令反馈
const showNewSession = ref(false)
const daemonList = computed(() => Object.values(daemons.value))
const currentSessionAgent = computed(() => allSessions.value.find((x: any) => x.session_id === sessionId.value)?.agent)
const isPendingSession = computed(() => sessionId.value.startsWith('pending-'))
const selectedIndex = ref(0)
const popoverDismissed = ref(false)
const status = ref('running')
// A (web-post-send-feedback): transient flag set on sendMessage, cleared when
// the first running/busy/waiting status or agent_text arrives. Bridges the
// round-trip so the turn-bar shows "working" instantly instead of after daemon
// echoes session_status.
const awaitingStart = ref(false)
// L1: transient "send failed" banner (ws not open at send time).
const sendError = ref(false)
// L2: pending ack-timeout timer for the last optimistic send.
const pendingAckTimer = ref<ReturnType<typeof setTimeout> | null>(null)
const exitReason = ref('')
const currentPermissionMode = ref('bypassPermissions')
const showPermMenu = ref(false)
const PERMISSION_MODES = [
  { value: 'bypassPermissions', label: 'session.perm_bypass' },
  { value: 'default', label: 'session.perm_default' },
  { value: 'acceptEdits', label: 'session.perm_accept_edits' },
  { value: 'plan', label: 'session.perm_plan' },
]
const PERM_LABELS: Record<string, string> = { bypassPermissions: 'session.perm_bypass', default: 'session.perm_default', acceptEdits: 'session.perm_accept_edits', plan: 'session.perm_plan' }
const currentPermLabel = computed(() => PERM_LABELS[currentPermissionMode.value] || currentPermissionMode.value)
const exitedAt = ref('')
const autoScroll = ref(true)
const copied = ref(false)
const messagesEl = ref<HTMLDivElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const permDropdownEl = ref<HTMLElement | null>(null)
const effortDropdownEl = ref<HTMLElement | null>(null)
const isInputFocused = ref(false)
// Textarea height (user-adjustable via drag handle, resets on page refresh)
const DEFAULT_TEXTAREA_HEIGHT = 72  // ~3 rows
const MIN_TEXTAREA_HEIGHT = 60
const MAX_TEXTAREA_HEIGHT = 400
const textareaHeight = ref(DEFAULT_TEXTAREA_HEIGHT)
const daemons = ref<Record<string, any>>({})
const hostFilter = computed(() => (route.query.host as string) || '')
const visibleSessions = computed(() => {
  if (!hostFilter.value) return allSessions.value
  return allSessions.value.filter((s: any) => s.daemon_id === hostFilter.value)
})

const statusClass = computed(() => {
  const map: Record<string, string> = { running: 'running', busy: 'running', idle: 'running', completed: '', error: '', killed: '', disconnected: '', exited: '' }
  return map[status.value] || ''
})

const statusLabel = computed(() => {
  const STATUS_KEYS: Record<string, string> = { running: 'session.status.running', busy: 'session.status.busy', idle: 'session.status.idle', completed: 'session.status.completed', error: 'session.status.error', killed: 'session.status.killed', disconnected: 'session.status.disconnected', exited: 'session.status.exited' }
  return t(STATUS_KEYS[status.value] || 'session.status.running')
})

const isDaemonOnline = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_online ?? true
})

const isDisconnected = computed(() => status.value === 'disconnected' || !isDaemonOnline.value)
// True when there are zero sessions at all — the whole chat area should show
// a welcoming empty state instead of "unknown host" / error messages.
const hasNoSessions = computed(() => allSessions.value.length === 0)

// Empty state copy — adapts to whether a host is connected and sessions exist.
const chatEmptyTitle = computed(() => {
  if (!isDaemonOnline.value && allSessions.value.length === 0) return t('session.empty_no_host_title')
  if (allSessions.value.length === 0) return t('session.empty_no_session_title')
  return t('session.empty_select_title')
})
const chatEmptyDesc = computed(() => {
  if (!isDaemonOnline.value && allSessions.value.length === 0) return t('session.empty_no_host_desc')
  if (allSessions.value.length === 0) return t('session.empty_no_session_desc')
  return t('session.empty_select_desc')
})
const isTerminal = computed(() => ['completed', 'error', 'killed'].includes(status.value))
// Daemon-created sessions can be resumed (via claude --resume) even after completion,
// so the input box stays available as long as the daemon is online.
const isDaemonSession = computed(() => {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value)
  return s?.source === 'daemon'
})
const canInput = computed(() => !isDisconnected.value && (!isTerminal.value || isDaemonSession.value))
// Agent is actively generating (send button → stop button)
// Agent is actively working — includes 'waiting' (tool execution in progress),
// otherwise the timer would stop prematurely when a tool call is running.
const isExecuting = computed(() => status.value === 'running' || status.value === 'busy' || status.value === 'waiting')

// --- Turn timer (status bar above the input area) ---
// Timer is driven entirely by isExecuting transitions: starts on false→true
// (covers both sendMessage and new-session-with-prompt, which bypasses
// sendMessage), stops on true→false (whole turn done, incl. tool calls).
// sessionSwitching gates the watch during a session change: the placeholder
// status='running' (set in the sessionId watcher before replay) must NOT start
// the timer from zero. The real turn start is recovered from the last
// executing session_status's last_activity_at once replay completes.
const turnStartTime = ref<number | null>(null)   // 本轮开始时间戳
const turnElapsed = ref(0)                        // 实时计时（秒）
const lastTurnDuration = ref<number | null>(null) // 完成后的总耗时（秒）
let turnTimer: ReturnType<typeof setInterval> | null = null
let sessionSwitching = false                        // true while switching sessions (suppress timer)
let resumeStartAt: number | null = null           // turn start recovered from replay (ms epoch)

function startTurnTimer(startAt?: number) {
  if (turnTimer) clearInterval(turnTimer)
  // startAt (ms) recovers accumulated time when resuming a running turn on
  // session switch; default (now) for a fresh turn triggered by sendMessage.
  turnStartTime.value = startAt ?? Date.now()
  lastTurnDuration.value = null
  turnElapsed.value = Math.floor((Date.now() - turnStartTime.value) / 1000)
  turnTimer = setInterval(() => {
    if (turnStartTime.value) {
      turnElapsed.value = Math.floor((Date.now() - turnStartTime.value) / 1000)
    }
  }, 1000)
}
function stopTurnTimer() {
  if (turnTimer) { clearInterval(turnTimer); turnTimer = null }
  if (turnStartTime.value) {
    lastTurnDuration.value = Math.floor((Date.now() - turnStartTime.value) / 1000)
  }
}
// Drive the timer from isExecuting: start on false→true, stop on true→false.
// Gated by sessionSwitching so the placeholder status during initial load /
// session switch doesn't start the timer from zero. The real turn start is
// recovered from the last executing session_status's last_activity_at once
// replay completes (replay_end handler calls startTurnTimer directly).
// NOTE: no { immediate: true } — that would fire before sessionSwitching is
// set in onMounted, starting a zero-based timer that competes with the
// replay_end recovery.
watch(() => isExecuting.value, (exec, prev) => {
  if (sessionSwitching) return
  if (exec && !prev) startTurnTimer(resumeStartAt ?? undefined)
  else if (!exec && prev) stopTurnTimer()
})

// Last agent_text usage (output tokens for the completed bar). Reuses the same
// reverse-scan pattern as buildCostMessage.
const lastAgentUsage = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const u = (messages.value[i] as any).usage
    if (u) return u
  }
  return null
})
const hasLastAgentReply = computed(() =>
  messages.value.some((m: any) => m.type === 'agent_text'))
// Whether a user prompt exists that can be retried. A retry re-sends the last
// user message verbatim, so it's gated on a real user_text message existing.
const hasLastUserPrompt = computed(() =>
  messages.value.some((m: any) => m.role === 'user' && m.content))
// Refresh recovery: a finished session (idle/completed/exited/…) loses
// lastTurnDuration on reload (it's runtime-only, not in replay). Still surface
// the "completed" bar — check + label + tokens + copy — as long as history has
// an agent reply. Precise duration is omitted (not recomputed from events).
const completedBarVisible = computed(() => {
  if (isExecuting.value || lastTurnDuration.value !== null) return false
  return ['idle', 'completed', 'exited', 'error', 'killed'].includes(status.value) && hasLastAgentReply.value
})

function fmtTokens(n: number): string {
  if (n > 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}
// Format a duration (seconds) as Xs / Xm Ys / Xh Ym Zs for the turn timer.
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

// Copy the last agent_text reply (already clean Markdown source) to clipboard.
const replyCopied = ref(false)
let replyCopyTimer: ReturnType<typeof setTimeout> | null = null
function copyLastReply() {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i] as any
    if (m.type === 'agent_text') {
      navigator.clipboard.writeText(m.content).then(() => {
        replyCopied.value = true
        if (replyCopyTimer) clearTimeout(replyCopyTimer)
        replyCopyTimer = setTimeout(() => { replyCopied.value = false }, 2000)
      }).catch(() => {})
      return
    }
  }
}

// Retry: re-send the last user prompt verbatim. Walks messages backward to the
// most recent user_text and routes it through sendMessage() (filling messageInput
// first), so it reuses the full optimistic-echo / ack-timeout / local-command
// pipeline — the retried bubble is treated exactly like a fresh send. The
// original content (pre-cleanContent) is used to preserve the user's intent.
// Guarded in the template by canInput (no retry on ended/disconnected sessions).
function retryLastPrompt() {
  if (!canInput.value) return
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i] as any
    if (m.role === 'user' && m.content) {
      messageInput.value = m.content
      sendMessage()
      return
    }
  }
}

const daemonName = computed(() => {
  if (hostFilter.value) {
    const d = daemons.value[hostFilter.value]
    return d?.daemon_alias || d?.hostname || hostFilter.value.slice(0, 8)
  }
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.daemon_alias || s?.hostname || s?.daemon_id?.slice(0, 8) || t('session.unknown_host')
})
function clearHostFilter() {
  const q = { ...route.query }
  delete q.host
  router.replace({ query: q })
}

const sessionTitle = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.title
})

const statusSubtext = computed(() => isDaemonOnline.value ? t('session.status.connected') : t('session.status.waiting'))

// Context token usage — from the last agent_text message that carried usage.
// lastUsage holds the most recent token usage seen for this session, set from
// any event carrying usage (incl. usage-only carriers like opencode step-finish /
// codex token_count that have no text and thus no message to attach to). Reset on
// session switch. effectiveUsage prefers it, falling back to scanning messages.
const lastUsage = ref<any>(null)
function effectiveUsage(): any {
  if (lastUsage.value) return lastUsage.value
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const u = (messages.value[i] as any).usage
    if (u) return u
  }
  return null
}

const contextTokens = computed(() => {
  const u = effectiveUsage()
  if (u) {
    const total = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_create_tokens || 0)
    return total > 1000 ? (total / 1000).toFixed(1) + 'K' : String(total)
  }
  return ''
})

const contextTooltip = computed(() => {
  const u = effectiveUsage()
  if (u) {
    const parts: string[] = []
    if (u.input_tokens) parts.push(`${t('session.context_input')}: ${u.input_tokens.toLocaleString()}`)
    if (u.output_tokens) parts.push(`${t('session.context_output')}: ${u.output_tokens.toLocaleString()}`)
    if (u.cache_read_tokens) parts.push(`${t('session.context_cache_read')}: ${u.cache_read_tokens.toLocaleString()}`)
    if (u.cache_create_tokens) parts.push(`${t('session.context_cache_create')}: ${u.cache_create_tokens.toLocaleString()}`)
    return parts.length ? t('session.context_usage') + '\n' + parts.join('\n') : ''
  }
  return ''
})

const milestones = computed(() => {
  const ms: any[] = []
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  if (!s) return ms
  if (s.created_at) ms.push({ label: t('session.milestone_created'), time: formatTime(s.created_at), state: 'active' })
  ms.push({ label: t('session.status.running'), time: formatTime(s.last_activity_at || s.updated_at || s.created_at), state: status.value === 'running' || status.value === 'busy' ? 'current' : 'active' })
  ms.push({ label: statusLabel.value, time: '—', state: isTerminal.value || status.value === 'exited' ? 'active' : '' })
  return ms
})

let copyTimer: ReturnType<typeof setTimeout> | null = null
function copySessionId() {
  navigator.clipboard.writeText(sessionId.value).then(() => {
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 2000)
  }).catch(() => {})
}

// session-resume-command: copy `cd "<cwd>" && <agent resume <sid>>` for terminal handoff
function copyResumeCmd() {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value)
  if (!s) return
  const cmd = buildResumeCommand({ agent: (s as any).agent, cwd: (s as any).cwd, session_id: sessionId.value })
  navigator.clipboard.writeText(cmd).then(() => {
    resumeCopied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { resumeCopied.value = false }, 2000)
  }).catch(() => {})
}

function formatTime(ts: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
}

function cleanContent(text: string): string {
  if (!text) return ''

  // Slash command: Claude Code records the command as <command-name>/<command-message>/
  // <command-args> tags — these wrap the whole user message. iOS's sanitizeUserMessage
  // extracts command-name as the display text; mirror it here so the user bubble shows
  // "/compact" instead of an empty shell (the old code stripped every tag → empty).
  if (text.includes('<command-name>') || text.includes('<command-message>')) {
    const nameMatch = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
    const msgMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/)
    const name = (nameMatch?.[1] ?? '').trim()
    const msg = (msgMatch?.[1] ?? '').trim()
    // Show only command-name (e.g. "/model"). command-message is a redundant
    // command identifier (e.g. "model"), not a useful description — appending it
    // produced "/model\nmodel". Aligns with iOS sanitizeUserMessage.
    if (name || msg) {
      return name || msg
    }
  }

  // Plain message: strip command/local-command tags, keep the body text.
  return text
    .replace(/<command-name>.*?<\/command-name>\s*/gs, '')
    .replace(/<command-message>.*?<\/command-message>\s*/gs, '')
    .replace(/<command-args>.*?<\/command-args>\s*/gs, '')
    .replace(/<local-command-caveat>.*?<\/local-command-caveat>\s*/gs, '')
    .replace(/<local-command-stdout>(.*?)<\/local-command-stdout>/gs, '$1')
    .replace(/<local-command-stderr>(.*?)<\/local-command-stderr>/gs, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = { user_interrupt: '用户中断', normal_exit: '正常退出', process_crash: '异常退出', signal_kill: '被终止', unknown: '已退出' }
  return labels[reason] || reason
}

function emitNewSession() { showNewSession.value = true }

function scrollToBottom() {
  if (messagesEl.value) { messagesEl.value.scrollTop = messagesEl.value.scrollHeight; autoScroll.value = true }
}

function onMessagesScroll() {
  if (!messagesEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = messagesEl.value
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 60
  // session-history-pagination: scrolled to top → fetch older page (backward)
  if (scrollTop < 60 && hasMore.value && !isLoadingBackward.value && !isLoading.value && loadedMinId.value > 0) {
    isLoadingBackward.value = true
    replayReqId.value++
    send({ type: 'replay', session_id: sessionId.value, direction: 'backward', last_seq: loadedMinId.value, limit: pageSize.value, req_id: replayReqId.value })
  }
}

function focusResumeInput() { if (inputEl.value) { inputEl.value.focus() } }

function setPermissionMode(mode: string) {
  send({ type: 'set_permission_mode', session_id: sessionId.value, content: mode })
}

// Switch thinking-effort: inject `/effort <level>` into the PTY via the daemon,
// then persist it locally so the pill stays in sync across refresh / session switch.
function setEffort(level: string) {
  currentEffort.value = level
  showEffortMenu.value = false
  try { localStorage.setItem(effortStorageKey(sessionId.value), level) } catch {}
  send({ type: 'set_effort', session_id: sessionId.value, content: level })
}

// Stop button escalation: 1st click sends PTY Ctrl+C (graceful). If clicked
// again within 2.5s (Ctrl+C didn't reach claude — PTY disconnected), escalate
// to session_kill (SIGKILL the claude process). This guarantees a stuck session
// can always be stopped, even when the PTY master is disconnected from claude's
// stdin (the c5813d2c incident: 11 Ctrl+C writes went into a void PTY).
const stopEscalated = ref(false)
let stopResetTimer: ReturnType<typeof setTimeout> | null = null
function interruptSession() {
  // Defensive guard: the stop button is :disabled while disconnected, but a
  // stale "running" status (relay restart, missed session_status) could leave
  // it clickable briefly. Bail instead of firing an unroutable interrupt that
  // errors out as "session not found or daemon offline".
  if (isDisconnected.value) return
  if (stopEscalated.value) {
    // 2nd click within the window → force kill.
    send({ type: 'session_kill', session_id: sessionId.value })
    stopEscalated.value = false
    return
  }
  // 1st click → graceful Ctrl+C; arm escalation window.
  send({ type: 'session_interrupt', session_id: sessionId.value })
  stopEscalated.value = true
  if (stopResetTimer) clearTimeout(stopResetTimer)
  stopResetTimer = setTimeout(() => { stopEscalated.value = false }, 2500)
}

// Tool-call timeout guard (B2): a tool_call that never receives a matching
// tool_result leaves its card spinning forever (e.g. the claude process died
// mid-tool, or the PTY disconnected). For each live tool_call (not replayed),
// arm a timeout; if no result arrives, mark the card as 'timeout' so it stops
// spinning. Cleared on result, session switch, and unmount.
const TOOL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const toolTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
// Out-of-order tool results: relay persists events with fire-and-forget
// inserts, so DB row id doesn't always match send order — a tool_result can
// land before its tool_call. On replay (ordered by id) the result then arrives
// first and finds no tool_call to attach to. Buffer orphan results here and
// apply them when the matching tool_call is created.
const pendingToolResults = new Map<string, { output: string | null }>()
function armToolTimeout(callId: string) {
  if (toolTimeouts.has(callId)) clearTimeout(toolTimeouts.get(callId)!)
  const timer = setTimeout(() => {
    toolTimeouts.delete(callId)
    const m = messages.value.find((x: any) => x.type === 'tool_call' && x.call_id === callId)
    if (m && (m as any).status === 'running') (m as any).status = 'timeout'
  }, TOOL_TIMEOUT_MS)
  toolTimeouts.set(callId, timer)
}
function clearToolTimeout(callId: string) {
  const t = toolTimeouts.get(callId)
  if (t) { clearTimeout(t); toolTimeouts.delete(callId) }
}
function clearAllToolTimeouts() {
  for (const t of toolTimeouts.values()) clearTimeout(t)
  toolTimeouts.clear()
}

// Local-command whitelist: handled entirely in the browser, never sent to the
// daemon PTY. NOT sourced from commandsCache — these builtins are filtered out
// of command_list by the agent's init event in daemon sessions, so relying on
// the cache would silently disable them. Hardcode the names instead.
const LOCAL_COMMANDS = ['cost', 'status', 'help', 'model']

// Send a tool-use approval decision back to the daemon. The ApprovalCard
// already flipped its local status optimistically; here we just dispatch the
// approval_response command, which the relay forwards to the owning daemon.
function onApprovalRespond(msg: any, approved: boolean) {
  if (!msg.request_id) return
  send({
    type: 'approval_response',
    session_id: sessionId.value,
    request_id: msg.request_id,
    approved,
  })
}

// Send the user's menu choice back to the daemon. The InteractiveChoiceCard
// already marked its selection optimistically; here we dispatch the
// interactive_response command, which the relay forwards to the owning daemon,
// which writes the chosen index to the agent's PTY so the blocking prompt
// proceeds.
function onChoiceRespond(msg: any, choice: string) {
  if (!msg.request_id) return
  send({
    type: 'interactive_response',
    session_id: sessionId.value,
    request_id: msg.request_id,
    choice,
  })
}

function sendMessage() {
  const text = messageInput.value.trim()
  if (!text || isDisconnected.value) return
  if (isPendingSession.value) return // D3: pending-id 窗口期不发命令（--resume pending-xxx 必失败）
  // Local command interception: /cost /status /help /model are answered from
  // in-memory/relay data rather than the claude PTY (where they're unavailable).
  if (text.startsWith('/')) {
    const cmdName = text.slice(1).split(/\s/)[0]
    if (LOCAL_COMMANDS.includes(cmdName)) {
      messageInput.value = ''
      handleLocalCommand(cmdName, text)
      return
    }
  }
  // C (web-post-send-feedback): optimistic echo — push user bubble immediately.
  // Relay's user_text echo is deduped by isDuplicate (same pattern as
  // handleLocalCommand), so no double bubble.
  const bubbleId = nextId('u')
  const msgId = `m-${bubbleId}`  // L2: correlate ack/nack with this optimistic bubble
  messages.value.push({ id: bubbleId, type: 'user_text', role: 'user', content: text, __msg_id: msgId })
  nextTick(scrollToBottom)
  const sent = send({ type: 'user_message', session_id: sessionId.value, content: text, msg_id: msgId })
  if (!sent) {
    rollbackOptimistic(msgId)  // L1: WebSocket not open
    return
  }
  messageInput.value = ''
  startTurnTimer()  // begin turn timer (stops when isExecuting → false)
  awaitingStart.value = true  // A: show turn-bar until first running/agent_text
  armAckTimeout(msgId)  // L2: roll back if relay doesn't ack within 3s
}

// L1/L2 (web-post-send-feedback): remove the optimistic user bubble + reset
// awaiting-start state + flash the send-failed banner. Used by the synchronous
// send-failure path (ws not open), the relay nack, and the ack-timeout.
function rollbackOptimistic(msgId?: string) {
  if (pendingAckTimer.value) { clearTimeout(pendingAckTimer.value); pendingAckTimer.value = null }
  const idx = msgId ? messages.value.findIndex((m: any) => m.__msg_id === msgId) : -1
  if (idx >= 0) messages.value.splice(idx, 1)
  awaitingStart.value = false
  sendError.value = true
  setTimeout(() => { sendError.value = false }, 3000)
}

// L2: arm a 3s timeout — if relay doesn't ack, assume loss and roll back.
function armAckTimeout(msgId: string) {
  if (pendingAckTimer.value) clearTimeout(pendingAckTimer.value)
  pendingAckTimer.value = setTimeout(() => rollbackOptimistic(msgId), 3000)
}

// handleLocalCommand renders the user bubble + result locally (no daemon round
// trip, so no user_text is relayed back — we construct both here).
function handleLocalCommand(cmdName: string, text: string) {
  messages.value.push({ id: nextId('u'), type: 'user_text', role: 'user', content: text })
  const result = buildLocalCommandResult(cmdName, text)
  if (result) {
    messages.value.push(result)
    // Persist the locally-generated user msg + receipt so they survive refresh and
    // sync to other devices. Relay stores them as events and broadcasts to OTHER
    // clients (origin keeps its local copy — no echo back, to avoid duplicates).
    send({
      type: 'local_command_log',
      session_id: sessionId.value,
      user_text: text,
      command: result.command,
      receipt_status: result.receiptStatus,
      message: result.message,
    })
  }
  nextTick(scrollToBottom)
}

// buildLocalCommandResult returns a command_receipt message for the given local
// command, or null when the command opens a modal instead (/help).
function buildLocalCommandResult(cmdName: string, text: string): any | null {
  if (cmdName === 'help') {
    showHelpModal.value = true
    return null
  }
  if (cmdName === 'cost') {
    return {
      id: nextId('r'), type: 'command_receipt',
      command: '/cost', receiptStatus: 'success', message: buildCostMessage(),
    }
  }
  if (cmdName === 'status') {
    return {
      id: nextId('r'), type: 'command_receipt',
      command: '/status', receiptStatus: 'success', message: buildStatusMessage(),
    }
  }
  if (cmdName === 'model') {
    const arg = text.slice(1).split(/\s/).slice(1).join(' ').trim()
    return {
      id: nextId('r'), type: 'command_receipt',
      command: '/model', receiptStatus: 'success', message: buildModelMessage(arg),
    }
  }
  return null
}

// buildCostMessage summarizes token usage accumulated in this session from the
// last agent_text carrying usage (same source as the context-token pill).
function buildCostMessage(): string {
  let usage: any = null
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const u = (messages.value[i] as any).usage
    if (u) { usage = u; break }
  }
  if (!usage) return '当前会话暂无 token 用量记录'
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  const cacheRead = usage.cache_read_tokens || 0
  const cacheCreate = usage.cache_create_tokens || 0
  const total = input + output + cacheRead + cacheCreate
  const fmt = (n: number) => n > 1000 ? (n / 1000).toFixed(1) + 'K' : String(n)
  return `累计 ${fmt(total)} tokens（输入 ${fmt(input)} · 输出 ${fmt(output)} · 缓存 ${fmt(cacheRead + cacheCreate)}）`
}

// buildStatusMessage reports daemon online state + agent version, derived from
// the current session's host. Account/login status is intentionally out of scope
// (claude CLI does not expose it to pocketctl) — point users to the terminal.
function buildStatusMessage(): string {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value) as any
  if (!s) return '当前会话状态未知'
  const online = s.daemon_online ? '在线' : '离线'
  const parts = [`主机 ${online}`]
  if (s.daemon_version) parts.push(`daemon v${s.daemon_version}`)
  const agentVer = s.agent_version || s.agentVersion
  const agentLabel = s.agent_type === 'codex' ? 'Codex' : (s.agent_type === 'opencode' ? 'OpenCode' : 'Claude Code')
  if (agentVer) parts.push(`${agentLabel} v${agentVer}`)
  parts.push('账户登录状态请在终端运行 pocketctl status 查看')
  return parts.join(' · ')
}

// buildModelMessage shows the active model. Terminal /model switches are now
// reflected live (detected from the next assistant message's model field), so
// no restart is required.
function buildModelMessage(arg: string): string {
  if (arg) {
    return `请在终端使用 /model 切换模型，切换后将在下一条回复生效并自动同步到此处。`
  }
  return currentModel.value
    ? `当前模型：${currentModel.value}`
    : '当前会话未上报模型信息'
}

// Slash command autocompletion
const filteredCommands = computed(() => {
  const input = messageInput.value
  if (!input.startsWith('/')) return []
  const prefix = input.slice(1).toLowerCase()
  const pool = commandsCache.value
  if (prefix === '') return pool.slice(0, 50)
  return pool.filter(c => c.name.toLowerCase().startsWith(prefix)).slice(0, 50)
})
const showPopover = computed(() => !popoverDismissed.value && filteredCommands.value.length > 0)

// Reset selection/dismissal whenever the input changes
watch(messageInput, () => {
  selectedIndex.value = 0
  popoverDismissed.value = false
})

// --- Textarea resize via drag handle ---
function startResize(e: MouseEvent) {
  e.preventDefault()
  const startY = e.clientY
  const startHeight = textareaHeight.value
  document.body.style.cursor = 'ns-resize'
  document.body.style.userSelect = 'none'

  function onMove(ev: MouseEvent) {
    const delta = startY - ev.clientY // drag up = taller
    textareaHeight.value = Math.min(MAX_TEXTAREA_HEIGHT, Math.max(MIN_TEXTAREA_HEIGHT, startHeight + delta))
  }
  function onUp() {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

function onInputKeydown(e: KeyboardEvent) {
  // Alt/Option+Enter or Shift+Enter → insert newline (checked first, even
  // when popover is open, so /command<Alt+Enter> doesn't auto-apply).
  if (e.key === 'Enter' && (e.altKey || e.shiftKey)) {
    e.preventDefault()
    const el = inputEl.value
    if (el) {
      const start = el.selectionStart
      const end = el.selectionEnd
      messageInput.value = messageInput.value.slice(0, start) + '\n' + messageInput.value.slice(end)
      nextTick(() => {
        el.selectionStart = el.selectionEnd = start + 1
        // Grow to fit content (capped), driven through textareaHeight so the
        // :style binding stays the single source of truth for the height.
        const fit = Math.min(Math.max(el.scrollHeight, MIN_TEXTAREA_HEIGHT), MAX_TEXTAREA_HEIGHT)
        textareaHeight.value = fit
      })
    }
    return
  }

  if (showPopover.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value + 1) % filteredCommands.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex.value = (selectedIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length
      return
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      applyCommand(filteredCommands.value[selectedIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      popoverDismissed.value = true
      return
    }
    return // popover open: don't process Enter below
  }

  // Enter (no modifier) → send
  if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault()
    sendMessage()
  }
}

function applyCommand(item: CommandItem) {
  if (!item) return
  messageInput.value = '/' + item.name + ' '
  popoverDismissed.value = true
  nextTick(() => { inputEl.value?.focus() })
}

const msgCounter = { value: 0 }
function nextId(prefix: string) { return prefix + (++msgCounter.value) }

// safeParseJSON parses a JSON string, returning null on failure (instead of
// throwing). Used for event payloads whose input may be a stringified object.
function safeParseJSON(s: string): any {
  try { return JSON.parse(s) } catch { return null }
}

// Dedup: only skip an event if it's identical to the immediately preceding one
// (guards against relay batch re-send / reconnect). We intentionally do NOT dedup
// by content globally — claude -p's synthetic command replies (e.g. "No response
// requested.", "/model isn't available...") share text across history and new
// commands, so a global Set would wrongly swallow a new command's reply that
// matches a historical one.
function isDuplicate(type: string, text: string, target = messages.value): boolean {
  const last = target[target.length - 1]
  return !!last && last.type === type && (last.content || '') === text
}

function processEvent(evt: any, target: any[] = messages.value) {
  const type = evt.type || evt.event_type
  if (type === 'user_text') {
    const text = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    if (text && !isDuplicate('user_text', text, target)) target.push({ id: nextId('u'), type: 'user_text', role: 'user', content: text })
  } else if (type === 'agent_text') {
    // A: model started responding — end optimistic window (fallback if the
    // running status was missed, e.g. PTY race).
    awaitingStart.value = false
    const content = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    const usage = evt.usage || evt.payload?.usage
    if (usage && target === messages.value) lastUsage.value = usage
    // Usage-only carrier (opencode step-finish / codex token_count): no text,
    // just token accounting. Attach it to the latest agent_text so the context
    // pill picks it up, instead of dropping the event.
    if (!content) {
      if (usage) {
        for (let i = target.length - 1; i >= 0; i--) {
          if ((target[i] as any).type === 'agent_text') { (target[i] as any).usage = usage; break }
        }
      }
      return
    }
    if (isDuplicate('agent_text', content, target)) return
    const streaming = evt.streaming ?? evt.payload?.streaming ?? false
    const last = target[target.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !content.startsWith('\n')) {
      last.content += content
      if (!streaming) last.streaming = false
      if (usage) last.usage = usage
    } else {
      target.push({ id: nextId('a'), type: 'agent_text', role: 'agent', content, streaming, usage })
    }
  } else if (type === 'tool_call') {
    const callId = evt.call_id || evt.payload?.call_id
    if (!callId) return
    const tool = evt.tool || evt.payload?.tool || ''
    const input = evt.input || evt.payload?.input
    const inputDesc = formatToolInput(tool, input)
    // Always create new tool_call message (matches iOS app). If a matching
    // result arrived out of order (buffered in pendingToolResults), apply it
    // now so the card renders completed instead of spinning forever.
    const pending = pendingToolResults.get(callId)
    target.push({
      id: nextId('t'), type: 'tool_call', call_id: callId,
      tool, input, inputDesc,
      output: pending?.output ?? null, status: pending ? 'completed' : 'running',
      expanded: false, outputExpanded: false,
    })
    if (pending) pendingToolResults.delete(callId)
  } else if (type === 'tool_result') {
    const callId = evt.call_id || evt.payload?.call_id
    const output = evt.output || evt.payload?.output || evt.result || evt.payload?.result
    if (!callId) return
    // Find last matching tool_call (matches iOS app lastIndex logic)
    let idx = -1
    for (let i = target.length - 1; i >= 0; i--) {
      if (target[i].type === 'tool_call' && target[i].call_id === callId) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      if (output) target[idx].output = output
      target[idx].status = 'completed'
    } else {
      // tool_call hasn't been created yet (out-of-order replay) — buffer the
      // result so it's applied when the matching tool_call arrives.
      pendingToolResults.set(callId, { output: output ?? null })
    }
  } else if (type === 'session_status') {
    const s = evt.status || evt.payload?.status
    if (s) status.value = s
    // A: first executing status from daemon ends the optimistic window.
    if (s === 'running' || s === 'busy' || s === 'waiting') awaitingStart.value = false
    // During a session switch, capture the turn start time from the last
    // executing status (busy/running/waiting) so the timer can resume the
    // accumulated elapsed instead of restarting from zero.
    if (sessionSwitching && (s === 'running' || s === 'busy' || s === 'waiting')) {
      const ts = evt.last_activity_at || evt.payload?.last_activity_at
      if (ts) resumeStartAt = new Date(ts).getTime()
    }
    if (evt.exit_reason || evt.payload?.exit_reason) exitReason.value = evt.exit_reason || evt.payload.exit_reason
    if (evt.exited_at || evt.payload?.exited_at) exitedAt.value = evt.exited_at || evt.payload.exited_at
  } else if (type === 'command_receipt') {
    target.push({
      id: nextId('r'), type: 'command_receipt',
      command: evt.command || '', receiptStatus: evt.receipt_status || 'success',
      message: evt.message || '',
    })
  } else if (type === 'approval_request') {
    // Daemon surfaced a PreToolUse approval (non-bypass session). Render an
    // inline Yes/No card; the user's answer is sent back via approval_response.
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const tool = evt.tool || evt.payload?.tool || ''
    const input = evt.input || evt.payload?.input
    target.push({
      id: nextId('ap'), type: 'approval_request', request_id: requestId,
      call_id: evt.call_id || evt.payload?.call_id,
      tool, input, inputDesc: formatToolInput(tool, input),
      status: 'pending',
    })
  } else if (type === 'interactive_prompt') {
    // Daemon scanned a selection menu the agent's TUI drew to the PTY (e.g. a
    // host PreToolUse hook's "Do you want to proceed? ❶Yes ❷No" prompt that
    // never reaches JSONL). Render an inline numbered-choice card; the user's
    // selection is sent back via interactive_response.
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const rawInput = evt.input || evt.payload?.input
    let promptText = ''
    let options: Array<{ index: string; label: string }> = []
    if (rawInput) {
      const inp = typeof rawInput === 'string' ? safeParseJSON(rawInput) : rawInput
      promptText = inp?.prompt || ''
      if (Array.isArray(inp?.options)) options = inp.options
    }
    target.push({
      id: nextId('ip'), type: 'interactive_prompt', request_id: requestId,
      prompt: promptText, options, status: 'pending', selectedChoice: '',
    })
  }
}

// Watch for session switch — clear messages and replay new session
watch(sessionId, (newId, oldId) => {
  if (newId && newId !== oldId) {
    clearAllToolTimeouts()   // reset tool timeout guards on session switch
    pendingToolResults.clear() // discard buffered out-of-order results
    // Gate the turn-timer watch: the placeholder status='running' below must
    // not start the timer from zero. The real turn start (if executing) is
    // recovered from the last executing session_status once replay completes.
    sessionSwitching = true
    resumeStartAt = null
    if (turnTimer) { clearInterval(turnTimer); turnTimer = null }
    turnStartTime.value = null
    turnElapsed.value = 0
    lastTurnDuration.value = null
    lastUsage.value = null  // reset context usage on session switch
    messages.value = []
    status.value = 'running'
    awaitingStart.value = false  // A: reset optimistic window on session switch
    exitReason.value = ''
    exitedAt.value = ''
    commandsCache.value = []
    currentModel.value = '' // clear; refilled by get_session_meta below
    currentEffort.value = '' // clear; refilled by get_session_meta / localStorage
    showEffortMenu.value = false
    replayReqId.value++
    isLoading.value = true
    loadedMinId.value = 0
    isLoadingBackward.value = false
    hasMore.value = false
    send({ type: 'replay', session_id: newId, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    send({ type: 'list_commands', session_id: newId })
    send({ type: 'get_session_meta', session_id: newId })
  }
})

const cleanups: (() => void)[] = []

onMounted(() => {
  connect()
  send({ type: 'list_sessions' })
  send({ type: 'list_daemons' })
  // Gate the timer watch for the initial load too: status defaults to 'running'
  // (a placeholder) and would start the timer from zero before the real status
  // arrives via replay. replay_end un-gates and resumes correctly.
  sessionSwitching = true
  replayReqId.value++
  isLoading.value = true
  loadedMinId.value = 0
  isLoadingBackward.value = false
  hasMore.value = false
  send({ type: 'replay', session_id: sessionId.value, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
  send({ type: 'list_commands', session_id: sessionId.value })
  // Query the resolved model on mount (authoritative, covers sessions opened
  // directly rather than just-created — session_created is one-shot and fires
  // before this component subscribes).
  send({ type: 'get_session_meta', session_id: sessionId.value })

  cleanups.push(onEvent('session_list', (msg: any) => {
    allSessions.value = msg.sessions || []
    // default 哨兵 → 自动落到首个会话（避免停在空白的 default 占位）：
    //   - 带 host query（从主机"查看全部"跳来）：该主机的首个会话
    //   - 无 host query（sidebar 直接进入会话模块）：整个列表的首个会话
    // 落定后 daemonName 按当前 sessionId 解析，session-panel-header 与 chat-toolbar
    // 都会显示这个会话所属的主机名。
    if (sessionId.value === 'default') {
      const first = visibleSessions.value[0]
      if (first) {
        const query = hostFilter.value ? { host: hostFilter.value } : {}
        router.replace({ path: `/session/${first.session_id}`, query })
      }
    }
  }))
  // session_created: 新建会话到达时立即加入左侧列表（乐观插入），并补刷一次
  // 权威 list_sessions 拿完整字段。relay 的 session_created 只发给 origin client
  // 且早于 DB upsert 落库，挂载时的初次 list_sessions 拿不到新会话，必须靠事件补齐。
  cleanups.push(onEvent('session_created', (msg: any) => {
    const sid = msg.session_id
    if (!sid) return
    if (!allSessions.value.find((s: any) => s.session_id === sid)) {
      allSessions.value.unshift({
        session_id: sid,
        status: 'running',
        agent: 'claude-code',
        source: 'daemon',
        title: msg.title || '',
        cwd: '',
        daemon_id: msg.daemon_id || '',
        hostname: msg.hostname || '',
        created_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        subagent_count: 0,
        pinned: false,
        daemon_online: true,
      })
    }
    // session_created carries the daemon-resolved model (for the /model command).
    if (sid === sessionId.value && msg.model) currentModel.value = msg.model
    send({ type: 'list_sessions' })
  }))
  cleanups.push(onEvent('daemon_list', (msg: any) => {
    const map: Record<string, any> = {}
    for (const d of (msg.daemons || [])) map[d.daemon_id] = d
    daemons.value = map
  }))
  cleanups.push(onEvent('command_list', (msg: any) => {
    if (msg.session_id !== sessionId.value) return // discard stale responses from other sessions
    commandsCache.value = msg.commands || []
  }))
  cleanups.push(onEvent('command_receipt', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))
  // session_meta: authoritative model name, in response to get_session_meta.
  // (session_created also carries model as an optimistic early fill below.)
  cleanups.push(onEvent('session_meta', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.model) currentModel.value = msg.model
    // effort: prefer the daemon-reported value (reflects what pocketctl set);
    // fall back to the last persisted local value when the daemon has none.
    if (msg.effort) {
      currentEffort.value = msg.effort
    } else {
      try {
        const saved = localStorage.getItem(effortStorageKey(sessionId.value))
        if (saved) currentEffort.value = saved
      } catch {}
    }
  }))

  // session_model_changed: the daemon detected a /model switch mid-session
  // (from the next assistant message's model field). Refresh the badge live.
  cleanups.push(onEvent('session_model_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.model) currentModel.value = msg.model
  }))

  cleanups.push(onEvent('replay_batch', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return // D4: stale batch
    const isBackward = msg.direction === 'backward'
    // backward batches arrive in id DESC; reverse to ASC for chronological render/prepend
    const evts = isBackward ? [...msg.events].reverse() : msg.events
    if (isLoadingBackward.value && isBackward) {
      // pagination: build page into a temp array, prepend in ONE shot, then manually
      // restore scrollTop so the viewport stays on the exact same content.
      // overflow-anchor is DISABLED (CSS) because it mis-anchors to the newly prepended
      // top element and yanks the viewport to the oldest record. Manual restore is precise.
      const oldScrollHeight = messagesEl.value?.scrollHeight || 0
      const oldScrollTop = messagesEl.value?.scrollTop || 0
      const tempMsgs: any[] = []
      for (const evt of evts) processEvent(evt, tempMsgs)
      if (tempMsgs.length) messages.value = [...tempMsgs, ...messages.value]
      nextTick(() => {
        if (!messagesEl.value) return
        const delta = messagesEl.value.scrollHeight - oldScrollHeight
        messagesEl.value.scrollTop = oldScrollTop + delta
      })
    } else {
      // initial load (first backward page, or legacy forward full-load): render + scroll bottom
      for (const evt of evts) processEvent(evt)
      nextTick(scrollToBottom)
    }
  }))
  cleanups.push(onEvent('replay_end', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return
    isLoading.value = false
    isLoadingBackward.value = false
    if (msg.has_more !== undefined) hasMore.value = !!msg.has_more
    // backward: last_seq is the oldest id of the returned page → next page cursor
    if (msg.last_seq && (!loadedMinId.value || msg.last_seq < loadedMinId.value)) loadedMinId.value = msg.last_seq
    // Session switch complete: ungate the timer watch. If the target session is
    // executing, resume timing from the recovered turn start (last executing
    // session_status's last_activity_at) so elapsed isn't reset to zero.
    if (sessionSwitching) {
      sessionSwitching = false
      // The placeholder status set on switch is 'running'; the relay does NOT
      // replay session_status events (only message history), so correct it from
      // the authoritative session list (DB status, kept current by the relay).
      // Without this an idle session (e.g. opencode) would look "running" and
      // start the turn timer from zero.
      const meta = allSessions.value.find((s: any) => s.session_id === sessionId.value)
      if (meta) {
        let st = meta.statusEffective || meta.status
        // A "running/busy" status that hasn't seen activity recently is stale:
        // the daemon isn't actively syncing this session (an actively-running
        // session refreshes last_activity_at every poll). Treat it as idle so the
        // timer doesn't start from zero on a session that isn't really working
        // (e.g. an opencode turn that was abandoned and fell out of the sync window).
        if (st === 'running' || st === 'busy' || st === 'waiting') {
          const la = meta.last_activity_at || meta.updated_at
          const ageMs = la ? Date.now() - new Date(la).getTime() : Infinity
          if (ageMs > 120000) st = 'idle'
        }
        if (st) status.value = st
      }
      if (isExecuting.value) startTurnTimer(resumeStartAt ?? undefined)
      resumeStartAt = null
    }
  }))

  cleanups.push(onEvent('user_message_ack', (msg: any) => {
    // L2: relay received & forwarded — clear the ack-timeout (awaitingStart now
    // waits for B's running/agent_text).
    if (pendingAckTimer.value) { clearTimeout(pendingAckTimer.value); pendingAckTimer.value = null }
  }))
  cleanups.push(onEvent('user_message_nack', (msg: any) => {
    // L2: daemon offline / unknown session — roll back the optimistic bubble.
    rollbackOptimistic(msg.msg_id)
  }))

  cleanups.push(onEvent('user_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('agent_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('tool_call', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    // Arm timeout guard: if no tool_result arrives in time, the card flips to
    // 'timeout' instead of spinning forever (claude died / PTY disconnected).
    const callId = msg.call_id || msg.payload?.call_id
    if (callId) armToolTimeout(callId)
    nextTick(scrollToBottom)
  }))

  cleanups.push(onEvent('tool_result', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processEvent(msg)
    const callId = msg.call_id || msg.payload?.call_id
    if (callId) clearToolTimeout(callId)
  }))

  cleanups.push(onEvent('subagent_discovered', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    messages.value.push({ id: nextId('sa'), type: 'subagent', tool: msg.agent_id || 'Agent', input: msg.subagent_desc, status: 'completed', expanded: true, outputExpanded: false })
  }))

  cleanups.push(onEvent('session_status', (msg: any) => {
    if (msg.session_id === sessionId.value) { status.value = msg.status; if (msg.exit_reason) exitReason.value = msg.exit_reason; if (msg.exited_at) exitedAt.value = msg.exited_at }
  }))

  cleanups.push(onEvent('permission_mode_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    currentPermissionMode.value = msg.permission_mode || 'acceptEdits'
  }))

  // 兜底：URL 仍是 pending 时，session_id_changed 到达则替换为真实 ID 并重新 replay
  cleanups.push(onEvent('session_id_changed', (msg: any) => {
    if (msg.old_session_id && msg.old_session_id === sessionId.value) {
      router.replace(`/session/${msg.session_id}`)
      // 清空旧消息，重新拉取真实 ID 的历史
      messages.value = []
      replayReqId.value++
      isLoading.value = true
      send({ type: 'replay', session_id: msg.session_id, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    }
  }))

  cleanups.push(onEvent('error', (msg: any) => {
    if (msg.session_id && msg.session_id !== sessionId.value) return
    messages.value.push({ id: nextId('e'), type: 'error', content: msg.error || '未知错误' })
  }))

  cleanups.push(onEvent('session_deleted', (msg: any) => {
    allSessions.value = allSessions.value.filter((s: any) => s.session_id !== msg.session_id)
    if (msg.session_id === sessionId.value) {
      const next = allSessions.value[0]
      if (next) router.push(`/session/${next.session_id}`)
    }
  }))

  cleanups.push(onEvent('session_pinned', (msg: any) => {
    const s = allSessions.value.find((x: any) => x.session_id === msg.session_id)
    if (s) (s as any).pinned = msg.pinned
  }))

  cleanups.push(onEvent('session_title_update', (msg: any) => {
    const s = allSessions.value.find((x: any) => x.session_id === msg.session_id)
    if (s) s.title = msg.title
  }))
})

// SessionActions handlers (optimistic local updates)
function onDeleted(_sessionId: string) { /* handled by session_deleted WS event */ }
function onPinned(sessionId: string, pinned: boolean) {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId)
  if (s) (s as any).pinned = pinned
}

onUnmounted(() => {
  for (const fn of cleanups) fn()
  cleanups.length = 0
  document.removeEventListener('click', closePermMenu)
  if (turnTimer) { clearInterval(turnTimer); turnTimer = null }
  if (stopResetTimer) { clearTimeout(stopResetTimer); stopResetTimer = null }
  clearAllToolTimeouts()
})

function closePermMenu(e: MouseEvent) {
  if (permDropdownEl.value && !permDropdownEl.value.contains(e.target as Node)) {
    showPermMenu.value = false
  }
  if (effortDropdownEl.value && !effortDropdownEl.value.contains(e.target as Node)) {
    showEffortMenu.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', closePermMenu)
})
</script>

<style>
.session-layout { display: flex; flex: 1; width: 100%; min-width: 0; height: calc(100vh - var(--topbar-h)); overflow: hidden; }

/* Session Panel */
.session-panel { width: 300px; background: var(--sidebar-bg); border-right: 1px solid var(--sidebar-border); display: flex; flex-direction: column; flex-shrink: 0; transition: background var(--transition), border-color var(--transition); }
.session-panel-header { padding: 16px; border-bottom: 1px solid var(--sidebar-border); display: flex; align-items: center; justify-content: space-between; }
.session-panel-header h3 { font-size: 14px; font-weight: 600; color: var(--fg); }
.host-filter-chip { margin: 8px; padding: 6px 10px; background: var(--accent-muted); border: 1px solid var(--accent); border-radius: var(--radius-full); display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--accent); }
.host-filter-chip .hfc-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.host-filter-chip .hfc-clear { flex-shrink: 0; width: 16px; height: 16px; border: none; background: none; color: var(--accent); cursor: pointer; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; opacity: 0.7; }
.host-filter-chip .hfc-clear:hover { opacity: 1; background: rgba(88,166,255,0.2); }
.session-list { flex: 1; overflow-y: auto; padding: 8px; }
.session-list-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); cursor: pointer; transition: background 0.1s, opacity 0.25s ease; margin-bottom: 2px; }
.session-list-item:hover { background: var(--surface-hover); }
.session-list-item.pending-delete { opacity: 0.35; pointer-events: none; }
.session-list-item.active { background: var(--sidebar-active); }
.session-list-item .sl-info { flex: 1; min-width: 0; }
.session-list-item .sl-title { font-size: 13px; font-weight: 500; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-list-item .pin-icon { color: var(--accent); flex-shrink: 0; vertical-align: middle; }
.session-list-item .ss-rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-muted); color: var(--fg); font-family: var(--font-body); font-size: 13px; font-weight: 500; padding: 3px 6px; outline: none; width: 100%; }
.session-list-item .sl-title.mono { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.session-list-item .sl-meta { font-size: 11px; color: var(--fg-tertiary); margin-top: 2px; }

/* Chat Area */
.chat-area { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; max-width: 100%; overflow: hidden; background: var(--bg); transition: background var(--transition); }

/* Toolbar */
.chat-toolbar { height: 52px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 20px; gap: 12px; background: var(--surface); transition: background var(--transition), border-color var(--transition); }
.chat-toolbar .session-label { font-size: 14px; font-weight: 600; color: var(--fg); flex: 1; display: flex; align-items: center; gap: 8px; }
.chat-toolbar .session-label .daemon-name { font-size: 12px; color: var(--fg-tertiary); font-weight: 400; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.status-pill.running { background: var(--success-bg); color: var(--success); }
.status-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse-green 1.5s infinite; }
.model-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; background: var(--accent-muted); color: var(--accent); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.session-id-box { display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-md); }
.session-id-text { font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); }
.copy-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 4px; padding: 0; transition: color 0.15s, background 0.15s; }
.copy-btn:hover { color: var(--accent); background: var(--accent-muted); }

/* Messages */
.chat-messages { flex: 1; min-height: 0; width: 100%; overflow-y: auto; overflow-x: hidden; padding: 20px; display: flex; flex-direction: column; align-items: stretch; gap: 16px; position: relative; overflow-anchor: none; }
/* min-width:0 lets long content (code/URLs) wrap instead of overflowing
   horizontally. max-width + center keeps lines readable on wide screens.
   User bubbles are excluded (they use fit-content + right align). */
/* Agent text: adaptive width — short replies stay narrow, long content grows to 720px.
   Left-aligned (natural document flow), unlike centered tool cards. */
.chat-messages > .agent-block { min-width: 0; max-width: 720px; width: fit-content; align-self: flex-start; }
/* Errors / banners: full width within 820px, centered. (tool-wrap + receipt-card excluded — left-aligned) */
.chat-messages > *:not(.msg):not(.agent-block):not(.tool-wrap):not(.receipt-card):not(.turn-status-bar) { min-width: 0; max-width: 820px; width: 100%; align-self: center; }
/* Tool cards: left-aligned, not centered. */
.chat-messages > .tool-wrap { min-width: 0; max-width: 820px; width: 100%; align-self: flex-start; }
.chat-messages > *.msg { min-width: 0; max-width: 85%; }

/* Empty state */
.chat-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 12px; padding: 40px 20px; text-align: center; }
.chat-empty-state .empty-icon { color: var(--fg-tertiary); opacity: 0.4; }
.chat-empty-state .empty-title { font-size: 16px; font-weight: 600; color: var(--fg-secondary); }
.chat-empty-state .empty-desc { font-size: 13px; color: var(--fg-tertiary); line-height: 1.5; max-width: 360px; }

/* Welcome empty state — fills entire chat-area when no sessions exist */
.chat-welcome { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 16px; padding: 40px 20px; text-align: center; }
.chat-welcome .welcome-icon { color: var(--fg-tertiary); opacity: 0.3; }
.chat-welcome .welcome-title { font-size: 20px; font-weight: 600; color: var(--fg-secondary); margin: 0; }
.chat-welcome .welcome-desc { font-size: 14px; color: var(--fg-tertiary); line-height: 1.6; max-width: 380px; margin: 0; }
.chat-welcome .welcome-btn { margin-top: 8px; padding: 10px 24px; font-size: 14px; }
/* Scroll-to-bottom: floats centered above the input bar. Auto-hides (v-if)
   when content is already scrolled to the bottom (autoScroll === true). */
/* Scroll-to-bottom: absolute child of chat-input-area, pinned above its top
   edge. Takes zero flex space — doesn't shrink chat-messages. */
.scroll-to-bottom { position: absolute; top: -40px; left: 50%; transform: translateX(-50%); width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 10px rgba(0,0,0,0.3); transition: background 0.15s, color 0.15s; z-index: 50; }
.scroll-to-bottom:hover { background: var(--surface-hover); color: var(--fg); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.25s ease; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; }

/* Messages — message type styles (msg-user/msg-agent/tool-card/msg-error)
   now live in their own components under components/messages/. The timeline
   and chat-input styles below remain here because they are layout concerns
   of this view, not reusable message rendering. */

/* Timeline */
.timeline { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); margin-bottom: 4px; flex-shrink: 0; }
.timeline .milestone { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.timeline .milestone .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
.timeline .milestone .dot.active { background: var(--success); }
.timeline .milestone .dot.current { background: var(--success); animation: pulse-green 1.5s infinite; }
.timeline .milestone .label { font-size: 11px; color: var(--fg-tertiary); }
.timeline .milestone .label.active { color: var(--fg-secondary); }
.timeline .milestone .time { font-size: 10px; color: var(--fg-tertiary); font-family: var(--font-mono); }
.timeline .line { flex: 1; height: 1px; background: var(--border); margin: 0 12px; align-self: flex-start; margin-top: 4px; }
.timeline .line.done { background: var(--success); }

/* Chat Input — unified container.
   flex-shrink:0 is essential: as the textarea grows (drag-resize), the input
   area must expand to fit it so that .chat-messages (flex:1) shrinks in
   tandem. Without it the flex column can compress the input area, letting the
   textarea/controls overflow under the messages region. */
.chat-input-area { position: relative; flex-shrink: 0; border-top: 1px solid var(--border); padding: 12px 20px; background: var(--surface); transition: background var(--transition), border-color var(--transition); }
.chat-input-area.ended { display: flex; align-items: center; justify-content: center; padding: 14px 20px; }
.ended-text { color: var(--fg-tertiary); font-size: 13px; }

.chat-input-container { position: relative; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-xl); transition: border-color 0.15s, box-shadow 0.15s; }
.chat-input-container.focused { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-muted); }

.chat-textarea { width: 100%; background: none; border: none; color: var(--fg); font-size: 14px; font-family: var(--font-body); line-height: 1.5; outline: none; resize: none; padding: 12px 16px 4px; min-height: 60px; max-height: 400px; overflow-y: auto; }
/* Drag handle above the textarea — user drags up/down to resize; the handle
   rides the container's top edge and moves with it as height changes. */
.textarea-resize-handle { height: 6px; margin: 4px 8px 0; cursor: ns-resize; display: flex; align-items: center; justify-content: center; border-radius: 3px; transition: background 0.15s; }
.textarea-resize-handle::after { content: ''; width: 32px; height: 3px; border-radius: 2px; background: var(--border-light); transition: background 0.15s; }
.textarea-resize-handle:hover::after { background: var(--accent); }
.chat-textarea::placeholder { color: var(--fg-tertiary); }
.chat-textarea:disabled { opacity: 0.5; }

/* Bottom control row */
.input-controls { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px 12px; gap: 8px; }

/* Permission dropdown (left) */
.perm-dropdown { position: relative; }
.perm-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: none; border: none; color: var(--fg-secondary); font-size: 12px; cursor: pointer; border-radius: var(--radius-sm); transition: color 0.15s, background 0.15s; font-family: var(--font-body); }
.perm-trigger:hover { color: var(--fg); background: var(--surface-hover); }
.perm-label { font-weight: 500; }

/* Current model pill (right) */
.model-pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); cursor: default; max-width: 180px; }
.model-pill svg { flex-shrink: 0; }
.model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Effort dropdown (right) — mirrors .perm-dropdown */
.effort-dropdown { position: relative; }
.effort-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: none; border: none; color: var(--fg-secondary); font-size: 12px; cursor: pointer; border-radius: var(--radius-sm); transition: color 0.15s, background 0.15s; font-family: var(--font-body); }
.effort-trigger:hover { color: var(--fg); background: var(--surface-hover); }
.effort-label { font-weight: 500; }
.perm-menu { position: absolute; bottom: calc(100% + 4px); left: 0; min-width: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 4px 16px rgba(0,0,0,0.3); padding: 4px; z-index: 30; }
.perm-menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 10px; background: none; border: none; color: var(--fg); font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); transition: background 0.1s; font-family: var(--font-body); }
.perm-menu-item:hover { background: var(--surface-hover); }
.perm-menu-item.active { color: var(--accent); }
.perm-menu-item.active svg { color: var(--accent); }
.perm-menu-enter-active, .perm-menu-leave-active { transition: opacity 0.15s, transform 0.15s; }
.perm-menu-enter-from, .perm-menu-leave-to { opacity: 0; transform: translateY(4px); }

/* Right side: context + action button */
.input-right { display: flex; align-items: center; gap: 8px; }
.ctx-indicator { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); cursor: help; white-space: pre-line; }

.action-btn { width: 32px; height: 32px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s, opacity 0.15s; }
.send-btn { background: var(--accent); color: #fff; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { background: var(--border); color: var(--fg-tertiary); cursor: not-allowed; }
.stop-btn { background: var(--fg); color: var(--bg); }
.stop-btn:hover:not(:disabled) { opacity: 0.85; }
.stop-btn:disabled { background: var(--border); color: var(--fg-tertiary); cursor: not-allowed; }
.stop-btn.escalated { background: #e5484d; animation: stop-pulse 1s ease-in-out infinite; }
@keyframes stop-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }

/* Turn status bar: sits inside the message stream, visually part of it
   (left-aligned, same width as agent replies, no separating border). */
.turn-status-bar {
  animation: bar-in 0.2s ease;
  display: flex; align-items: center; gap: 10px;
  align-self: flex-start;
  max-width: 720px; width: fit-content;
  padding: 6px 2px;
  font-size: 12px; color: var(--fg-tertiary);
  animation: fade-in 0.3s ease;
}
.turn-status-bar .status-dot.working {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  animation: loading-bounce 1.2s ease-in-out infinite;
}
.turn-status-bar .status-check { color: var(--accent); flex-shrink: 0; }
.turn-status-bar .status-text { color: var(--fg-secondary); }
.turn-status-bar .status-timer {
  font-family: var(--font-mono); font-weight: 600; color: var(--fg);
}
.turn-status-bar .status-tokens { color: var(--fg-tertiary); }
.turn-status-bar .status-copy-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--fg-tertiary);
  background: none; border: none; cursor: pointer;
  border-radius: 4px; padding: 3px 8px;
  transition: color 0.15s, background 0.15s;
}
.turn-status-bar .status-copy-btn:hover { color: var(--fg); background: var(--surface-hover); }
@keyframes loading-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.2); }
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes bar-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 1024px) { .session-layout { height: calc(100vh - var(--topbar-h)); } }
@media (max-width: 768px) { .session-panel { display: none; } }
</style>
