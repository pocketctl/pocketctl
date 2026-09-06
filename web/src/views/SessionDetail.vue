<template>
  <div class="session-layout">
    <!-- Session List Panel -->
    <div class="session-panel">
      <div class="session-panel-header">
        <div class="session-panel-heading-copy">
          <h3>{{ uniqueHosts.length > 1 ? t('nav.sessions') : daemonName }}</h3>
          <span>{{ t('session.count_summary', { total: hostScopedSessions.length, running: runningSessionCount }) }}</span>
        </div>
        <button class="btn-icon session-new-button" :title="t('session.new_session')" @click="emitNewSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div v-if="!hasNoSessions" ref="agentFilterEl" class="agent-filter-popover">
        <button
          type="button"
          class="agent-filter-trigger"
          aria-haspopup="menu"
          :aria-expanded="agentFilterOpen"
          @click.stop="agentFilterOpen = !agentFilterOpen"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>
          <span class="agent-filter-trigger-label">{{ activeAgentFilter.label }}（{{ activeAgentFilter.count }}）</span>
          <svg class="agent-filter-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div v-if="agentFilterOpen" class="agent-filter-menu" role="menu" :aria-label="t('session.agent_filter_label')">
          <button
            v-for="option in agentFilterOptions"
            :key="option.value"
            type="button"
            class="agent-filter-option"
            role="menuitemradio"
            :aria-checked="selectedAgentType === option.value"
            :data-agent-filter="option.value"
            @click="selectAgentFilter(option.value)"
          >
            <svg class="agent-filter-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>
            <span class="agent-filter-option-label">{{ option.label }}</span>
            <span class="agent-filter-count">{{ option.count }}</span>
          </button>
        </div>
      </div>
      <div v-if="!hasNoSessions" class="session-panel-presence">
        <span :class="['status-dot', { online: isDaemonOnline }]"></span>
        <span class="session-panel-presence-copy">{{ isDaemonOnline ? t('dashboard.online') : t('dashboard.offline') }} · {{ statusSubtext }}</span>
      </div>
      <div class="session-list">
        <template v-for="s in visibleSessions" :key="s.session_id">
          <div :class="['session-list-item', { active: s.session_id === sessionId, 'pending-delete': (s as any).__pendingDelete, 'has-children': s.children && s.children.length }]"
            @click="!(s as any).__pendingDelete && $router.push(`/session/${s.session_id}`)">
            <span v-if="s.children && s.children.length" class="sl-fold" @click.stop="toggleFold(s.session_id)">{{ folded[s.session_id] ? '▾' : '▸' }}</span>
            <span :class="['status-dot', s.statusEffective || s.status]" style="width:7px;height:7px;"></span>
            <div class="sl-info">
              <div :class="['sl-title', { mono: !s.title || s.title.startsWith('Terminal Session') }]">
                <svg v-if="s.pinned" class="pin-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 4px;"><path d="M16 3l5 5-3 1-3 3-1 5-2-2-5 5-1-1 5-5-2-2 5-1 3-3z"/></svg>
                <input v-if="renamingId === s.session_id" class="ss-rename-input" v-model="renameInput" maxlength="60"
                  @click.stop @keydown.enter="commitRename(s)" @keydown.escape="cancelRename" @blur="commitRename(s)" />
                <template v-else>{{ s.title || s.session_id.slice(0, 8) }}</template>
              </div>
              <div class="sl-meta"><AgentBadge :agent="s.agent_type" size="sm" />{{ formatRelativeTime(s.last_activity_at || s.created_at) }}<span v-if="s.subagent_count > 0"> · {{ t('session.sub_agents', { n: s.subagent_count }) }}</span></div>
            </div>
            <SessionActions :session="s" @startRename="startRename" @deleted="onDeleted" @pinned="onPinned" />
          </div>
          <div v-if="s.children && s.children.length && folded[s.session_id]" class="sl-children">
            <div v-for="c in s.children" :key="c.agentId" class="sl-child" role="button" tabindex="0"
              :class="{ active: s.session_id === sessionId && c.agentId === focusedSubAgentId }"
              :title="c.title || c.agentId.slice(0, 8)"
              @click.stop="router.push(`/session/${s.session_id}?subagent=${c.agentId}`)"
              @keydown.enter="router.push(`/session/${s.session_id}?subagent=${c.agentId}`)">
              <span class="sl-child-indent">↳</span>
              <span class="sl-child-title">{{ c.title || c.agentId.slice(0, 8) }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Chat Main Area -->
    <div class="chat-area">
      <!-- The session list can arrive after the replay request on a direct URL. -->
      <div
        v-if="hasNoSessions && isLoading"
        class="session-history-loading"
        data-testid="session-history-loading"
        role="status"
        aria-live="polite"
      >
        <span class="session-history-spinner" aria-hidden="true"></span>
        <div class="session-history-loading-title">{{ t('session.loading_history') }}</div>
        <template v-if="isSlowLoading">
          <div class="session-history-loading-slow">{{ t('session.loading_slow') }}</div>
          <button
            type="button"
            class="session-history-retry"
            data-testid="session-history-retry"
            @click="retryHistory"
          >{{ t('common.retry') }}</button>
        </template>
      </div>

      <!-- Full-area empty state when no sessions exist at all -->
      <div v-else-if="hasNoSessions" class="chat-welcome">
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
      <div class="chat-toolbar" :style="{ position: 'relative', zIndex: toolbarOverflowOpen ? 50 : undefined }">
        <div class="session-toolbar-identity">
          <button
            type="button"
            class="session-toolbar-back"
            :title="focusedSubAgentId ? t('session.back_to_parent') : t('mobile.back_to_sessions')"
            :aria-label="focusedSubAgentId ? t('session.back_to_parent') : t('mobile.back_to_sessions')"
            @click="focusedSubAgentId ? router.push(`/session/${sessionId}`) : $router.push('/')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="session-toolbar-titles">
            <span v-if="focusedSubAgentId" class="session-toolbar-title" :title="`${sessionTitle || sessionId?.slice(0, 8)} › ${focusedSubAgentInfo?.title || focusedSubAgentId.slice(0, 8)}`">{{ sessionTitle || sessionId?.slice(0, 8) }} › {{ focusedSubAgentInfo?.title || focusedSubAgentId.slice(0, 8) }}</span>
            <span v-else class="session-toolbar-title" :title="sessionTitle || sessionId?.slice(0, 8)">{{ sessionTitle || sessionId?.slice(0, 8) }}</span>
            <span class="session-toolbar-host" :title="toolbarContextParts.join(' · ')">
              <template v-for="(part, index) in toolbarContextParts" :key="`${part}-${index}`">
                <i v-if="index" aria-hidden="true"></i><span>{{ part }}</span>
              </template>
            </span>
          </div>
        </div>
        <div class="session-toolbar-actions">
          <span :class="['status-pill', statusClass]"><span class="pulse"></span><span class="status-pill-label">{{ statusLabel }}</span></span>
        <div class="session-id-box">
          <code class="session-id-text">{{ sessionId?.slice(0, 8) }}</code>
          <button class="copy-btn" @click="copySessionId" :title="copied ? t('common.copied') : t('session.actions.copy_id')">
            <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </button>
        </div>
        </div>
      </div>

      <div ref="toolbarOverflowEl" :class="['toolbar-overflow', { 'mobile-session-toolbar-overflow': isMobile }]">
        <button type="button" class="toolbar-more-btn" :aria-label="t('session.actions.more')" :aria-expanded="toolbarOverflowOpen" @click.stop="toolbarOverflowOpen = !toolbarOverflowOpen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
        </button>
        <div v-if="toolbarOverflowOpen" class="toolbar-overflow-menu" role="menu">
          <div v-if="contextTokens || focusedSubAgentTokenTotal > 0 || parentTotalTokens !== null || currentModel || effortVisible" class="toolbar-overflow-metrics">
            <span v-if="!focusedSubAgentId && currentModel" class="toolbar-overflow-metric">{{ currentModel }}</span>
            <span v-if="!focusedSubAgentId && effortVisible" class="toolbar-overflow-metric">{{ effortLabel }}</span>
            <span v-if="contextTokens" class="toolbar-overflow-metric">{{ contextTokens }}</span>
            <span v-if="focusedSubAgentId && focusedSubAgentTokenTotal > 0" class="toolbar-overflow-metric">{{ fmtTk(focusedSubAgentTokenTotal) }}</span>
            <span v-if="!focusedSubAgentId && parentTotalTokens !== null" class="toolbar-overflow-metric">{{ fmtTk(parentTotalTokens) }}</span>
          </div>
          <button
            v-if="currentPlan && !focusedSubAgentId"
            type="button"
            data-toolbar-action="plan"
            :class="['toolbar-overflow-item', 'toolbar-overflow-action', 'plan-toolbar-button', { active: !isMobile && planPanelOpen, complete: planCompleted === currentPlan.items.length }]"
            role="menuitem"
            :aria-label="planButtonLabel"
            :aria-expanded="!isMobile && planPanelOpen"
            @click="togglePlanFromOverflow"
          >
            <span class="toolbar-overflow-item-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3.5 5 1.5 1.5L8 3.5M10 5h6M3.5 11 5 12.5 8 9.5M10 11h6M3.5 17 5 18.5l3-3M10 17h6" /></svg><span>{{ t('plan.title') }}</span></span>
            <code>{{ planCompleted }} / {{ currentPlan.items.length }}</code>
          </button>
          <button
            v-if="fileChangeMessages.length && !focusedSubAgentId"
            type="button"
            data-toolbar-action="edited-files"
            :class="['toolbar-overflow-item', 'toolbar-overflow-action', 'file-change-toolbar-button', { active: fileChangePanelOpen }]"
            role="menuitem"
            :aria-label="fileChangeButtonLabel"
            :aria-expanded="fileChangePanelOpen"
            @click="toggleFileChangeFromOverflow"
          >
            <span class="toolbar-overflow-item-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h12v13H4zM7 7h6M7 10h6M7 13h4" /></svg><span>{{ t('session.file_change_title') }}</span></span>
            <code>{{ fileChangeFileCount }}</code>
          </button>
          <div v-if="(currentPlan || fileChangeMessages.length) && !focusedSubAgentId" class="toolbar-overflow-separator"></div>
          <button type="button" class="toolbar-overflow-item" data-toolbar-action="copy-id" role="menuitem" @click="copySessionId"><span>{{ copied ? t('common.copied') : t('session.actions.copy_id') }}</span><code>{{ sessionId?.slice(0, 8) }}</code></button>
          <button v-if="!focusedSubAgentId && !isReadOnlyObserverSession" type="button" class="toolbar-overflow-item" data-toolbar-action="resume" role="menuitem" @click="copyResumeCmd"><span>{{ resumeCopied ? t('session.actions.resume_toast') : t('session.actions.resume') }}</span><code>resume</code></button>
        </div>
      </div>

      <!-- Messages -->
      <div
        ref="messagesEl"
        class="chat-messages"
        :style="{ '--composer-float-clearance': `${messageBottomClearance}px` }"
        @scroll="onMessagesScroll"
      >
        <div v-if="!composerState.visible" class="messages-bottom-spacer" aria-hidden="true"></div>
        <!-- Exit Banner -->
        <div v-if="status === 'exited'" class="banner banner-info" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span>{{ t('session.exited_banner') }}</span>
          <span v-if="exitReason" style="margin-left:4px;">· {{ exitReasonLabel(exitReason) }}</span>
          <button v-if="isDaemonOnline && !isReadOnlyObserverSession" class="btn btn-accent" style="margin-left:auto;padding:4px 12px;font-size:12px;" @click="focusResumeInput">Resume</button>
        </div>

        <!-- Disconnected Banner -->
        <div v-if="isDisconnected" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{{ t('session.daemon_offline') }}</span>
        </div>
        <!-- L1: send failed (ws not open at send time) -->
        <div v-if="sendError || interruptPendingDraft" class="banner banner-warning" style="flex-shrink:0;">
          <svg class="banner-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <span>{{ sendFailureKey ? t(sendFailureKey) : t('session.send_failed') }}</span>
          <button v-if="interruptPendingDraft" type="button" class="interrupt-pending-retry" @click="restoreInterruptPendingDraft">{{ t('common.retry') }}</button>
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

        <div
          v-if="isLoading && renderMessages.length === 0"
          class="session-history-loading"
          data-testid="session-history-loading"
          role="status"
          aria-live="polite"
        >
          <span class="session-history-spinner" aria-hidden="true"></span>
          <div class="session-history-loading-title">{{ t('session.loading_history') }}</div>
          <template v-if="isSlowLoading">
            <div class="session-history-loading-slow">{{ t('session.loading_slow') }}</div>
            <button
              type="button"
              class="session-history-retry"
              data-testid="session-history-retry"
              @click="retryHistory"
            >{{ t('common.retry') }}</button>
          </template>
        </div>

        <!-- Empty state when no messages -->
        <div v-else-if="renderMessages.length === 0" class="chat-empty-state">
          <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <div class="empty-title">{{ chatEmptyTitle }}</div>
          <div class="empty-desc">{{ chatEmptyDesc }}</div>
        </div>

        <!-- Messages -->
        <template v-for="msg in renderMessages" :key="msg.id">
          <div v-if="turnHeaderFor(msg)" class="turn-group-header" :data-turn-id="msg.turn_id" :data-turn-segment-id="turnHeaderFor(msg)?.id">
            <span class="turn-group-label">Turn</span>
            <span v-if="turnHeaderFor(msg)?.interrupted" class="turn-group-state">已中断</span>
            <span v-else-if="turnHeaderFor(msg)?.status" class="turn-group-state">{{ turnHeaderFor(msg)?.status }}</span>
            <span v-if="turnHeaderFor(msg)?.continuedAfterInterrupt" class="turn-group-continuation">中断后继续</span>
            <button v-if="turnHeaderFor(msg)?.auxiliary.length" type="button" class="turn-group-aux-toggle" :aria-expanded="isAuxiliaryExpanded(turnHeaderFor(msg)?.id)" :aria-label="`Turn ${msg.turn_id} 辅助流`" @click="toggleAuxiliary(turnHeaderFor(msg)?.id)">辅助流（{{ turnHeaderFor(msg)?.auxiliary.length }}）</button>
          </div>
          <template v-if="!isHiddenAuxiliary(msg) && !isToolGroupContinuation(msg)">
          <!-- User message (right bubble) -->
          <MessageUser
            v-if="msg.role === 'user'"
            :content="cleanContent(msg.content)"
            :data-delivery-status="msg.deliveryStatus || undefined"
          />

          <!-- Agent text message (full-width block) -->
          <MessageAgent
            v-else-if="msg.type === 'agent_text'"
            :content="cleanContent(msg.content)"
            :streaming="msg.streaming"
            :agent-type="focusedSubAgentId ? focusedSubAgentInfo?.agentType : currentSessionAgent"
          />

          <OpenCodeReasoningCard
            v-else-if="msg.type === 'agent_reasoning'"
            :content="msg.content"
            :streaming="msg.streaming"
          />

          <!-- AskUserQuestion (question card, not a tool card) -->
          <QuestionCard
            v-else-if="msg.type === 'tool_call' && msg.tool === 'AskUserQuestion'"
            :message="msg"
          />

          <FileChangeCard
            v-else-if="msg.type === 'agent_file_change' && isMobile"
            :message="msg"
            @open-mobile="openFileChangeSheet(msg, $event)"
          />

          <!-- Tool call / subagent (full-width block) -->
          <DiffCard
            v-else-if="msg.type === 'tool_call' && isDiffTool(msg.tool)"
            :message="msg"
            @toggleExpand="msg.expanded = !msg.expanded"
            @toggleOutput="msg.outputExpanded = !msg.outputExpanded"
          />
          <SubAgentFoldGroup
            v-else-if="msg.type === 'subagent' && !focusedSubAgentId"
            :agent-id="msg.tool"
            :title="msg.title || msg.input"
            :desc="msg.input"
            :agent-type="msg.agentType || ''"
            :token-usage="msg.tokenUsage || childrenToken[msg.tool]"
            :messages="subagentMessages[msg.tool] || []"
            :parent-title="sessionTitle || ''"
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

          <OpenCodePartCard
            v-else-if="isOpenCodeStructuredType(msg.type)"
            :message="msg"
          />

          <!-- Error message (full-width block) -->
          <MessageError v-else-if="msg.type === 'error'" :content="msg.content || msg.error" />

          <div v-else-if="msg.type === 'agent_retry'" class="opencode-notice">
            {{ t('session.opencode_retry', { n: msg.attempt || 1 }) }}<span v-if="msg.error"> · {{ msg.error }}</span>
          </div>
          <div v-else-if="msg.type === 'agent_compaction'" class="opencode-notice">
            {{ t(msg.auto ? 'session.opencode_compaction_auto' : 'session.opencode_compaction') }}<span v-if="msg.overflow"> · {{ t('session.opencode_compaction_overflow') }}</span>
          </div>
          <div v-else-if="msg.type === 'session_model_changed'" class="model-switch-notice" role="status">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>
            <span>{{ t('session.model_changed') }}</span>
            <code>{{ msg.content }}</code>
          </div>

          <!-- Command execution receipt -->
          <CommandReceiptCard v-else-if="msg.type === 'command_receipt'" :command="msg.command" :status="msg.receiptStatus" :message="msg.message" />

          <!-- Tool-use approval request (non-bypass sessions) -->
          <ApprovalCard
            v-else-if="msg.type === 'approval_request'"
            :data-request-id="msg.request_id"
            :data-status="msg.status"
            :message="msg"
            :supports-actions="interactionCapabilities.includes('permission_actions')"
            :trusted-policy="currentSessionCapabilities.includes('trusted_action_policy_v1')"
            :disabled="interactionCardsDisabled"
            :disabled-reason="interactionDisabledReason(msg)"
            @respond="onApprovalRespond"
            @resync="resyncInteractionState"
          />

          <OpenCodeQuestionCard
            v-else-if="msg.type === 'question_request'"
            :data-request-id="msg.request_id"
            :data-status="msg.status"
            :message="msg"
            :disabled="interactionCardsDisabled"
            :disabled-reason="interactionDisabledReason(msg)"
            @submit="onQuestionSubmit"
            @reject="onQuestionReject"
            @resync="resyncInteractionState"
          />

          <McpElicitationCard
            v-else-if="msg.type === 'mcp_elicitation_request'"
            :data-request-id="msg.request_id"
            :data-status="msg.status"
            :message="msg"
            :disabled="interactionCardsDisabled"
            :disabled-reason="interactionDisabledReason(msg)"
            @respond="onMcpElicitationRespond"
            @resync="resyncInteractionState"
          />

          <!-- PTY selection menu (host-hook confirmation, TUI prompt, etc.) -->
          <InteractiveChoiceCard
            v-else-if="msg.type === 'interactive_prompt'"
            :data-request-id="msg.request_id"
            :data-status="msg.status"
            :message="msg"
            :disabled="interactionCardsDisabled"
            :disabled-reason="interactionDisabledReason(msg)"
            @respond="onChoiceRespond"
            @resync="resyncInteractionState"
          />
          <div v-else-if="msg.type !== 'turn_status' && msg.type !== 'agent_file_change'" class="turn-unknown-event">{{ msg.content || msg.error || msg.type }}</div>
          </template>
        </template>

        <!-- Turn status bar: lives inside the message stream (visually part of
             it), below the last message. Live timer while working; on completion
             shows total duration + output tokens + a copy button. -->
        <div v-if="!focusedSubAgentId && (isExecuting || awaitingStart || lastTurnDuration !== null || completedBarVisible)" class="turn-status-bar" :class="{ done: lastTurnDuration !== null || completedBarVisible }">
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
            <span v-if="completedTurnEndedAt" class="status-ended-at" :title="completedTurnEndedAt">
              {{ t('session.ended_at', { time: formatDateTime(completedTurnEndedAt) }) }}
            </span>
          </template>
        </div>
      </div>

      <!-- Chat Input — unified container with embedded controls -->
      <div ref="composerEl" class="chat-input-area" :class="{ ended: !composerState.visible, 'composer-focused': isInputFocused }">
        <!-- Scroll-to-bottom: absolute child of chat-input-area, floats above
             its top edge. Doesn't take up flex space in chat-messages. -->
        <Transition name="scroll-btn">
          <button v-if="messages.length > 0 && !autoScroll" class="scroll-to-bottom" :title="t('session.scroll_to_bottom')" @click="scrollToBottom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
          </button>
        </Transition>
        <template v-if="composerState.visible">
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
              :style="{ height: composerTextareaHeight + 'px' }"
              :placeholder="isPendingSession ? t('session.input_creating') : (isDaemonSession && isTerminalStatus ? t('session.input_resume') : t('session.input_send'))"
              @keydown="onInputKeydown"
              @focus="handleComposerFocus"
              @blur="handleComposerBlur"
              :disabled="!composerState.editable || isPendingSession"
              ref="inputEl"
              :rows="isMobile ? 1 : 3"
            ></textarea>

            <!-- Bottom control row -->
            <div class="input-controls">
              <!-- Left: permission mode dropdown -->
              <div class="perm-dropdown" ref="permDropdownEl">
                <button class="perm-trigger" @click="showPermMenu = !showPermMenu" :disabled="!permissionCanChange" :title="t(currentPermLabel)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  <span class="perm-label">{{ pendingPermission ? t('session.permission.pending') : t(currentPermLabel) }}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <Transition name="perm-menu">
                  <div v-if="showPermMenu" class="perm-menu">
                    <button v-for="m in runtimePermissionOptions" :key="m.value" :disabled="m.disabled"
                      :class="['perm-menu-item', { active: currentPermissionValue === m.value }]"
                      @click="requestPermission(m.value); showPermMenu = false">
                      <span class="perm-menu-copy"><span class="perm-menu-name">{{ t(m.titleKey) }}</span><small>{{ t(m.descriptionKey) }}</small></span>
                      <svg v-if="currentPermissionValue === m.value" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                    </button>
                  </div>
                </Transition>
                <span v-if="permissionError" class="permission-error">{{ permissionError }}</span>
              </div>

              <!-- Session metadata: model + context usage -->
              <div class="input-meta">
                <SessionAgentPicker
                  v-if="showSessionAgentPicker"
                  :agents="sessionAgents"
                  :current-agent="currentOpenCodeAgent"
                  :loading="sessionAgentsLoading"
                  :error="sessionAgentError"
                  :disabled="sessionAgentDisabled"
                  :submitting="sessionAgentSubmitting"
                  @select="requestSessionAgentSwitch"
                  @retry="requestSessionAgents"
                />
                <!-- Current model (resolved from session_meta) -->
                <span v-if="currentModel" class="model-pill" :title="t('session.current_model') + ': ' + currentModel">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/></svg>
                  <span class="model-name">{{ currentModel }}</span>
                </span>

                <div v-if="contextTokens" class="ctx-indicator" :title="contextTooltip">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                  <span class="ctx-value">{{ contextTokens }}</span>
                </div>
              </div>

              <div class="input-actions">
                <!-- Send button (idle) -->
                <button v-if="!isExecuting" class="action-btn send-btn"
                  @click="sendMessage"
                  :disabled="!composerState.sendEnabled || isPendingSession || !messageInput.trim()"
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
                <!-- 停止操作错误提示:relay 返回 daemon_unreachable/session_not_found
                     时显示,3.5s 自动消失,不写入消息流。 -->
                <Transition name="fade">
                  <span v-if="stopError" class="stop-error-hint">{{ stopError }}</span>
                </Transition>
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="isSubagent || focusedSubAgentId" class="readonly-hint">{{ t('session.subagent_readonly') }}</div>
        <div v-else-if="isUnmanagedReadOnlySession" class="unmanaged-readonly-notice" role="note">
          <span class="unmanaged-readonly-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>
          </span>
          <span class="unmanaged-readonly-copy">
            <span class="unmanaged-readonly-heading">
              <strong>{{ t('session.unmanaged_readonly_title') }}</strong>
              <small>{{ t('session.unmanaged_readonly_badge') }}</small>
            </span>
            <span class="unmanaged-readonly-description">{{ unmanagedReadOnlyDescription }}</span>
          </span>
          <span class="unmanaged-readonly-agent">{{ unmanagedReadOnlyAgent }}</span>
        </div>
        <div v-else class="ended-text">{{ t('session.ended') }}</div>
      </div>
      </template><!-- /v-else hasNoSessions -->
    </div>
    <PlanSidePanel
      v-if="currentPlan && planPanelOpen && !focusedSubAgentId && !isMobile"
      :plan="currentPlan"
      :connected="connected !== false"
      @close="closePlanPanel"
    />
    <button
      v-if="fileChangeMessages.length && fileChangePanelOpen && !focusedSubAgentId"
      type="button"
      class="file-change-panel-backdrop"
      :aria-label="t('session.file_change_close')"
      @click="closeFileChangePanel"
    />
    <aside
      v-if="fileChangeMessages.length && fileChangePanelOpen && !focusedSubAgentId"
      class="file-change-side-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('session.file_change_edited_files', { n: fileChangeFileCount })"
    >
      <header class="file-change-panel-heading">
        <div>
          <h2>{{ t('session.file_change_edited_files', { n: fileChangeFileCount }) }}</h2>
          <span>+{{ fileChangeAdditions }} −{{ fileChangeDeletions }}</span>
        </div>
        <button type="button" class="file-change-panel-close" :aria-label="t('session.file_change_close')" @click="closeFileChangePanel">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <div class="file-change-panel-list">
        <FileChangeCard
          v-for="message in fileChangeMessages"
          :key="message.id"
          :message="message"
          @open-mobile="openFileChangeSheet(message, $event)"
        />
      </div>
    </aside>
    <FileChangeBottomSheet
      v-if="mobileFileChange"
      :message="mobileFileChange"
      :return-focus-to="fileChangeOpener"
      @close="closeFileChangeSheet"
    />
  </div>

  <NewSessionDialog
    v-if="showNewSession"
    :daemons="daemonList"
    :preSelectedDaemonId="selectedHostId"
    @close="showNewSession = false"
  />
  <CommandHelpModal
    v-if="showHelpModal"
    :commands="availableCommands"
    @close="showHelpModal = false"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { normalizeEffort, shouldShowEffort } from '../utils/effort'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import { useWebSocket } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { mergeLocalCommands, POCKETCTL_LOCAL_COMMANDS } from '../utils/commands'
import { mergeRevisionedPart } from '../utils/opencodePartMerge'
import { mergeStructuredPart, type OpenCodeStructuredType } from '../utils/opencodeStructuredMerge'
import { reconcileUnresolvedTools } from '../utils/toolState'
import SessionActions from '../components/SessionActions.vue'
import AgentBadge from '../components/AgentBadge.vue'
import CommandPopover from '../components/CommandPopover.vue'
import SessionAgentPicker from '../components/SessionAgentPicker.vue'
import CommandReceiptCard from '../components/CommandReceiptCard.vue'
import CommandHelpModal from '../components/CommandHelpModal.vue'
import MessageUser from '../components/messages/MessageUser.vue'
import MessageAgent from '../components/messages/MessageAgent.vue'
import MessageError from '../components/messages/MessageError.vue'
import { useLocale } from '../composables/useLocale'
import ToolCallCard from '../components/messages/ToolCallCard.vue'
import ToolCallGroup from '../components/messages/ToolCallGroup.vue'
import QuestionCard from '../components/messages/QuestionCard.vue'
import ApprovalCard from '../components/messages/ApprovalCard.vue'
import { trustedApprovalActions } from '../utils/trustedApprovalActions'
import OpenCodeQuestionCard from '../components/messages/OpenCodeQuestionCard.vue'
import McpElicitationCard from '../components/messages/McpElicitationCard.vue'
import OpenCodeReasoningCard from '../components/messages/OpenCodeReasoningCard.vue'
import OpenCodePartCard from '../components/messages/OpenCodePartCard.vue'
import InteractiveChoiceCard from '../components/messages/InteractiveChoiceCard.vue'
import DiffCard from '../components/messages/DiffCard.vue'
import FileChangeCard from '../components/messages/FileChangeCard.vue'
import FileChangeBottomSheet from '../components/messages/FileChangeBottomSheet.vue'
import SubAgentFoldGroup from '../components/messages/SubAgentFoldGroup.vue'
import { buildResumeCommand } from '../utils/resumeCommand'
import { isReadOnlyObserverAgent } from '../utils/observerSession'
import { resolveAgentTarget } from './classifyByAgent'
import { formatToolInput } from '../utils/toolDisplay'
import { isDiffTool } from '../utils/diffRender'
import { buildToolCallGrouping } from '../utils/toolGrouping'
import { formatTokenCount } from '../utils/tokenFormat'
import { agentDisplayName } from '../utils/agentDisplay'
import { useSessionRename } from '../composables/useSessionRename'
import type { CommandItem } from '../composables/useWebSocket'
import { canControlOpenCodeInteractions, isManagedOpenCodeSession, normalizeSessionAgents, resolveInteractionRequest, sessionAgentSwitchDisabled, shouldShowSessionAgentPicker, upsertInteractionRequest, type SessionAgentOption } from '../types/opencode-interactions'
import { expandCodexPreset, permissionOptions, permissionTitleKey, type AgentType, type ClaudeMode, type PermissionConfig } from '../types/permission'
import { useVisualViewport } from '../composables/useVisualViewport'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import { useSessionHeader } from '../composables/useSessionHeader'
import { normalizeRequestId, scrollToRequest } from '../utils/requestDeepLink'
import { resolveInteractionReadiness, type InteractionConnectivity } from '../composables/useInteractionReadiness'
import { canSendClaudeSession } from '../utils/claudeSessionControl'
import { resolveSessionComposerState } from '../utils/sessionComposerPolicy'
import { ContentStreamAssembler } from '../utils/contentStream'
import { createLiveSessionEventBatcher } from '../utils/liveSessionEventBatcher'
import { ReplaySessionTrustBuffer, type ReplaySessionTrustContext } from '../utils/replaySessionTrust'
import { useAgentPlanProgress } from '../composables/useAgentPlanProgress'
import PlanSidePanel from '../components/plan/PlanSidePanel.vue'
import { completedPlanItemCount } from '../utils/agentPlanMerge'
import { createAgentFileChangeReducer, type AgentFileChangeMessage } from '../utils/agentFileChange'
import { projectTurns, TurnSegmentCollapseRegistry, TurnSegmentIdentityRegistry } from '../utils/turnProjection'
import { isKnownNonTimelineControlEvent, knownNonTimelineControlEventTypes, unknownTimelineEventIdentity } from '../utils/timelineEventRegistry'
import { createClientId } from '../utils/clientId'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()

const route = useRoute()
const router = useRouter()
useVisualViewport()
const { isMobile } = useResponsiveLayout()
const { setSessionHeader, clearSessionHeader } = useSessionHeader()
const { connect, send, sendUserMessage, onEvent, connected, reconnecting } = useWebSocket()
const { t } = useLocale()

const sessionId = computed(() => route.params.id as string)
const { acceptAgentPlan, planForSession } = useAgentPlanProgress()
const currentPlan = planForSession(sessionId)
const planPanelOpen = ref(localStorage.getItem('pocketctl_plan_panel_open') === 'true')
const toolbarOverflowOpen = ref(false)
const toolbarOverflowEl = ref<HTMLElement | null>(null)
const agentFilterOpen = ref(false)
const agentFilterEl = ref<HTMLElement | null>(null)
const selectedAgentType = ref('all')
const planCompleted = computed(() => currentPlan.value ? completedPlanItemCount(currentPlan.value) : 0)
const planButtonLabel = computed(() => currentPlan.value
  ? t('plan.open', { completed: planCompleted.value, total: currentPlan.value.items.length })
  : '')
function setPlanPanelOpen(open: boolean) {
  planPanelOpen.value = open
  localStorage.setItem('pocketctl_plan_panel_open', String(open))
  if (open) fileChangePanelOpen.value = false
}
function togglePlanPanel() { setPlanPanelOpen(!planPanelOpen.value) }
function togglePlanFromOverflow() {
  if (isMobile.value) {
    setFileChangePanelOpen(false)
    window.dispatchEvent(new CustomEvent('pocketctl:open-mobile-session-plan'))
  } else {
    togglePlanPanel()
  }
  toolbarOverflowOpen.value = false
}
function closePlanPanel() { setPlanPanelOpen(false) }
const fileChangePanelOpen = ref(false)
const fileChangeMessages = computed(() => messages.value.filter((message: any) => message.type === 'agent_file_change'))
const fileChangeFileCount = computed(() => fileChangeMessages.value.reduce((total, message) => total + message.fileChange.files.length, 0))
const fileChangeAdditions = computed(() => fileChangeMessages.value.reduce((total, message) => total + message.fileChange.additions, 0))
const fileChangeDeletions = computed(() => fileChangeMessages.value.reduce((total, message) => total + message.fileChange.deletions, 0))
const fileChangeButtonLabel = computed(() => t('session.file_change_edited_files', { n: fileChangeFileCount.value }))
function setFileChangePanelOpen(open: boolean) {
  fileChangePanelOpen.value = open
  if (open) setPlanPanelOpen(false)
}
function toggleFileChangePanel() { setFileChangePanelOpen(!fileChangePanelOpen.value) }
function toggleFileChangeFromOverflow() {
  toggleFileChangePanel()
  toolbarOverflowOpen.value = false
}
function closeFileChangePanel() { setFileChangePanelOpen(false) }
function onFileChangePanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && fileChangePanelOpen.value) closeFileChangePanel()
  if (event.key === 'Escape' && toolbarOverflowOpen.value) toolbarOverflowOpen.value = false
  if (event.key === 'Escape' && agentFilterOpen.value) agentFilterOpen.value = false
}
const mobileFileChange = ref<AgentFileChangeMessage | null>(null)
const fileChangeOpener = ref<HTMLElement | null>(null)
function openFileChangeSheet(message: AgentFileChangeMessage, opener: HTMLElement) {
  mobileFileChange.value = message
  fileChangeOpener.value = opener
}
function closeFileChangeSheet() {
  mobileFileChange.value = null
}
const messages = ref<any[]>([])
const openCodeStructuredTypes = new Set<OpenCodeStructuredType>(['agent_file', 'agent_patch', 'agent_todo', 'agent_subtask', 'agent_profile'])
function isOpenCodeStructuredType(type: string): type is OpenCodeStructuredType {
  return openCodeStructuredTypes.has(type as OpenCodeStructuredType)
}
// Every named live consumer below is excluded from the generic subscription,
// so a websocket broadcast can never render it twice. Keep this complete even
// for non-rendering session handlers: unknown future event types need not carry
// classification metadata to get a visible fallback row.
const explicitlyRoutedLiveEventTypes = new Set<string>([
  ...knownNonTimelineControlEventTypes,
  'connection_restored', 'session_list', 'session_created', 'daemon_list',
  'daemon_status', 'command_list', 'session_agent_list', 'session_agent_changed',
  'session_meta', 'session_model_changed', 'replay_batch', 'replay_end',
  'user_message_ack', 'user_message_nack', 'user_message_receipt',
  'user_text', 'agent_text', 'agent_plan', 'agent_reasoning', 'agent_retry',
  'agent_compaction', 'agent_file_change', ...openCodeStructuredTypes,
  'tool_call', 'tool_result', 'approval_request', 'approval_resolved',
  'question_request', 'question_resolved', 'mcp_elicitation_request',
  'mcp_elicitation_resolved', 'interactive_prompt', 'turn_status', 'error',
  'command_receipt', 'interaction_result', 'subagent_discovered',
  'subagent_title_update', 'subagent_usage', 'permission_config_changed',
  'session_status', 'session_title_update', 'session_deleted', 'session_pinned',
  'session_id_changed',
])
const allSessions = ref<any[]>([])
// P2: per-agent message buckets for sub-agent events (keyed by agentId)
const subagentMessages = ref<Record<string, any[]>>({})
// P1a: children token map keyed by agentId
const childrenToken = ref<Record<string, { tokenIn: number; tokenOut: number; tokenCache: number; tokenCacheCreate: number }>>({})
const messageInput = ref('')
const commandsCache = ref<CommandItem[]>([])
const currentModel = ref('')            // resolved model name from session_meta event
const currentEffort = ref('')           // thinking-effort level from session_meta (low/medium/high/xhigh/max/ultracode)
const interactionCapabilities = ref<string[]>([])
const sessionAgents = ref<SessionAgentOption[]>([])
const currentOpenCodeAgent = ref('')
const sessionAgentsLoading = ref(false)
const sessionAgentError = ref('')
const sessionAgentSubmitting = ref(false)
const showHelpModal = ref(false)        // /help local command → full-screen modal
const replayReqId = ref(0)
const isLoading = ref(false)
const isSlowLoading = ref(false)
const HISTORY_SLOW_THRESHOLD_MS = 8_000
let historySlowTimer: ReturnType<typeof setTimeout> | null = null
// session-history-pagination: backward pagination state
const pageSize = computed(() => 50)  // session-history-pagination: 一次加载 50 条（平衡首屏/翻页性能）
const loadedMinId = ref(0)      // oldest loaded event id (backward cursor)
const isLoadingBackward = ref(false)  // a pagination (scroll-up) request in flight
const hasMore = ref(false)      // relay signaled older events exist
// One trust buffer spans every sequential replay page for this load. Pages do
// not overlap, so sharing it also carries explicit session-ID aliases from the
// newest page into older history without mixing event ordering.
const replayTrustEvents = new ReplaySessionTrustBuffer<any>()
const progressiveReplayEvents = replayTrustEvents
const olderReplayEvents = replayTrustEvents
function resetReplayTrustBuffers() {
  replayTrustEvents.reset()
}
let olderReplayScrollHeight = 0
let olderReplayScrollTop = 0
const resumeCopied = ref(false)  // session-resume-command: 复制恢复命令反馈
const showNewSession = ref(false)
const daemonList = computed(() => Object.values(daemons.value))
const currentSession = computed(() => allSessions.value.find((x: any) => x.session_id === sessionId.value))
const isManagedSession = computed(() => currentSession.value?.control_mode === 'managed')
const currentSessionAgent = computed(() => { const s: any = currentSession.value; return s?.agent_type || s?.agent || '' })
const currentSessionCapabilities = computed(() => interactionCapabilities.value.length > 0
  ? interactionCapabilities.value
  : (Array.isArray(currentSession.value?.capabilities) ? currentSession.value.capabilities : []))
const supportsMessageAcceptanceReceipt = computed(() =>
  currentSessionCapabilities.value.includes('message_acceptance_receipt'))
const isManagedOpenCode = computed(() => isManagedOpenCodeSession(
  currentSessionAgent.value,
  currentSession.value?.control_mode,
  currentSessionCapabilities.value,
))
const isLegacyOpenCodeSession = computed(() => currentSessionAgent.value === 'opencode' && !isManagedOpenCode.value)
// Observer sessions are read-only sync from their local stores. They
// can be viewed but never driven: no composer, no stop/approval/permission, no
// resume command (see buildResumeCommand). Used as a fail-closed gate for
// canWriteWhenConnected and the read-only banner.
const isReadOnlyObserverSession = computed(() => isReadOnlyObserverAgent(currentSessionAgent.value))
const interactionCardsDisabled = computed(() => isReadOnlyObserverSession.value || isDisconnected.value || (
  interactionConnectivity.value !== 'ready' || (
  currentSessionAgent.value === 'opencode'
  && !canControlOpenCodeInteractions(currentSessionAgent.value, currentSession.value?.control_mode, currentSessionCapabilities.value)
)))
const normalizedEffort = computed(() => normalizeEffort(currentEffort.value))
const effortVisible = computed(() => shouldShowEffort(currentSessionAgent.value || '', currentEffort.value))
const effortLabel = computed(() => {
  const known: Record<string, string> = {
    minimal: t('session.effort.minimal'), low: t('session.effort.low'), medium: t('session.effort.medium'),
    high: t('session.effort.high'), xhigh: t('session.effort.xhigh'), max: t('session.effort.max'), ultracode: 'Ultracode',
  }
  return known[normalizedEffort.value] || currentEffort.value.trim()
})
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
const sendFailureKey = ref('')
const interruptPendingDraft = ref('')
// Relay forwarding is acknowledged per prompt. Managed Codex prompts carrying
// message_acceptance_receipt then wait for a second, app-server acceptance event.
const pendingAckTimers = new Map<string, ReturnType<typeof setTimeout>>()
const exitReason = ref('')
const currentPermission = ref<PermissionConfig>()
const pendingPermission = ref<PermissionConfig>()
const permissionMutable = ref(false)
const permissionMutableModes = ref<string[]>([])
const permissionError = ref('')
let permissionTimer: ReturnType<typeof setTimeout> | null = null
const showPermMenu = ref(false)
const runtimePermissionOptions = computed(() => permissionOptions(currentSessionAgent.value as AgentType, false, permissionMutableModes.value))
const currentPermissionValue = computed(() => currentPermission.value?.agent === 'claude-code' ? currentPermission.value.mode : currentPermission.value?.preset || '')
const currentPermLabel = computed(() => permissionTitleKey(currentPermission.value))
const permissionCanChange = computed(() => !isReadOnlyObserverSession.value && permissionMutable.value && !isExecuting.value && !isDisconnected.value && !pendingPermission.value)
const exitedAt = ref('')
const autoScroll = ref(true)
const copied = ref(false)
const messagesEl = ref<HTMLDivElement | null>(null)
const composerEl = ref<HTMLElement | null>(null)
const composerHeight = ref(0)
const composerFloatClearance = computed(() => Math.max(
  isMobile.value ? 112 : 156,
  composerHeight.value + 16,
))
const inputEl = ref<HTMLTextAreaElement | null>(null)
const permDropdownEl = ref<HTMLElement | null>(null)
const isInputFocused = ref(false)
// Textarea height (user-adjustable via drag handle, resets on page refresh)
const DEFAULT_TEXTAREA_HEIGHT = 72  // ~3 rows
const MIN_TEXTAREA_HEIGHT = 60
const MAX_TEXTAREA_HEIGHT = 400
const MOBILE_MIN_TEXTAREA_HEIGHT = 50
const MOBILE_FOCUSED_MIN_TEXTAREA_HEIGHT = 46
const MOBILE_MAX_TEXTAREA_HEIGHT = 112
const textareaHeight = ref(DEFAULT_TEXTAREA_HEIGHT)
const mobileTextareaHeight = ref(MOBILE_MIN_TEXTAREA_HEIGHT)
const composerTextareaHeight = computed(() => isMobile.value ? mobileTextareaHeight.value : textareaHeight.value)
const daemons = ref<Record<string, any>>({})

function setDaemonConnectivity(daemonId: string, online: boolean, update: any = {}) {
  if (!daemonId) return
  const previous = daemons.value[daemonId] || {}
  daemons.value[daemonId] = {
    ...previous,
    daemon_id: daemonId,
    hostname: update.hostname || previous.hostname,
    alias: update.alias || previous.alias,
    online,
    ...(online ? {} : { last_seen_at: update.last_seen_at || previous.last_seen_at }),
  }
  for (const session of allSessions.value) {
    if (session.daemon_id === daemonId) session.daemon_online = online
  }
}
// Local host selection state (initialized from URL ?host= for backward compat)
const selectedHostId = ref((route.query.host as string) || '')
// Unique hosts derived from sessions that have arrived
const uniqueHosts = computed(() => {
  const seen = new Set<string>()
  const hosts: { daemon_id: string; name: string; online: boolean }[] = []
  for (const s of allSessions.value) {
    if (seen.has(s.daemon_id)) continue
    seen.add(s.daemon_id)
    const d = daemons.value[s.daemon_id]
    hosts.push({
      daemon_id: s.daemon_id,
      name: d?.daemon_alias || d?.hostname || s.daemon_alias || s.hostname || s.daemon_id?.slice(0, 8) || '',
      online: s.daemon_online ?? d?.online ?? false,
    })
  }
  return hosts
})
const hostScopedSessions = computed(() => {
  if (!selectedHostId.value) return allSessions.value
  return allSessions.value.filter((s: any) => s.daemon_id === selectedHostId.value)
})
function normalizedAgentType(session: any): string {
  const raw = String(session?.agent_type || session?.agent || 'claude-code').toLowerCase()
  return raw === 'claude' ? 'claude-code' : raw
}
const agentFilterOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const session of hostScopedSessions.value) {
    const agent = normalizedAgentType(session)
    counts.set(agent, (counts.get(agent) || 0) + 1)
  }
  const order = ['codex', 'codex-desktop', 'zcode', 'opencode', 'claude-code']
  const agents = [...counts.keys()].sort((left, right) => {
    const leftIndex = order.indexOf(left)
    const rightIndex = order.indexOf(right)
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right)
    if (leftIndex === -1) return 1
    if (rightIndex === -1) return -1
    return leftIndex - rightIndex
  })
  return [
    { value: 'all', label: t('session.agent_filter_all'), count: hostScopedSessions.value.length },
    ...agents.map(value => ({ value, label: agentDisplayName(value), count: counts.get(value) || 0 })),
  ]
})
const activeAgentFilter = computed(() => agentFilterOptions.value.find(option => option.value === selectedAgentType.value) || agentFilterOptions.value[0])
const visibleSessions = computed(() => {
  if (selectedAgentType.value === 'all') return hostScopedSessions.value
  return hostScopedSessions.value.filter((session: any) => normalizedAgentType(session) === selectedAgentType.value)
})
const runningSessionCount = computed(() => hostScopedSessions.value.filter((session: any) => ['running', 'busy', 'retry'].includes(session.statusEffective || session.status)).length)
function selectAgentFilter(agent: string) {
  selectedAgentType.value = agent
  agentFilterOpen.value = false
}

// subagent 折叠组：sidebar 会话列表展开/收起子代理
const folded = ref<Record<string, boolean>>({})
function toggleFold(id: string) { folded.value[id] = !folded.value[id] }

// Auto-select the first host when sessions first arrive and nothing is selected
watch(uniqueHosts, (hosts) => {
  if (hosts.length > 0 && !selectedHostId.value) {
    selectedHostId.value = hosts[0].daemon_id
  }
}, { immediate: true })

watch(agentFilterOptions, (options) => {
  if (!options.some(option => option.value === selectedAgentType.value)) selectedAgentType.value = 'all'
})

// When navigating directly to a session that belongs to a different host, follow it
watch(() => sessionId.value, (sid) => {
  if (!sid || sid.startsWith('pending-')) return
  const s = allSessions.value.find((s: any) => s.session_id === sid)
  if (s?.daemon_id && s.daemon_id !== selectedHostId.value) {
    selectedHostId.value = s.daemon_id
  }
  if (s && selectedAgentType.value !== 'all' && normalizedAgentType(s) !== selectedAgentType.value) {
    selectedAgentType.value = 'all'
  }
})

const statusClass = computed(() => {
  const map: Record<string, string> = { running: 'running', busy: 'running', retry: 'running', idle: 'running', completed: '', error: '', killed: '', disconnected: '', exited: '' }
  return map[status.value] || ''
})

const statusLabel = computed(() => {
  const STATUS_KEYS: Record<string, string> = { running: 'session.status.running', busy: 'session.status.busy', retry: 'session.status.retry', idle: 'session.status.idle', completed: 'session.status.completed', error: 'session.status.error', killed: 'session.status.killed', disconnected: 'session.status.disconnected', exited: 'session.status.exited' }
  return t(STATUS_KEYS[status.value] || 'session.status.running')
})

const isDaemonOnline = computed(() => {
  if (selectedHostId.value) {
    const d = daemons.value[selectedHostId.value]
    if (d?.online !== undefined) return d.online
    return allSessions.value.some((s: any) => s.daemon_id === selectedHostId.value && s.daemon_online)
  }
  const s = allSessions.value.find((s: any) => s.session_id === sessionId.value)
  return s?.daemon_online ?? true
})

const isDisconnected = computed(() => !isDaemonOnline.value)
const interactionConnectivity = computed<InteractionConnectivity>(() => {
  if (isDisconnected.value) return 'offline'
  if (!connected.value) return reconnecting.value ? 'connecting' : 'offline'
  if (isLoading.value) return 'syncing'
  return 'ready'
})
function interactionDisabledReason(message: any): string {
  const readiness = resolveInteractionReadiness({
    connectivity: interactionConnectivity.value,
    requestStatus: message.status,
    submitting: !!message.submitting,
    resultUnknown: !!message.resultUnknown,
    resolvedElsewhere: message.reason === 'resolved_elsewhere',
  })
  return readiness.reasonKey ? t(readiness.reasonKey) : ''
}
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
const isTerminalStatus = computed(() => ['exited', 'completed', 'error', 'killed'].includes(status.value))
// Daemon-created sessions can be resumed with their agent CLI even after completion,
// so the input box stays available as long as the daemon is online.
const isDaemonSession = computed(() => {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value)
  return s?.source === 'daemon'
})
// Sub-agent sessions are read-only (no input box — continue in the parent session)
const isSubagent = computed(() => !!allSessions.value.find((s: any) => s.session_id === sessionId.value)?.is_subagent)

// Focused sub-agent detail view (?subagent=<agentId>): read-only full-screen
// replay of one sub-agent's conversation. The agent_id comes from the URL
// query (set when clicking a child row in any list); the authoritative
// title/agentType/token/status come from session_list's children[].
const focusedSubAgentId = computed(() => (route.query.subagent as string) || '')
const showSessionAgentPicker = computed(() => !isReadOnlyObserverSession.value && shouldShowSessionAgentPicker(
  currentSessionAgent.value,
  interactionCapabilities.value,
  isSubagent.value,
  !!focusedSubAgentId.value,
))
const sessionAgentDisabled = computed(() => sessionAgentSwitchDisabled(
  status.value,
  isDisconnected.value,
  sessionAgentSubmitting.value,
))
const focusedSubAgentInfo = computed(() => {
  if (!focusedSubAgentId.value) return null
  const p = allSessions.value.find((s: any) => s.session_id === sessionId.value)
  return p?.children?.find((c: any) => c.agentId === focusedSubAgentId.value) || null
})
// Token total for the focused sub-agent (input+output+cache+cacheCreate), from
// the authoritative session_list children[] entry.
const focusedSubAgentTokenTotal = computed(() => {
  const c: any = focusedSubAgentInfo.value
  if (!c) return 0
  return (c.tokenIn || 0) + (c.tokenOut || 0) + (c.tokenCache || 0) + (c.tokenCacheCreate || 0)
})
// Render source: the focused sub-agent's bucket when focusing, else parent messages.
const renderMessages = computed(() =>
  focusedSubAgentId.value ? (subagentMessages.value[focusedSubAgentId.value] || []) : messages.value,
)
const toolGrouping = computed(() => buildToolCallGrouping(renderMessages.value))
function toolGroupFor(message: any): any[] | undefined {
  return toolGrouping.value.groups.get(message)
}
function isToolGroupContinuation(message: any): boolean {
  return toolGrouping.value.continuations.has(message)
}
// Projection happens only after the established root/subagent bucket selection.
// It is display-only; reducers and replay storage retain their original order.
const turnSegmentIdentityRegistry = new TurnSegmentIdentityRegistry()
const turnSegmentCollapseRegistry = new TurnSegmentCollapseRegistry()
const turnSegmentContext = computed(() => ({
  sessionId: sessionId.value || '', focusedAgentId: focusedSubAgentId.value || undefined,
}))
const turnCollapseRevision = ref(0)
const turnRows = computed(() => {
  const rows = turnSegmentIdentityRegistry.reconcile(projectTurns(renderMessages.value), turnSegmentContext.value)
  turnSegmentCollapseRegistry.reconcile(new Set(rows.flatMap(row => row.kind === 'turn' ? [row.id] : [])), turnSegmentContext.value)
  return rows
})
const turnMessageProjection = computed(() => {
  const rows = new Map<any, { row: any; main: boolean }>()
  for (const row of turnRows.value) {
    if (row.kind !== 'turn') continue
    const main = new Set(row.main)
    for (const message of row.messages) rows.set(message, { row, main: main.has(message) })
  }
  return rows
})
function turnHeaderFor(message: any) {
  const row = turnMessageProjection.value.get(message)?.row
  return row?.messages[0] === message ? row : null
}
function isAuxiliaryExpanded(segmentId?: string): boolean {
  void turnCollapseRevision.value
  return !segmentId || !turnSegmentCollapseRegistry.isCollapsed(segmentId, turnSegmentContext.value)
}
function toggleAuxiliary(segmentId?: string): void {
  if (!segmentId) return
  turnSegmentCollapseRegistry.toggle(segmentId, turnSegmentContext.value)
  turnCollapseRevision.value++
}
function isHiddenAuxiliary(message: any): boolean {
  const entry = turnMessageProjection.value.get(message)
  return !!entry && !entry.main && !isAuxiliaryExpanded(entry.row.id)
}
const requestDeepLinkId = computed(() => normalizeRequestId(route.query.request_id))
watch(
  [
    requestDeepLinkId,
    () => renderMessages.value.map((message: any) => `${message.request_id || ''}:${message.status || ''}`).join('|'),
  ],
  async ([requestId]) => {
    if (!requestId) return
    await nextTick()
    if (messagesEl.value) scrollToRequest(messagesEl.value, requestId)
  },
  { immediate: true },
)
const canWriteWhenConnected = computed(() => {
  // Fail-closed agent gate: permanent observer sessions can NEVER be written
  // to, regardless of status, source, control_mode, or capabilities. This check
  // takes precedence over every other writeability rule.
  if (isReadOnlyObserverSession.value) {
    return false
  }
  if (currentSessionAgent.value === 'claude-code') {
    return !focusedSubAgentId.value && canSendClaudeSession({
      status: status.value,
      source: currentSession.value?.source || '',
      daemonOnline: true,
      isSubagent: isSubagent.value,
      isManagedSession: isManagedSession.value,
      capabilities: currentSessionCapabilities.value,
    })
  }
  // A Codex rollout seen by the native JSONL watcher is observational only:
  // its `control_mode` can be stale or ambiguous, but it has no PocketCtl
  // app-server backend that can accept a prompt from another device. The
  // acceptance receipt is emitted only by the shim-managed backend, so require
  // it before rendering a multi-device composer for Codex.
  if (currentSessionAgent.value === 'codex') {
    return isManagedSession.value
      && supportsMessageAcceptanceReceipt.value
      && !isSubagent.value
      && !focusedSubAgentId.value
  }
  return (!isTerminalStatus.value || isDaemonSession.value || isManagedSession.value)
    && !isSubagent.value
    && !focusedSubAgentId.value
    && (currentSessionAgent.value !== 'opencode' || isManagedOpenCode.value)
})
const composerState = computed(() => resolveSessionComposerState(
  canWriteWhenConnected.value,
  interactionConnectivity.value,
))
const isUnmanagedReadOnlySession = computed(() => !!currentSession.value
  && (isReadOnlyObserverSession.value || currentSession.value?.source !== 'daemon')
  && !canWriteWhenConnected.value
  && !isSubagent.value
  && !focusedSubAgentId.value)
const unmanagedReadOnlyAgent = computed(() => agentDisplayName(normalizedAgentType(currentSession.value)))
const unmanagedReadOnlyDescription = computed(() => {
  if (isLegacyOpenCodeSession.value) return t('session.opencode_legacy_readonly')
  if (currentSessionAgent.value === 'zcode') return t('session.zcode_observer_readonly')
  return t('session.unmanaged_readonly_description', { agent: unmanagedReadOnlyAgent.value })
})
const messageBottomClearance = computed(() => composerState.value.visible
  ? composerFloatClearance.value
  : (isUnmanagedReadOnlySession.value ? (isMobile.value ? 128 : 96) : 52))
const canInput = computed(() => composerState.value.sendEnabled)
// Agent is actively generating (send button → stop button)
// Agent is actively working — includes 'waiting' (tool execution in progress),
// otherwise the timer would stop prematurely when a tool call is running.
const isExecuting = computed(() => status.value === 'running' || status.value === 'busy' || status.value === 'retry' || status.value === 'waiting')

// --- Turn timer (status bar above the input area) ---
// Timer is driven entirely by isExecuting transitions: starts on false→true
// (covers both sendMessage and new-session-with-prompt, which bypasses
// sendMessage), stops on true→false (whole turn done, incl. tool calls).
// sessionSwitching gates the watch during a session change: the placeholder
// status='running' (set in the sessionId watcher before replay) must NOT start
// the timer from zero. The real turn start is recovered from the last
// authoritative turn_started_at once replay completes.
const turnStartTime = ref<number | null>(null)   // 本轮开始时间戳
const turnElapsed = ref(0)                        // 实时计时（秒）
const lastTurnDuration = ref<number | null>(null) // 完成后的总耗时（秒）
const lastTurnEndedAt = ref('')                    // 服务端确认的本轮结束时刻
let turnTimer: ReturnType<typeof setInterval> | null = null
let sessionSwitching = false                        // true while switching sessions (suppress timer)
let resumeStartAt: number | null = null           // turn start recovered from replay (ms epoch)

function startTurnTimer(startAt?: number) {
  if (turnTimer) clearInterval(turnTimer)
  // startAt (ms) recovers accumulated time when resuming a running turn on
  // session switch; default (now) for a fresh turn triggered by sendMessage.
  turnStartTime.value = startAt ?? Date.now()
  lastTurnDuration.value = null
  lastTurnEndedAt.value = ''
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
// A reload has no in-memory transition to populate lastTurnEndedAt. In that
// case the materialized session activity time is the persisted end timestamp.
const completedTurnEndedAt = computed(() => lastTurnEndedAt.value || (
  completedBarVisible.value ? currentSession.value?.last_activity_at || '' : ''
))

function fmtTokens(n: number): string {
  return formatTokenCount(n)
}
// Format a duration (seconds) as Xs / Xm Ys / Xh Ym Zs for the turn timer.
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`
}

function formatDateTime(ts: string): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => value.toString().padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  const id = selectedHostId.value
  if (id) {
    const d = daemons.value[id]
    if (d) return d.daemon_alias || d.hostname || id.slice(0, 8)
    const s = allSessions.value.find((s: any) => s.daemon_id === id)
    return s?.daemon_alias || s?.hostname || id.slice(0, 8)
  }
  const s = allSessions.value.find((s: any) => s.session_id === sessionId.value)
  return s?.daemon_alias || s?.hostname || s?.daemon_id?.slice(0, 8) || t('session.unknown_host')
})

const toolbarContextParts = computed(() => {
  const parts = [currentSessionAgent.value ? agentDisplayName(normalizedAgentType(currentSession.value)) : '', daemonName.value]
  if (!focusedSubAgentId.value && currentModel.value) parts.push(currentModel.value)
  if (!focusedSubAgentId.value && effortVisible.value && effortLabel.value) parts.push(effortLabel.value)
  return parts.filter(Boolean)
})

const sessionTitle = computed(() => {
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  return s?.title
})

const mobileSessionTitle = computed(() => focusedSubAgentId.value
  ? focusedSubAgentInfo.value?.title || focusedSubAgentId.value.slice(0, 8)
  : sessionTitle.value || sessionId.value?.slice(0, 8) || '')

watch([mobileSessionTitle, daemonName, selectedHostId, status, statusLabel], () => {
  setSessionHeader({
    title: mobileSessionTitle.value,
    host: daemonName.value,
    hostId: selectedHostId.value,
    status: status.value,
    statusLabel: statusLabel.value,
  })
}, { immediate: true })

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
    return formatTokenCount(total)
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

// P1a: parent total tokens (includes subagent tokens) from session_list
const parentTotalTokens = computed(() => {
  const s = allSessions.value.find((s: any) => s.session_id === sessionId.value)
  return (s as any)?.totalTokens ?? null
})
function fmtTk(n: number) {
  return formatTokenCount(n)
}

const milestones = computed(() => {
  const ms: any[] = []
  const s = allSessions.value.find(s => s.session_id === sessionId.value)
  if (!s) return ms
  if (s.created_at) ms.push({ label: t('session.milestone_created'), time: formatTime(s.created_at), state: 'active' })
  ms.push({ label: t('session.status.running'), time: formatTime(s.last_activity_at || s.created_at), state: status.value === 'running' || status.value === 'busy' || status.value === 'retry' ? 'current' : 'active' })
  ms.push({ label: statusLabel.value, time: '—', state: isTerminalStatus.value ? 'active' : '' })
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
  const cmd = buildResumeCommand({
    agent: (s as any).agent,
    agent_type: (s as any).agent_type,
    cwd: (s as any).cwd,
    session_id: sessionId.value,
  })
  // ZCode observer sessions have no resume command; suppress the copy action.
  if (!cmd) return
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
  text = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*/g, '')

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

let composerResizeObserver: ResizeObserver | null = null
function setComposerHeight(height: number) {
  const nextHeight = Math.max(0, Math.ceil(height))
  if (nextHeight === composerHeight.value) return
  composerHeight.value = nextHeight
  if (autoScroll.value) nextTick(scrollToBottom)
}

// The composer overlays the message stream. Measure its live height so a
// manually resized textarea never covers the final message.
watch(composerEl, (element) => {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  composerHeight.value = 0
  if (!element || typeof ResizeObserver === 'undefined') return
  composerResizeObserver = new ResizeObserver((entries) => {
    setComposerHeight(entries[0]?.contentRect.height ?? element.getBoundingClientRect().height)
  })
  composerResizeObserver.observe(element)
  setComposerHeight(element.getBoundingClientRect().height)
}, { flush: 'post' })

let sessionAgentListTimer: ReturnType<typeof setTimeout> | null = null
let sessionAgentSwitchTimer: ReturnType<typeof setTimeout> | null = null
function requestSessionAgents() {
  if (isReadOnlyObserverSession.value) return
  if (!showSessionAgentPicker.value || sessionAgentsLoading.value) return
  sessionAgentsLoading.value = true
  sessionAgentError.value = ''
  const sent = send({ type: 'list_session_agents', session_id: sessionId.value })
  if (!sent) {
    sessionAgentsLoading.value = false
    sessionAgentError.value = 'Agent list unavailable'
    return
  }
  if (sessionAgentListTimer) clearTimeout(sessionAgentListTimer)
  sessionAgentListTimer = setTimeout(() => {
    sessionAgentsLoading.value = false
    sessionAgentError.value = 'Agent list unavailable'
  }, 10000)
}

function requestSessionAgentSwitch(name: string) {
  if (isReadOnlyObserverSession.value) return
  if (!name || name === currentOpenCodeAgent.value || sessionAgentDisabled.value) return
  sessionAgentSubmitting.value = true
  sessionAgentError.value = ''
  const sent = send({
    type: 'set_session_agent',
    session_id: sessionId.value,
    agent_name: name,
    request_id: `agent-${Date.now()}`,
  })
  if (!sent) {
    sessionAgentSubmitting.value = false
    sessionAgentError.value = 'Agent switch failed'
    return
  }
  if (sessionAgentSwitchTimer) clearTimeout(sessionAgentSwitchTimer)
  sessionAgentSwitchTimer = setTimeout(() => {
    sessionAgentSubmitting.value = false
    sessionAgentError.value = 'Agent switch failed'
  }, 15000)
}

function prependOlderReplayEvents(events: any[]) {
  if (events.length === 0) return
  const tempMsgs: any[] = []
  const tempSubagent: Record<string, any[]> = {}
  for (const evt of events) {
    processEvent(evt, tempMsgs, tempSubagent)
  }
  if (tempMsgs.length) {
    const existingPartKeys = new Set(messages.value.map((message: any) => message.partKey).filter(Boolean))
    const uniqueTemp = tempMsgs.filter((message: any) => !message.partKey || !existingPartKeys.has(message.partKey))
    messages.value = [...uniqueTemp, ...messages.value]
  }
  for (const [agentId, bucket] of Object.entries(tempSubagent)) {
    if (!subagentMessages.value[agentId]) subagentMessages.value[agentId] = []
    subagentMessages.value[agentId] = [...bucket, ...subagentMessages.value[agentId]]
  }
  nextTick(() => {
    if (!messagesEl.value) return
    const delta = messagesEl.value.scrollHeight - olderReplayScrollHeight
    messagesEl.value.scrollTop = olderReplayScrollTop + delta
  })
}

function replaySessionTrustContext(): ReplaySessionTrustContext {
  return {
    key: `${sessionId.value || ''}::${focusedSubAgentId.value || ''}`,
    currentSessionId: sessionId.value || '',
  }
}

// Unified history loader: clears local message state and requests the first
// backward page. In focused-sub-agent mode it sends `replay_subagent` (relay
// filters events by agent_id); otherwise the regular parent-session `replay`.
// Shared by onMounted and the loadKey watcher so every entry/exit/switch path
// is consistent.
function loadHistory() {
  clearHistorySlowTimer()
  isSlowLoading.value = false
  replayReqId.value++
  isLoading.value = true
  historySlowTimer = setTimeout(() => {
    if (isLoading.value) isSlowLoading.value = true
  }, HISTORY_SLOW_THRESHOLD_MS)
  loadedMinId.value = 0
  isLoadingBackward.value = false
  hasMore.value = false
  resetReplayTrustBuffers()
  if (focusedSubAgentId.value) {
    send({ type: 'replay_subagent', session_id: sessionId.value, agent_id: focusedSubAgentId.value, limit: pageSize.value, req_id: replayReqId.value })
  } else {
    send({ type: 'replay', session_id: sessionId.value, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    try {
      send({ type: 'list_commands', session_id: sessionId.value })
    } catch (error) {
      console.warn('[session-history] auxiliary request failed', { operation: 'list_commands', error })
    }
    requestSessionMeta()
  }
}

function clearHistorySlowTimer() {
  if (historySlowTimer) clearTimeout(historySlowTimer)
  historySlowTimer = null
}

function retryHistory() {
  loadHistory()
}

function requestSessionMeta() {
  try {
    return send({
      type: 'get_session_meta',
      session_id: sessionId.value,
      request_id: `session-meta-${createClientId()}`,
    })
  } catch (error) {
    console.warn('[session-history] auxiliary request failed', { operation: 'get_session_meta', error })
    return false
  }
}

function onMessagesScroll() {
  if (!messagesEl.value) return
  const { scrollTop, scrollHeight, clientHeight } = messagesEl.value
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 60
  // session-history-pagination: scrolled to top → fetch older page (backward)
  if (scrollTop < 60 && hasMore.value && !isLoadingBackward.value && !isLoading.value && loadedMinId.value > 0) {
    isLoadingBackward.value = true
    replayReqId.value++
    olderReplayScrollHeight = scrollHeight
    olderReplayScrollTop = scrollTop
    if (focusedSubAgentId.value) {
      send({ type: 'replay_subagent', session_id: sessionId.value, agent_id: focusedSubAgentId.value, last_seq: loadedMinId.value, limit: pageSize.value, req_id: replayReqId.value })
    } else {
      send({ type: 'replay', session_id: sessionId.value, direction: 'backward', last_seq: loadedMinId.value, limit: pageSize.value, req_id: replayReqId.value })
    }
  }
}

function focusResumeInput() { if (inputEl.value) { inputEl.value.focus() } }

function requestPermission(value: string) {
  if (!permissionCanChange.value) return
  const option = runtimePermissionOptions.value.find(x => x.value === value)
  if (!option || option.disabled) return
  if (option.dangerous && !window.confirm(t('session.permission.dangerous_confirm'))) return
  const permission: PermissionConfig = currentSessionAgent.value === 'codex'
    ? expandCodexPreset(value as any)
    : { agent: 'claude-code', mode: value as ClaudeMode }
  pendingPermission.value = permission
  permissionError.value = ''
  send({ type: 'set_permission_config', session_id: sessionId.value, permission })
  if (permissionTimer) clearTimeout(permissionTimer)
  permissionTimer = setTimeout(() => {
    pendingPermission.value = undefined
    permissionError.value = t('session.permission.failed')
    requestSessionMeta()
  }, 10000)
}

// Switch thinking-effort: inject `/effort <level>` into the PTY via the daemon,
// then persist it locally so the pill stays in sync across refresh / session switch.
// Stop button escalation: 1st click sends PTY Ctrl+C (graceful). If clicked
// again within 2.5s (Ctrl+C didn't reach claude — PTY disconnected), escalate
// to session_kill (SIGKILL the claude process). This guarantees a stuck session
// can always be stopped, even when the PTY master is disconnected from claude's
// stdin (the c5813d2c incident: 11 Ctrl+C writes went into a void PTY).
const stopEscalated = ref(false)
/// 停止操作的错误提示（来自 relay 的 daemon_unreachable / session_not_found）。
/// 区别于普通消息气泡：显示在停止按钮附近,3.5s 后自动消失,不污染消息流。
const stopError = ref('')
let stopErrorTimer: ReturnType<typeof setTimeout> | null = null
let stopResetTimer: ReturnType<typeof setTimeout> | null = null
function interruptSession() {
  if (isReadOnlyObserverSession.value) return
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
const pendingToolResults = new Map<string, { output: string | null; status: string; metadata: Record<string, unknown> }>()
const contentStreams = new ContentStreamAssembler()
const fileChangeReducer = createAgentFileChangeReducer()
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

function reconcileVisibleUnresolvedTools(sessionStatus: string) {
  reconcileUnresolvedTools(messages.value, sessionStatus)
  for (const childMessages of Object.values(subagentMessages.value)) {
    reconcileUnresolvedTools(childMessages, sessionStatus)
  }
}

// Local-command whitelist: handled entirely in the browser, never sent to the
// daemon PTY. NOT sourced from commandsCache — these builtins are filtered out
// of command_list by the agent's init event in daemon sessions, so relying on
// the cache would silently disable them. Hardcode the names instead.
const LOCAL_COMMANDS = POCKETCTL_LOCAL_COMMANDS.map(command => command.name)

// Send a tool-use approval decision back to the daemon. The ApprovalCard
// already flipped its local status optimistically; here we just dispatch the
// approval_response command, which the relay forwards to the owning daemon.
const interactionSubmitTimers = new Map<string, ReturnType<typeof setTimeout>>()
type InteractionCardType = 'approval_request' | 'question_request' | 'mcp_elicitation_request'
const interactionResolutions = new Map<string, { type: InteractionCardType; resolution: Record<string, unknown>; metadata: Record<string, unknown> }>()

function uniqueBuckets(buckets: any[][]): any[][] {
  return [...new Set(buckets)]
}

function rootInteractionBuckets(rootTarget: any[]): any[][] {
  return uniqueBuckets([messages.value, rootTarget])
}

function childInteractionBuckets(subagentOverride?: Record<string, any[]>): any[][] {
  const buckets: any[][] = []
  for (const agentId of Object.keys(subagentMessages.value).sort()) buckets.push(subagentMessages.value[agentId])
  if (subagentOverride && subagentOverride !== subagentMessages.value) {
    for (const agentId of Object.keys(subagentOverride).sort()) buckets.push(subagentOverride[agentId])
  }
  return uniqueBuckets(buckets)
}

function findInteractionOwner(type: InteractionCardType, requestId: string, rootTarget: any[], subagentOverride?: Record<string, any[]>): any[] | undefined {
  const owns = (bucket: any[]) => bucket.some(message => message.type === type && message.request_id === requestId)
  return rootInteractionBuckets(rootTarget).find(owns) ?? childInteractionBuckets(subagentOverride).find(owns)
}

function removeInteractionRequest(bucket: any[], type: InteractionCardType, requestId: string): void {
  for (let index = bucket.length - 1; index >= 0; index--) {
    if (bucket[index].type === type && bucket[index].request_id === requestId) bucket.splice(index, 1)
  }
}

function claimInteractionRequestTarget(
  evt: any,
  type: InteractionCardType,
  requestId: string,
  rootTarget: any[],
  routedTarget: any[],
  subagentOverride?: Record<string, any[]>,
): any[] {
  const rootOwner = rootInteractionBuckets(rootTarget).find(bucket =>
    bucket.some(message => message.type === type && message.request_id === requestId))
  if (rootOwner) return rootOwner
  const children = childInteractionBuckets(subagentOverride)
  if (!(evt.agent_id || evt.agentId)) {
    let migratingRequest: any | undefined
    for (const bucket of children) {
      migratingRequest ??= bucket.find(message => message.type === type && message.request_id === requestId)
      removeInteractionRequest(bucket, type, requestId)
    }
    if (migratingRequest && !rootTarget.some(message => message.type === type && message.request_id === requestId)) {
      rootTarget.push(migratingRequest)
    }
    return rootTarget
  }
  return children.find(bucket => bucket.some(message => message.type === type && message.request_id === requestId)) ?? routedTarget
}

function recordInteractionResolution(
  type: InteractionCardType,
  requestId: string,
  resolution: Record<string, unknown>,
  evt: any,
  rootTarget: any[],
  subagentOverride?: Record<string, any[]>,
): void {
  const prior = interactionResolutions.get(requestId)
  const entry = {
    type, resolution,
    metadata: { ...(prior?.metadata ?? {}), ...eventWithTurnMetadata(evt) },
  }
  const owner = findInteractionOwner(type, requestId, rootTarget, subagentOverride)
  if (!owner) {
    interactionResolutions.set(requestId, entry)
    return
  }
  const request = owner.find(message => message.type === type && message.request_id === requestId)
  if (request) preserveTurnMetadataRecord(request, entry.metadata)
  resolveInteractionRequest(owner, type, requestId, resolution)
  interactionResolutions.delete(requestId)
  clearInteractionSubmitting(requestId)
}

function consumeInteractionResolution(type: InteractionCardType, requestId: string, request: any, owner: any[]): void {
  const known = interactionResolutions.get(requestId)
  if (known?.type !== type) return
  preserveTurnMetadataRecord(request, known.metadata)
  resolveInteractionRequest(owner, type, requestId, known.resolution)
  interactionResolutions.delete(requestId)
}

function interactionResultResolution(evt: any): { type: InteractionCardType; resolution: Record<string, unknown> } | null {
  let type: InteractionCardType
  if (evt.operation === 'approval_response') type = 'approval_request'
  else if (evt.operation === 'question_response' || evt.operation === 'question_reject') type = 'question_request'
  else if (evt.operation === 'mcp_elicitation_response') type = 'mcp_elicitation_request'
  else return null
  const isClaudeNeutralResult = type === 'approval_request' && (evt.status === 'submitted' || evt.status === 'result_unknown')
  if (evt.status !== 'resolved_elsewhere' && !isClaudeNeutralResult) return null
  const reason = evt.status === 'resolved_elsewhere'
    ? 'resolved_elsewhere'
    : (evt.reason || (evt.status === 'submitted' ? 'claude_result_unconfirmed' : 'result_unknown'))
  return {
    type,
    resolution: {
      reason,
      ...(isClaudeNeutralResult ? { action: evt.status, resultUnknown: evt.status === 'result_unknown' } : {}),
    },
  }
}
function markInteractionSubmitting(msg: any, operation: string): boolean {
  if (isReadOnlyObserverSession.value) return false
  const readiness = resolveInteractionReadiness({
    connectivity: interactionConnectivity.value,
    requestStatus: msg.status,
    submitting: !!msg.submitting,
    resultUnknown: !!msg.resultUnknown,
    resolvedElsewhere: msg.reason === 'resolved_elsewhere',
  })
  if (!msg.request_id || !readiness.canInteract) return false
  msg.submitting = true
  msg.resultUnknown = false
  msg.error = ''
  const prior = interactionSubmitTimers.get(msg.request_id)
  if (prior) clearTimeout(prior)
  interactionSubmitTimers.set(msg.request_id, setTimeout(() => {
    msg.submitting = false
    msg.resultUnknown = true
    msg.error = `${operation}: ${t('interaction.unknown')}`
    interactionSubmitTimers.delete(msg.request_id)
  }, 15000))
  return true
}

function clearInteractionSubmitting(requestId: string) {
  const timer = interactionSubmitTimers.get(requestId)
  if (timer) clearTimeout(timer)
  interactionSubmitTimers.delete(requestId)
  for (const bucket of uniqueBuckets([messages.value, ...Object.values(subagentMessages.value)])) {
    const card = bucket.find((message: any) => message.request_id === requestId)
    if (card) {
      card.submitting = false
      card.resultUnknown = false
    }
  }
}

function resyncInteractionState() {
  loadHistory()
}

function onApprovalRespond(msg: any, action: 'once' | 'always' | 'reject' | 'cancel') {
  if (!msg.request_id) return
  const supportsActions = interactionCapabilities.value.includes('permission_actions') || Array.isArray(msg.availableDecisions)
  const trustedPolicy = currentSessionCapabilities.value.includes('trusted_action_policy_v1')
  if (!trustedApprovalActions(msg, supportsActions, trustedPolicy).includes(action)) return
  if (!markInteractionSubmitting(msg, 'Approval')) return
  const sent = send({
    type: 'approval_response',
    session_id: sessionId.value,
    request_id: msg.request_id,
    ...(supportsActions ? { action } : { approved: action !== 'reject' && action !== 'cancel' }),
  })
  if (!sent) {
    clearInteractionSubmitting(msg.request_id)
    msg.submitting = false
    msg.error = 'Approval failed'
  }
}

function onQuestionSubmit(msg: any, answers: string[][]) {
  if (!markInteractionSubmitting(msg, 'Question response')) return
  const sent = send({ type: 'question_response', session_id: sessionId.value, request_id: msg.request_id, answers })
  if (!sent) {
    clearInteractionSubmitting(msg.request_id)
    msg.submitting = false
    msg.error = 'Question response failed'
  }
}

function onQuestionReject(msg: any) {
  if (!markInteractionSubmitting(msg, 'Question rejection')) return
  const sent = send({ type: 'question_reject', session_id: sessionId.value, request_id: msg.request_id })
  if (!sent) {
    clearInteractionSubmitting(msg.request_id)
    msg.submitting = false
    msg.error = 'Question rejection failed'
  }
}

function onMcpElicitationRespond(msg: any, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) {
  if (!markInteractionSubmitting(msg, 'MCP elicitation')) return
  const sent = send({
    type: 'mcp_elicitation_response', session_id: sessionId.value, request_id: msg.request_id,
    elicitation_action: action, ...(content === undefined ? {} : { elicitation_content: content }),
  })
  if (!sent) {
    clearInteractionSubmitting(msg.request_id)
    msg.submitting = false
    msg.error = 'MCP elicitation response failed'
  }
}

function onChoiceRespond(msg: any, choice: string) {
  if (!markInteractionSubmitting(msg, 'Interactive response')) return
  const sent = send({
    type: 'interactive_response',
    session_id: sessionId.value,
    request_id: msg.request_id,
    choice,
  })
  if (!sent) {
    clearInteractionSubmitting(msg.request_id)
    msg.error = 'Interactive response failed'
  }
}

function sendMessage() {
  if (isReadOnlyObserverSession.value) return
  const text = messageInput.value.trim()
  if (!text || !composerState.value.sendEnabled) return
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
  if (sendPromptText(text)) messageInput.value = ''
}

function sendPromptText(text: string): boolean {
  if (isReadOnlyObserverSession.value) return false
  // C (web-post-send-feedback): optimistic echo — push user bubble immediately.
  // Relay's user_text echo is deduped by isDuplicate (same pattern as
  // handleLocalCommand), so no double bubble.
  const bubbleId = nextId('u')
  const msgId = `m-${bubbleId}`  // L2: correlate ack/nack with this optimistic bubble
  messages.value.push({
    id: bubbleId,
    type: 'user_text',
    role: 'user',
    content: text,
    __msg_id: msgId,
    __expects_receipt: supportsMessageAcceptanceReceipt.value,
    deliveryStatus: 'pending',
  })
  nextTick(scrollToBottom)
  const sent = sendUserMessage({ session_id: sessionId.value, content: text, msg_id: msgId, input_mode: 'auto' })
  if (!sent) {
    failOrRollbackOptimistic(msgId)  // L1: WebSocket not open
    return false
  }
  startTurnTimer()  // begin turn timer (stops when isExecuting → false)
  awaitingStart.value = true  // A: show turn-bar until first running/agent_text
  armAckTimeout(msgId)  // L2: roll back if relay doesn't ack within 3s
  return true
}

// L1/L2 (web-post-send-feedback): remove the optimistic user bubble + reset
// awaiting-start state + flash the send-failed banner. Used by the synchronous
// send-failure path (ws not open), the relay nack, and the ack-timeout.
function clearAckTimeout(msgId: string) {
  const timer = pendingAckTimers.get(msgId)
  if (timer) clearTimeout(timer)
  pendingAckTimers.delete(msgId)
}

function showSendFailure(key = '') {
  awaitingStart.value = false
  sendFailureKey.value = key
  sendError.value = true
  setTimeout(() => { sendError.value = false; sendFailureKey.value = '' }, 3000)
}

function userMessageFailureKey(reason: string) {
  if (reason === 'session_identity_unavailable') return 'session.recovery_failed'
  if (reason === 'observer_read_only') return 'session.control_restricted'
  if (reason === 'execution_failed') return 'session.execution_failed'
  return ''
}
function restoreInterruptPendingDraft() {
  if (!interruptPendingDraft.value) return
  if (!composerState.value.sendEnabled || isPendingSession.value) return
  const retryText = interruptPendingDraft.value
  if (sendPromptText(retryText)) interruptPendingDraft.value = ''
}

function rollbackOptimistic(msgId?: string) {
  if (msgId) clearAckTimeout(msgId)
  const idx = msgId ? messages.value.findIndex((m: any) => m.__msg_id === msgId) : -1
  if (idx >= 0) messages.value.splice(idx, 1)
  showSendFailure()
}

function failOrRollbackOptimistic(msgId: string, reason = '') {
  clearAckTimeout(msgId)
  const message = messages.value.find((m: any) => m.__msg_id === msgId)
  if (!message?.__expects_receipt) {
    rollbackOptimistic(msgId)
    return
  }
  message.deliveryStatus = 'failed'
  message.deliveryReason = reason
  showSendFailure()
}

// L2: arm a 3s timeout per prompt so one ACK cannot settle another prompt.
function armAckTimeout(msgId: string) {
  clearAckTimeout(msgId)
  pendingAckTimers.set(msgId, setTimeout(() => failOrRollbackOptimistic(msgId), 3000))
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

function sessionTokenUsageFallback(): any {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId.value) as any
  if (!s) return null
  const input = s.tokInput || 0
  const output = s.tokOutput || 0
  const cacheRead = s.tokCacheRead || 0
  const cacheCreate = s.tokCacheCreate || 0
  if (input + output + cacheRead + cacheCreate <= 0) return null
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_create_tokens: cacheCreate,
  }
}

// buildCostMessage summarizes token usage accumulated in this session. Prefer
// event-level usage, falling back to persisted session totals for older Codex
// events that were parsed before usage extraction existed.
function buildCostMessage(): string {
  const usage = effectiveUsage() || sessionTokenUsageFallback()
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
  const agentLabel = agentDisplayName(normalizedAgentType(s))
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
  const pool = availableCommands.value
  if (prefix === '') return pool.slice(0, 50)
  return pool.filter(c => c.name.toLowerCase().startsWith(prefix)).slice(0, 50)
})
const availableCommands = computed(() => mergeLocalCommands(commandsCache.value))
const showPopover = computed(() => !popoverDismissed.value && filteredCommands.value.length > 0)

// Reset selection/dismissal whenever the input changes
watch(messageInput, () => {
  selectedIndex.value = 0
  popoverDismissed.value = false
  if (isMobile.value) nextTick(resizeMobileComposerTextarea)
})

watch(isMobile, (mobile) => {
  if (mobile) nextTick(resizeMobileComposerTextarea)
})

function resizeMobileComposerTextarea() {
  const element = inputEl.value
  if (!isMobile.value || !element) return
  element.style.height = 'auto'
  const minimumHeight = isInputFocused.value
    ? MOBILE_FOCUSED_MIN_TEXTAREA_HEIGHT
    : MOBILE_MIN_TEXTAREA_HEIGHT
  const nextHeight = Math.min(
    MOBILE_MAX_TEXTAREA_HEIGHT,
    Math.max(minimumHeight, element.scrollHeight),
  )
  mobileTextareaHeight.value = nextHeight
  // Keep the DOM constrained even when Vue sees the same numeric value and
  // therefore skips patching the inline height after the temporary `auto`.
  element.style.height = `${nextHeight}px`
}

function handleComposerFocus() {
  isInputFocused.value = true
  nextTick(resizeMobileComposerTextarea)
}

function handleComposerBlur() {
  isInputFocused.value = false
  nextTick(resizeMobileComposerTextarea)
}

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
  if (!last || last.type !== type) return false
  if ((last.content || '') === text) return true
  // Codex persists final answers in both event_msg and response_item. The
  // latter can include a local memory-citation envelope, so compare the
  // user-visible text for this adjacent agent-only fallback.
  return type === 'agent_text' && cleanContent(last.content || '') === cleanContent(text)
}

function eventCorrelation(evt: any) {
  const payload = evt?.payload && typeof evt.payload === 'object' ? evt.payload : {}
  return {
    requestId: evt?.request_id || payload.request_id || '',
    msgId: evt?.msg_id || payload.msg_id || '',
  }
}

function messageCorrelation(message: any) {
  return {
    requestId: message?.request_id || message?.__request_id || '',
    msgId: message?.msg_id || message?.__msg_id || '',
  }
}

function correlationsConflict(left: ReturnType<typeof eventCorrelation>, right: ReturnType<typeof eventCorrelation>) {
  return Boolean(
    (left.requestId && right.requestId && left.requestId !== right.requestId)
    || (left.msgId && right.msgId && left.msgId !== right.msgId),
  )
}

function findMessageByCorrelation(correlation: ReturnType<typeof eventCorrelation>, target = messages.value) {
  if (!correlation.requestId && !correlation.msgId) return undefined
  return target.find((message: any) => {
    const candidate = messageCorrelation(message)
    if (correlationsConflict(correlation, candidate)) return false
    return Boolean(
      (correlation.msgId && candidate.msgId === correlation.msgId)
      || (correlation.requestId && candidate.requestId === correlation.requestId),
    )
  })
}

function applyCanonicalCorrelation(message: any, correlation: ReturnType<typeof eventCorrelation>) {
  if (correlation.requestId) {
    message.request_id = correlation.requestId
    message.__request_id = correlation.requestId
  }
  if (correlation.msgId) message.msg_id = correlation.msgId
}

const turnMetadataKeys = ['turn_id', 'source_turn_id', 'turn_status', 'turn_reason', 'turn_origin', 'turn_confidence', 'previous_turn_id', 'continuation_reason', 'actor_scope', 'flow_scope', 'content_class', 'classifier_version'] as const
function eventWithTurnMetadata(evt: any): Record<string, unknown> {
  const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {}
  const metadata: Record<string, unknown> = {}
  for (const key of turnMetadataKeys) {
    const value = evt[key] ?? payload[key]
    if (value !== undefined) metadata[key] = value
  }
  return metadata
}
function preserveTurnMetadata(message: any, evt: any): void {
  Object.assign(message, eventWithTurnMetadata(evt))
}
function preserveTurnMetadataRecord(message: any, metadata: Record<string, unknown>): void {
  Object.assign(message, metadata)
}

function findAffectedFileChangeCard(target: any[], evt: any): any | undefined {
  const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {}
  const eventId = evt.event_id ?? payload.event_id
  const changeSetId = evt.change_set_id ?? payload.change_set_id
  const changeIndex = evt.change_index ?? payload.change_index
  const path = evt.path ?? payload.path
  return [...target].reverse().find((message: any) => message.type === 'agent_file_change'
    && message.fileChange?.files.some((file: any) => file.edits.some((edit: any) =>
      (eventId && edit.eventId === eventId)
      || (!eventId && edit.changeSetId === changeSetId && edit.changeIndex === changeIndex && file.path === path),
    )))
}

function processEvent(evt: any, target: any[] = messages.value, subagentOverride?: Record<string, any[]>) {
  const type = evt.type || evt.event_type
  if (isKnownNonTimelineControlEvent(type)) return
  if (type === 'agent_plan') {
    if (!evt.agent_id && !evt.payload?.agent_id) acceptAgentPlan(evt)
    return
  }
  const rootTarget = target
  const interactionBuckets = subagentOverride ?? subagentMessages.value
  // interaction_result is terminal control, not a timeline row. Resolve by the
  // request's canonical owner before agent routing, or buffer by request ID
  // until that owner appears.
  if (type === 'interaction_result') {
    const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {}
    const normalized = { ...payload, ...evt, request_id: evt.request_id || payload.request_id }
    const requestId = normalized.request_id
    const result = interactionResultResolution(normalized)
    if (requestId && result) recordInteractionResolution(result.type, requestId, result.resolution, evt, rootTarget, interactionBuckets)
    return
  }
  // P2: route sub-agent events to per-agent buckets; parent events keep default target
  target = resolveAgentTarget(evt, interactionBuckets, target)
  if (type === 'session_model_changed') {
    const model = evt.model || evt.payload?.model || ''
    if (!model) return
    if (evt.session_id === sessionId.value) currentModel.value = model
    if ((evt.reason || evt.payload?.reason) === 'initial_model') return
    const eventId = evt.event_id || evt.payload?.event_id
    if (eventId && target.some((message: any) => message.type === type && message.eventId === eventId)) return
    if (!eventId && isDuplicate(type, model, target)) return
    target.push({ id: nextId('model'), type, role: 'agent', content: model, eventId, ...eventWithTurnMetadata(evt) })
  } else if (type === 'user_text') {
    const text = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    if (!text) return
    const correlation = eventCorrelation(evt)
    const correlated = findMessageByCorrelation(correlation, target)
    if (correlated) {
      preserveTurnMetadata(correlated, evt)
      applyCanonicalCorrelation(correlated, correlation)
      return
    }
    const last = target[target.length - 1]
    if (last?.type === 'user_text' && (last.content || '') === text
      && !correlationsConflict(correlation, messageCorrelation(last))) {
      const existing = last
      preserveTurnMetadata(existing, evt)
      applyCanonicalCorrelation(existing, correlation)
      return
    }
    target.push({
      id: nextId('u'), type: 'user_text', role: 'user', content: text,
      request_id: correlation.requestId,
      msg_id: correlation.msgId,
      ...eventWithTurnMetadata(evt),
    })
  } else if (type === 'agent_text') {
    // A: model started responding — end optimistic window (fallback if the
    // running status was missed, e.g. PTY race).
    awaitingStart.value = false
    let content = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    const usage = evt.usage || evt.payload?.usage
    const streamId = evt.stream_id || evt.payload?.stream_id
    let streaming = evt.streaming ?? evt.payload?.streaming ?? false
    let streamCompleted = false
    if (streamId) {
      const update = contentStreams.accept({
        streamId,
        sequence: Number(evt.chunk_seq ?? evt.payload?.chunk_seq),
        byteOffset: Number(evt.byte_offset ?? evt.payload?.byte_offset ?? 0),
        content,
        final: evt.final ?? evt.payload?.final ?? false,
        totalBytes: Number(evt.total_bytes ?? evt.payload?.total_bytes) || undefined,
      })
      if (!update || (!update.changed && !update.transitionedToComplete)) return
      content = update.appended
      streaming = !update.completed
      streamCompleted = update.completed
    }
    if (usage && target === messages.value) lastUsage.value = usage
    // Usage-only carrier (opencode step-finish / codex token_count): no text,
    // just token accounting. Attach it to the latest agent_text so the context
    // pill picks it up, instead of dropping the event.
    if (!content) {
      if (streamId && streamCompleted) {
        const last = [...target].reverse().find((message: any) =>
          message.type === 'agent_text' && message.streamId === streamId)
        if (last) {
          last.streaming = false
          if (usage) last.usage = usage
          preserveTurnMetadata(last, evt)
        }
        return
      }
      if (usage) {
        for (let i = target.length - 1; i >= 0; i--) {
          if ((target[i] as any).type === 'agent_text') {
            ;(target[i] as any).usage = usage
            preserveTurnMetadata(target[i], evt)
            break
          }
        }
      }
      return
    }
    const merged = streamId ? 'legacy' : mergeRevisionedPart(target, {
      type: 'agent_text', text: content,
      message_id: evt.message_id || evt.payload?.message_id,
      part_id: evt.part_id || evt.payload?.part_id,
      revision: evt.revision || evt.payload?.revision,
      snapshot: evt.snapshot ?? evt.payload?.snapshot,
      event_id: evt.event_id || evt.payload?.event_id,
      previous_event_id: evt.previous_event_id || evt.payload?.previous_event_id,
      replace: evt.replace ?? evt.payload?.replace,
      streaming: evt.streaming ?? evt.payload?.streaming ?? false,
      usage,
      ...eventWithTurnMetadata(evt),
    })
    if (merged !== 'legacy') return
    if (streamId) {
      const existing = [...target].reverse().find((message: any) =>
        message.type === 'agent_text' && message.streamId === streamId)
      if (existing) {
        existing.content += content
        existing.streaming = streaming
        if (usage) existing.usage = usage
        preserveTurnMetadata(existing, evt)
      } else if (content) {
        target.push({
          id: nextId('a'), type: 'agent_text', role: 'agent',
          content, streaming, usage, streamId, ...eventWithTurnMetadata(evt),
        })
      }
      return
    }
    if (isDuplicate('agent_text', content, target)) {
      preserveTurnMetadata(target[target.length - 1], evt)
      return
    }
    const last = target[target.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !content.startsWith('\n')) {
      last.content += content
      if (!streaming) last.streaming = false
      if (usage) last.usage = usage
      preserveTurnMetadata(last, evt)
    } else {
      target.push({ id: nextId('a'), type: 'agent_text', role: 'agent', content, streaming, usage, ...eventWithTurnMetadata(evt) })
    }
  } else if (type === 'agent_reasoning') {
    let content = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    const streamId = evt.stream_id || evt.payload?.stream_id
    if (streamId) {
      const update = contentStreams.accept({
        streamId,
        sequence: Number(evt.chunk_seq ?? evt.payload?.chunk_seq),
        byteOffset: Number(evt.byte_offset ?? evt.payload?.byte_offset ?? 0),
        content,
        final: evt.final ?? evt.payload?.final ?? false,
        totalBytes: Number(evt.total_bytes ?? evt.payload?.total_bytes) || undefined,
      })
      if (!update || (!update.changed && !update.transitionedToComplete)) return
      content = update.appended
      const existing = [...target].reverse().find((message: any) =>
        message.type === 'agent_reasoning' && message.streamId === streamId)
      if (existing) {
        existing.content += content
        existing.streaming = !update.completed
        preserveTurnMetadata(existing, evt)
      } else if (content) {
        target.push({
          id: nextId('or'), type: 'agent_reasoning', role: 'agent',
          content, streaming: !update.completed, streamId, ...eventWithTurnMetadata(evt),
        })
      }
      return
    }
    if (!content) return
    const merged = mergeRevisionedPart(target, {
      type: 'agent_reasoning', text: content,
      message_id: evt.message_id || evt.payload?.message_id,
      part_id: evt.part_id || evt.payload?.part_id,
      revision: evt.revision || evt.payload?.revision,
      snapshot: evt.snapshot ?? evt.payload?.snapshot,
      event_id: evt.event_id || evt.payload?.event_id,
      previous_event_id: evt.previous_event_id || evt.payload?.previous_event_id,
      replace: evt.replace ?? evt.payload?.replace,
      streaming: evt.streaming ?? evt.payload?.streaming ?? false,
      ...eventWithTurnMetadata(evt),
    })
    if (merged === 'legacy') {
      if (isDuplicate('agent_reasoning', content, target)) preserveTurnMetadata(target[target.length - 1], evt)
      else target.push({ id: nextId('or'), type: 'agent_reasoning', role: 'agent', content, streaming: false, ...eventWithTurnMetadata(evt) })
    }
  } else if (type === 'agent_retry') {
    const partId = evt.part_id || evt.payload?.part_id
    const existing = partId && target.find((m: any) => m.type === 'agent_retry' && m.partId === partId)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
    target.push({
      id: nextId('or'), type: 'agent_retry', role: 'agent', partId,
      attempt: evt.attempt || evt.payload?.attempt || 1,
      error: evt.error || evt.payload?.error || '',
      retryAt: evt.retry_at || evt.payload?.retry_at,
      ...eventWithTurnMetadata(evt),
    })
  } else if (type === 'agent_compaction') {
    const partId = evt.part_id || evt.payload?.part_id
    const existing = partId && target.find((m: any) => m.type === 'agent_compaction' && m.partId === partId)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
    target.push({
      id: nextId('oc'), type: 'agent_compaction', role: 'agent', partId,
      auto: evt.auto ?? evt.payload?.auto ?? false,
      overflow: evt.overflow ?? evt.payload?.overflow ?? false,
      ...eventWithTurnMetadata(evt),
    })
  } else if (type === 'agent_file_change') {
    fileChangeReducer.accept(evt, target)
    const card = findAffectedFileChangeCard(target, evt)
    if (card) preserveTurnMetadata(card, evt)
  } else if (isOpenCodeStructuredType(type)) {
    const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {}
    mergeStructuredPart(target, {
      ...payload,
      ...evt,
      type,
      session_id: evt.session_id || payload.session_id,
      message_id: evt.message_id || payload.message_id,
      part_id: evt.part_id || payload.part_id,
      todos: evt.todos || payload.todos || [],
    })
  } else if (type === 'tool_call') {
    const callId = evt.call_id || evt.payload?.call_id
    if (!callId) return
    const tool = evt.tool || evt.payload?.tool || ''
    const input = evt.input || evt.payload?.input
    const inputDesc = formatToolInput(tool, input)
    const pending = pendingToolResults.get(callId)
    const existing = target.find(message => message.type === 'tool_call' && message.call_id === callId)
    if (existing) {
      existing.tool = tool
      existing.input = input
      existing.inputDesc = inputDesc
      preserveTurnMetadata(existing, evt)
      if (pending) {
        existing.output = pending.output
        existing.status = pending.status
        preserveTurnMetadataRecord(existing, pending.metadata)
      }
    } else {
      target.push({
        id: nextId('t'), type: 'tool_call', call_id: callId,
        tool, input, inputDesc,
        output: pending?.output ?? null, status: pending?.status ?? 'running',
        expanded: false, outputExpanded: false,
        ...eventWithTurnMetadata(evt),
        ...(pending?.metadata ?? {}),
      })
    }
    if (pending) pendingToolResults.delete(callId)
  } else if (type === 'tool_result') {
    const callId = evt.call_id || evt.payload?.call_id
    let output = evt.output ?? evt.payload?.output ?? evt.result ?? evt.payload?.result
    if (!callId) return
    const streamId = evt.stream_id || evt.payload?.stream_id
    let resultStatus = 'completed'
    if (streamId) {
      const update = contentStreams.accept({
        streamId,
        sequence: Number(evt.chunk_seq ?? evt.payload?.chunk_seq),
        byteOffset: Number(evt.byte_offset ?? evt.payload?.byte_offset ?? 0),
        content: output ?? '',
        final: evt.final ?? evt.payload?.final ?? false,
        totalBytes: Number(evt.total_bytes ?? evt.payload?.total_bytes) || undefined,
      })
      if (!update || (!update.changed && !update.transitionedToComplete)) return
      output = update.content
      resultStatus = update.completed ? 'completed' : 'running'
    }
    // Find last matching tool_call (matches iOS app lastIndex logic)
    let idx = -1
    for (let i = target.length - 1; i >= 0; i--) {
      if (target[i].type === 'tool_call' && target[i].call_id === callId) {
        idx = i
        break
      }
    }
    if (idx >= 0) {
      if (output !== undefined && output !== null) target[idx].output = output
      target[idx].status = resultStatus
      preserveTurnMetadata(target[idx], evt)
    } else {
      // tool_call hasn't been created yet (out-of-order replay) — buffer the
      // result so it's applied when the matching tool_call arrives.
      pendingToolResults.set(callId, { output: output ?? null, status: resultStatus, metadata: eventWithTurnMetadata(evt) })
    }
  } else if (type === 'error') {
    // Durable OpenCode errors can arrive both as live events and replay_batch.
    // Use the daemon's stable event_id (falling back to message_id) so refresh
    // and reconnect never render the same assistant error twice.
    const errorText = evt.error || evt.content || evt.payload?.error || evt.payload?.content || 'Unknown error'
    const eventKey = evt.event_id || evt.payload?.event_id || (evt.message_id || evt.payload?.message_id ? `message:${evt.message_id || evt.payload?.message_id}` : '')
    const existing = eventKey && target.find((m: any) => m.type === 'error' && m.eventKey === eventKey)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
    target.push({ id: nextId('e'), type: 'error', role: 'agent', content: errorText, error: errorText, eventKey, message_id: evt.message_id || evt.payload?.message_id, ...eventWithTurnMetadata(evt) })
  } else if (type === 'turn_status') {
    const turnId = evt.turn_id || evt.payload?.turn_id
    const turnStatus = evt.turn_status || evt.payload?.turn_status
    if (!turnId || !turnStatus) return
    const eventId = evt.event_id || evt.payload?.event_id
    const existing = eventId && target.find((message: any) => message.type === 'turn_status' && message.eventId === eventId)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
    target.push({ id: nextId('ts'), type: 'turn_status', role: 'agent', eventId, ...eventWithTurnMetadata(evt) })
  } else if (type === 'session_status') {
    const s = evt.status || evt.payload?.status
    if (s) status.value = s
    // A: first executing status from daemon ends the optimistic window.
    if (s === 'running' || s === 'busy' || s === 'retry' || s === 'waiting') awaitingStart.value = false
    // During a session switch, capture the turn start time from the last
    // executing status (busy/running/waiting) so the timer can resume the
    // accumulated elapsed instead of restarting from zero.
    if (sessionSwitching && (s === 'running' || s === 'busy' || s === 'retry' || s === 'waiting')) {
      const ts = evt.turn_started_at || evt.payload?.turn_started_at
      if (ts) resumeStartAt = new Date(ts).getTime()
    }
    if (evt.exit_reason || evt.payload?.exit_reason) exitReason.value = evt.exit_reason || evt.payload.exit_reason
    if (evt.exited_at || evt.payload?.exited_at) exitedAt.value = evt.exited_at || evt.payload.exited_at
  } else if (type === 'command_receipt') {
    target.push({
      id: nextId('r'), type: 'command_receipt',
      command: evt.command || '', receiptStatus: evt.receipt_status || 'success',
      message: evt.message || '',
      ...eventWithTurnMetadata(evt),
    })
  } else if (type === 'approval_request') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const tool = evt.tool || evt.payload?.tool || ''
    const input = evt.input || evt.payload?.input
    const requestTarget = claimInteractionRequestTarget(evt, 'approval_request', requestId, rootTarget, target, interactionBuckets)
    const request = upsertInteractionRequest(requestTarget, 'approval_request', requestId, {
      id: nextId('ap'), type: 'approval_request', request_id: requestId,
      call_id: evt.call_id || evt.payload?.call_id,
      tool, input,
      permissionName: evt.permission_name || evt.payload?.permission_name || '',
      patterns: evt.patterns || evt.payload?.patterns || [],
      always: evt.always || evt.payload?.always || [],
      metadata: evt.metadata || evt.payload?.metadata,
      toolMessageId: evt.tool_message_id || evt.payload?.tool_message_id,
      toolCallId: evt.tool_call_id || evt.payload?.tool_call_id,
      permissionVersion: evt.permission_version || evt.payload?.permission_version,
      approvalKind: evt.approval_kind || evt.payload?.approval_kind,
      availableDecisions: evt.available_decisions || evt.payload?.available_decisions || [],
      securityContext: evt.security_context || evt.payload?.security_context,
      command: evt.command || evt.payload?.command,
      cwd: evt.cwd || evt.payload?.cwd,
      description: evt.description || evt.payload?.description,
      inputDesc: evt.command || evt.payload?.command || evt.description || evt.payload?.description || formatToolInput(tool, input),
      ...eventWithTurnMetadata(evt),
    })
    preserveTurnMetadata(request, evt)
    consumeInteractionResolution('approval_request', requestId, request, requestTarget)
  } else if (type === 'approval_resolved') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const approved = evt.approved ?? evt.payload?.approved
    const action = evt.action || evt.payload?.action || (approved ? 'once' : 'reject')
    const resolution = { action, reason: evt.reason || evt.payload?.reason }
    recordInteractionResolution('approval_request', requestId, resolution, evt, rootTarget, interactionBuckets)
  } else if (type === 'question_request') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const questions = evt.questions || evt.payload?.questions
    if (!Array.isArray(questions) || questions.length === 0) return
    const requestTarget = claimInteractionRequestTarget(evt, 'question_request', requestId, rootTarget, target, interactionBuckets)
    const request = upsertInteractionRequest(requestTarget, 'question_request', requestId, {
      id: nextId('oq'),
      questions,
      autoResolutionMs: evt.auto_resolution_ms || evt.payload?.auto_resolution_ms,
      ...eventWithTurnMetadata(evt),
      toolMessageId: evt.tool_message_id || evt.payload?.tool_message_id,
      toolCallId: evt.tool_call_id || evt.payload?.tool_call_id,
    })
    preserveTurnMetadata(request, evt)
    consumeInteractionResolution('question_request', requestId, request, requestTarget)
  } else if (type === 'question_resolved') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const resolution = {
      answers: evt.answers || evt.payload?.answers || [],
      rejected: !!(evt.rejected ?? evt.payload?.rejected),
      reason: evt.reason || evt.payload?.reason,
      redacted: !!(evt.redacted ?? evt.payload?.redacted),
    }
    recordInteractionResolution('question_request', requestId, resolution, evt, rootTarget, interactionBuckets)
  } else if (type === 'mcp_elicitation_request') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const requestTarget = claimInteractionRequestTarget(evt, 'mcp_elicitation_request', requestId, rootTarget, target, interactionBuckets)
    const request = upsertInteractionRequest(requestTarget, 'mcp_elicitation_request', requestId, {
      id: nextId('mcp'), mcpServer: evt.mcp_server || evt.payload?.mcp_server,
      elicitationMode: evt.elicitation_mode || evt.payload?.elicitation_mode,
      elicitationId: evt.elicitation_id || evt.payload?.elicitation_id,
      elicitationSchema: evt.elicitation_schema || evt.payload?.elicitation_schema,
      message: evt.message || evt.payload?.message, url: evt.url || evt.payload?.url,
      ...eventWithTurnMetadata(evt),
    })
    preserveTurnMetadata(request, evt)
    consumeInteractionResolution('mcp_elicitation_request', requestId, request, requestTarget)
  } else if (type === 'mcp_elicitation_resolved') {
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const resolution = { action: evt.action || evt.payload?.action, reason: evt.reason || evt.payload?.reason, redacted: !!(evt.redacted ?? evt.payload?.redacted) }
    recordInteractionResolution('mcp_elicitation_request', requestId, resolution, evt, rootTarget, interactionBuckets)
  } else if (type === 'interactive_prompt') {
    // Daemon scanned a selection menu the agent's TUI drew to the PTY (e.g. a
    // host PreToolUse hook's "Do you want to proceed? ❶Yes ❷No" prompt that
    // never reaches JSONL). Render an inline numbered-choice card; the user's
    // selection is sent back via interactive_response.
    const requestId = evt.request_id || evt.payload?.request_id
    if (!requestId) return
    const existing = target.find((m: any) => m.type === 'interactive_prompt' && m.request_id === requestId)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
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
      ...eventWithTurnMetadata(evt),
    })
  } else {
    const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {}
    const stableIdentity = unknownTimelineEventIdentity(evt, type)
    const existing = stableIdentity && target.find((message: any) => message.type === type && message.eventKey === stableIdentity)
    if (existing) {
      preserveTurnMetadata(existing, evt)
      return
    }
    target.push({
      id: stableIdentity ? `unknown:${stableIdentity}` : nextId('unknown'), type, role: 'agent',
      eventKey: stableIdentity || '', content: evt.text ?? evt.content ?? payload.text ?? payload.content ?? '',
      ...eventWithTurnMetadata(evt),
    })
  }
}

// --- Live content frame batching -------------------------------------------
// Managed agents emit dozens of agent_text/agent_reasoning/tool_result chunks
// per second; reducing each chunk synchronously with its own reactive commit
// and auto-scroll dominates output latency. Batchable live content is coalesced
// into one ordered flush per animation frame (plus a short timer fallback for
// background tabs); every other live event flushes pending content first so
// control events never reorder ahead of it.
function isBatchableLiveContent(msg: any): boolean {
  const type = msg.type || msg.event_type
  if (type === 'agent_text' || type === 'agent_reasoning') return true
  if (type === 'tool_result') return Boolean(msg.streaming ?? msg.payload?.streaming)
  return false
}

const liveContentContextKey = computed(() => `${sessionId.value || ''}::${focusedSubAgentId.value || ''}`)

const liveContentBatcher = createLiveSessionEventBatcher<any>({
  flush(events) {
    if (events.length === 0) return
    // Capture follow intent before reduction: a user reading history must not
    // be yanked back to the bottom by output they never followed.
    const shouldFollow = autoScroll.value
    for (const evt of events) {
      processEvent(evt)
      if ((evt.type || evt.event_type) === 'tool_result') {
        const callId = evt.call_id || evt.payload?.call_id
        if (callId) clearToolTimeout(callId)
      }
    }
    if (shouldFollow) nextTick(() => { if (autoScroll.value) scrollToBottom() })
  },
})

function enqueueLiveContent(msg: any): void {
  liveContentBatcher.enqueue(liveContentContextKey.value, msg)
}

function flushLiveContent(): void {
  liveContentBatcher.flushNow()
}

function processImmediateLiveEvent(msg: any, options?: { scroll?: boolean }): void {
  flushLiveContent()
  processEvent(msg)
  if (options?.scroll) nextTick(scrollToBottom)
}

// Exposed for focused integration tests of the actual event-consumer path.
defineExpose({ processEvent, messages, status, currentOpenCodeAgent })

// Composite load key: session id + (optional) focused sub-agent id. A change
// covers every transition — session switch, entering / leaving the focused
// sub-agent view, and switching between sub-agents — so a single watcher drives
// state reset + history reload instead of one watcher per dimension.
const loadKey = computed(() => sessionId.value + '::' + (route.query.subagent as string || ''))

// Watch for session switch / focus change — clear messages and replay new context
watch(loadKey, (newKey, oldKey) => {
  if (newKey && newKey !== oldKey) {
    clearAllToolTimeouts()   // reset tool timeout guards on session switch
    for (const timer of interactionSubmitTimers.values()) clearTimeout(timer)
    interactionSubmitTimers.clear()
    interactionResolutions.clear()
    interruptPendingDraft.value = ''
    pendingToolResults.clear() // discard buffered out-of-order results
    contentStreams.reset()
    liveContentBatcher.reset(newKey) // drop live chunks still bound to the old context
    fileChangeReducer.resetTransientStreams()
    fileChangePanelOpen.value = false
    mobileFileChange.value = null
    fileChangeOpener.value = null
    resetReplayTrustBuffers()
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
    subagentMessages.value = {}
    childrenToken.value = {}
    status.value = 'running'
    awaitingStart.value = false  // A: reset optimistic window on session switch
    exitReason.value = ''
    exitedAt.value = ''
    commandsCache.value = []
    const nextSession = allSessions.value.find((item: any) => item.session_id === sessionId.value)
    currentModel.value = nextSession?.model || '' // immediate persisted fallback; refreshed by get_session_meta below
    currentEffort.value = '' // clear; refilled by authoritative get_session_meta
    interactionCapabilities.value = []
    sessionAgents.value = []
    currentOpenCodeAgent.value = ''
    sessionAgentsLoading.value = false
    sessionAgentError.value = ''
    sessionAgentSubmitting.value = false
    if (sessionAgentListTimer) { clearTimeout(sessionAgentListTimer); sessionAgentListTimer = null }
    if (sessionAgentSwitchTimer) { clearTimeout(sessionAgentSwitchTimer); sessionAgentSwitchTimer = null }
    loadHistory()
  }
})

const cleanups: (() => void)[] = []

onMounted(() => {
	cleanups.push(onEvent('connection_restored', () => {
		send({ type: 'list_sessions' })
		send({ type: 'list_daemons' })
		loadHistory()
	}))

	cleanups.push(onEvent('session_list', (msg: any) => {
    allSessions.value = msg.sessions || []
    // P1a: populate childrenToken from current session's children
    const cur = msg.sessions?.find((s: any) => s.session_id === sessionId.value)
    if (cur && interactionCapabilities.value.length === 0 && Array.isArray(cur.capabilities)) {
      interactionCapabilities.value = cur.capabilities
    }
    // The relay persists the model with the session. Use it immediately as a
    // fallback while the daemon's authoritative get_session_meta response is
    // still in flight (or unavailable for an offline terminal session).
    if (cur?.model && !currentModel.value) currentModel.value = cur.model
    if (cur?.active_agent && !currentOpenCodeAgent.value) currentOpenCodeAgent.value = cur.active_agent
    if (cur?.children) {
      for (const c of cur.children) {
        childrenToken.value[c.agentId] = { tokenIn: c.tokenIn || 0, tokenOut: c.tokenOut || 0, tokenCache: c.tokenCache || 0, tokenCacheCreate: c.tokenCacheCreate || 0 }
      }
      // sync subagent messages with fresh authoritative totals from session_list
      for (const m of messages.value as any[]) {
        if (m.type === 'subagent' && m.tool && childrenToken.value[m.tool]) {
          m.tokenUsage = { ...childrenToken.value[m.tool] }
        }
      }
      // P2: sync child titles into subagent placeholder messages
      for (const c of cur.children) {
        const m: any = messages.value.find((x: any) => x.type === 'subagent' && x.tool === c.agentId)
        if (m && c.title) m.title = c.title
      }
    }
    // default 哨兵 → 自动落到首个会话（避免停在空白的 default 占位）：
    //   - 带 host query（从主机"查看全部"跳来）：该主机的首个会话
    //   - 无 host query（sidebar 直接进入会话模块）：整个列表的首个会话
    // 落定后 daemonName 按当前 sessionId 解析，session-panel-header 与 chat-toolbar
    // 都会显示这个会话所属的主机名。
    if (sessionId.value === 'default') {
      const first = visibleSessions.value[0]
      if (first) {
        router.replace({ path: `/session/${first.session_id}` })
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
        control_mode: msg.control_mode,
        capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : [],
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
  cleanups.push(onEvent('daemon_status', (msg: any) => {
    if (!msg.daemon_id) return
    setDaemonConnectivity(msg.daemon_id, msg.status === 'online', msg)
  }))
  cleanups.push(onEvent('command_list', (msg: any) => {
    if (msg.session_id !== sessionId.value) return // discard stale responses from other sessions
    commandsCache.value = msg.commands || []
  }))
  cleanups.push(onEvent('session_agent_list', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    sessionAgents.value = normalizeSessionAgents(msg.agents)
    sessionAgentsLoading.value = false
    sessionAgentError.value = ''
    if (sessionAgentListTimer) { clearTimeout(sessionAgentListTimer); sessionAgentListTimer = null }
  }))
  cleanups.push(onEvent('session_agent_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value || !msg.current_agent) return
    currentOpenCodeAgent.value = msg.current_agent
    sessionAgentSubmitting.value = false
    sessionAgentError.value = ''
    if (sessionAgentSwitchTimer) { clearTimeout(sessionAgentSwitchTimer); sessionAgentSwitchTimer = null }
    const session = allSessions.value.find((item: any) => item.session_id === sessionId.value)
    if (session) session.active_agent = msg.current_agent
  }))
  cleanups.push(onEvent('command_receipt', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))
  // session_meta: authoritative model name, in response to get_session_meta.
  // (session_created also carries model as an optimistic early fill below.)
  cleanups.push(onEvent('session_meta', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.model) currentModel.value = msg.model
    if (msg.effort) currentEffort.value = msg.effort
    interactionCapabilities.value = Array.isArray(msg.capabilities) ? msg.capabilities : []
    const session = allSessions.value.find((item: any) => item.session_id === msg.session_id)
    if (session) {
      if (msg.control_mode !== undefined) session.control_mode = msg.control_mode
      session.capabilities = interactionCapabilities.value
    }
    if (msg.current_agent) currentOpenCodeAgent.value = msg.current_agent
    currentPermission.value = msg.permission
    permissionMutable.value = !!msg.permission_mutable
    permissionMutableModes.value = msg.permission_mutable_modes || []
    pendingPermission.value = undefined
    if (permissionTimer) { clearTimeout(permissionTimer); permissionTimer = null }
    if (showSessionAgentPicker.value && sessionAgents.value.length === 0) requestSessionAgents()
  }))

  // session_model_changed: the daemon detected a /model switch mid-session
  // (from the next assistant message's model field). Refresh the badge live.
  cleanups.push(onEvent('session_model_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.model) currentModel.value = msg.model
    processImmediateLiveEvent(msg, { scroll: true })
  }))

  cleanups.push(onEvent('replay_batch', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return // D4: stale batch
    const isBackward = msg.direction === 'backward'
    // Relay sends every replay batch in id ASC order. Keeping this order across
    // batch boundaries lets stream assemblers receive chunk zero before later chunks.
    const evts = Array.isArray(msg.events) ? msg.events : []
    if (isLoadingBackward.value && isBackward) {
      olderReplayEvents.append(replaySessionTrustContext(), evts)
    } else {
      // Initial backward page and forward replay can render progressively.
      const replayContext = replaySessionTrustContext()
      progressiveReplayEvents.append(replayContext, evts)
      for (const evt of progressiveReplayEvents.takeReady(replayContext)) processEvent(evt)
      nextTick(scrollToBottom)
    }
  }))
  cleanups.push(onEvent('replay_end', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (msg.req_id !== undefined && msg.req_id !== replayReqId.value) return
    const wasLoadingBackward = isLoadingBackward.value
    const replayContext = replaySessionTrustContext()
    if (wasLoadingBackward) {
      prependOlderReplayEvents(olderReplayEvents.takeFinal(replayContext))
    } else {
      for (const evt of progressiveReplayEvents.takeFinal(replayContext)) processEvent(evt)
      nextTick(scrollToBottom)
    }
    isLoading.value = false
    clearHistorySlowTimer()
    isSlowLoading.value = false
    isLoadingBackward.value = false
    if (msg.has_more !== undefined) hasMore.value = !!msg.has_more
    // backward: last_seq is the oldest id of the returned page → next page cursor
    if (msg.last_seq && (!loadedMinId.value || msg.last_seq < loadedMinId.value)) loadedMinId.value = msg.last_seq
    // Session switch complete: ungate the timer watch. If the target session is
    // executing, resume timing from the recovered turn start (last executing
    // session_status's turn_started_at) so elapsed isn't reset to zero.
    // Skipped in focused-sub-agent mode: status/timer reflect the parent session
    // and don't apply to a read-only sub-agent replay.
    if (sessionSwitching) {
      sessionSwitching = false
      if (focusedSubAgentId.value) {
        // Focused sub-agent: no turn timer; status is the sub-agent's own
        // (from session_list children[]), not the parent's.
        status.value = focusedSubAgentInfo.value?.status || 'completed'
        resumeStartAt = null
      } else {
        // The placeholder status set on switch is 'running'; the relay does NOT
        // replay session_status events (only message history), so correct it from
        // the authoritative session list (DB status, kept current by the relay).
        // Without this an idle session (e.g. opencode) would look "running" and
        // start the turn timer from zero.
        const meta = allSessions.value.find((s: any) => s.session_id === sessionId.value)
        if (meta) {
          let st = meta.statusEffective === 'disconnected' ? meta.status : (meta.statusEffective || meta.status)
          // OpenCode polling can leave an abandoned turn marked executing after
          // it falls out of the sync window. Codex and Claude instead publish
          // explicit lifecycle events, and long-running tools/subagents can be
          // quiet for more than two minutes, so their persisted status must not
          // be overridden by this OpenCode-specific fallback.
          if (normalizedAgentType(meta) === 'opencode'
            && (st === 'running' || st === 'busy' || st === 'retry' || st === 'waiting')) {
            const la = meta.last_activity_at || meta.created_at
            const ageMs = la ? Date.now() - new Date(la).getTime() : Infinity
            if (ageMs > 120000) st = 'idle'
          }
          if (st) status.value = st
          const turnStartedAt = meta.turn_started_at || msg.turn_started_at
          if (turnStartedAt) resumeStartAt = new Date(turnStartedAt).getTime()
        }
        if (isExecuting.value) startTurnTimer(resumeStartAt ?? undefined)
        resumeStartAt = null
      }
    }
    reconcileVisibleUnresolvedTools(status.value)
  }))

  cleanups.push(onEvent('user_message_ack', (msg: any) => {
    if (!msg.msg_id) return
    clearAckTimeout(msg.msg_id)
    const message = messages.value.find((item: any) => item.__msg_id === msg.msg_id)
    if (!message || message.deliveryStatus === 'accepted' || message.deliveryStatus === 'failed') return
    // Managed Codex waits for its app-server receipt. Sessions without the
    // capability retain the legacy ACK-as-final behavior.
    message.deliveryStatus = message.__expects_receipt ? 'forwarded' : 'accepted'
  }))
  cleanups.push(onEvent('user_message_nack', (msg: any) => {
    if (!msg.msg_id) return
    failOrRollbackOptimistic(msg.msg_id, msg.reason || '')
  }))
  cleanups.push(onEvent('user_message_receipt', (msg: any) => {
    if (msg.session_id !== sessionId.value || (!msg.msg_id && !msg.request_id)) return
    if (msg.msg_id) clearAckTimeout(msg.msg_id)
      const message = findMessageByCorrelation(eventCorrelation(msg))
    // An input received while interrupt confirmation is outstanding did not
    // enter the old turn. Remove the optimistic echo and restore the draft so
    // the user can retry after the terminal lifecycle event arrives.
    if (msg.status === 'rejected' && msg.reason === 'turn_interrupt_pending' && msg.retryable === true && message) {
      const rejectedText = message.content || ''
      if (messageInput.value.trim()) interruptPendingDraft.value = rejectedText
      else messageInput.value = rejectedText
      const index = messages.value.indexOf(message)
      if (index >= 0) messages.value.splice(index, 1)
      showSendFailure()
      return
    }
    if (!message) return
    if (msg.status === 'accepted') {
      if (message.deliveryStatus === 'failed') return
      message.deliveryStatus = 'accepted'
      message.deliveryReason = ''
      return
    }
    message.deliveryStatus = 'failed'
    message.deliveryReason = msg.reason || ''
    showSendFailure(userMessageFailureKey(msg.reason || ''))
  }))

  cleanups.push(onEvent('user_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))

  cleanups.push(onEvent('agent_text', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    enqueueLiveContent(msg)
  }))

  cleanups.push(onEvent('agent_plan', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg)
  }))

  for (const eventType of ['agent_reasoning', 'agent_retry', 'agent_compaction', 'agent_file_change', ...openCodeStructuredTypes]) {
    cleanups.push(onEvent(eventType, (msg: any) => {
      if (msg.session_id !== sessionId.value) return
      if (isBatchableLiveContent(msg)) {
        enqueueLiveContent(msg)
        return
      }
      processImmediateLiveEvent(msg, { scroll: true })
    }))
  }

  cleanups.push(onEvent('tool_call', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
    // Arm timeout guard: if no tool_result arrives in time, the card flips to
    // 'timeout' instead of spinning forever (claude died / PTY disconnected).
    const callId = msg.call_id || msg.payload?.call_id
    if (callId) armToolTimeout(callId)
  }))

  cleanups.push(onEvent('tool_result', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    if (isBatchableLiveContent(msg)) {
      enqueueLiveContent(msg)
      return
    }
    processImmediateLiveEvent(msg)
    const callId = msg.call_id || msg.payload?.call_id
    if (callId) clearToolTimeout(callId)
  }))

  // Tool-use approval + PTY selection cards. These render via processEvent (the
  // replay path already does), but without a live handler the daemon's live
  // events were dropped — the card only appeared after a refresh (replay). Wire
  // them so they show in real time, matching the iOS app's single-dispatch path.
  cleanups.push(onEvent('approval_request', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))
  cleanups.push(onEvent('approval_resolved', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg)
  }))
  cleanups.push(onEvent('question_request', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))
  cleanups.push(onEvent('question_resolved', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg)
  }))
  cleanups.push(onEvent('mcp_elicitation_request', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))
  cleanups.push(onEvent('mcp_elicitation_resolved', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg)
  }))
  cleanups.push(onEvent('interaction_result', (msg: any) => {
    if (msg.session_id !== sessionId.value || !msg.request_id) return
    processImmediateLiveEvent(msg)
  }))
  cleanups.push(onEvent('interactive_prompt', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))

  cleanups.push(onEvent('turn_status', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))

  // Keep future/unclassified events visible, while avoiding the duplicate work
  // a catch-all listener would otherwise perform for named handlers.
  cleanups.push(onEvent((msg: any) => {
    const type = msg.type || msg.event_type || ''
    if (!type || msg.session_id !== sessionId.value || explicitlyRoutedLiveEventTypes.has(type)) return
    processImmediateLiveEvent(msg, { scroll: true })
  }))

  cleanups.push(onEvent('subagent_discovered', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    flushLiveContent()
    // P2: initialise subagent message bucket so the fold group can render even empty
    const aid = msg.agent_id || 'Agent'
    subagentMessages.value[aid] = subagentMessages.value[aid] || []
    messages.value.push({ id: nextId('sa'), type: 'subagent', tool: aid, input: msg.subagent_desc, status: 'completed', expanded: true, outputExpanded: false })
  }))

  // P2: live subagent_title_update — update fold group header with resolved title
  cleanups.push(onEvent('subagent_title_update', (msg: any) => {
    if (msg.session_id !== sessionId.value || !msg.agent_id) return
    const m: any = messages.value.find((x: any) => x.type === 'subagent' && x.tool === msg.agent_id)
    if (m && msg.title) m.title = msg.title
  }))

  // P1a: incremental subagent_usage — accumulate into childrenToken + sync subagent message
  cleanups.push(onEvent('subagent_usage', (msg: any) => {
    if (msg.session_id !== sessionId.value || !msg.agent_id) return
    const u = msg.usage || {}
    childrenToken.value[msg.agent_id] = {
      tokenIn: (childrenToken.value[msg.agent_id]?.tokenIn || 0) + (u.input_tokens || 0),
      tokenOut: (childrenToken.value[msg.agent_id]?.tokenOut || 0) + (u.output_tokens || 0),
      tokenCache: (childrenToken.value[msg.agent_id]?.tokenCache || 0) + (u.cache_read_tokens || 0),
      tokenCacheCreate: (childrenToken.value[msg.agent_id]?.tokenCacheCreate || 0) + (u.cache_create_tokens || 0),
    }
    // Sync to the matching subagent message so ToolCallCard re-renders
    const m: any = messages.value.find((x: any) => x.type === 'subagent' && x.tool === msg.agent_id)
    if (m) m.tokenUsage = { ...childrenToken.value[msg.agent_id] }
  }))

  cleanups.push(onEvent('session_status', (msg: any) => {
    const ls = allSessions.value.find((x: any) => x.session_id === msg.session_id)
    // Relays predating the lifecycle split emitted disconnected as a synthetic
    // session_status. Treat it as a connectivity overlay and keep the last
    // lifecycle state intact.
    if (msg.status === 'disconnected') {
      const daemonId = msg.daemon_id || ls?.daemon_id
      if (daemonId) setDaemonConnectivity(daemonId, false)
      return
    }
    // Keep the session-list entry fresh: the switch-time correction (replay_end)
    // reads meta.statusEffective/status from allSessions, so a stale mount-time
    // snapshot would leave a just-finished session looking "running" after a
    // switch (timer stuck/from zero). Update it on every status event.
    const sourceActivityAt = msg.last_activity_at || msg.payload?.last_activity_at
    const lastActivityAt = sourceActivityAt || (msg.resync === true ? ls?.last_activity_at || '' : new Date().toISOString())
    if (ls) {
      ls.status = msg.status
      ls.statusEffective = msg.status
      if (lastActivityAt) ls.last_activity_at = lastActivityAt
    }
    if (msg.session_id === sessionId.value) {
      const wasExecuting = isExecuting.value
      status.value = msg.status
      if (wasExecuting && !isExecuting.value && lastActivityAt) lastTurnEndedAt.value = lastActivityAt
      reconcileVisibleUnresolvedTools(msg.status)
      if (msg.exit_reason) exitReason.value = msg.exit_reason
      if (msg.exited_at) exitedAt.value = msg.exited_at
    }
  }))

  cleanups.push(onEvent('permission_config_changed', (msg: any) => {
    if (msg.session_id !== sessionId.value) return
    currentPermission.value = msg.permission
    pendingPermission.value = undefined
    if (permissionTimer) { clearTimeout(permissionTimer); permissionTimer = null }
    permissionError.value = msg.permission_effective === 'next_turn' ? t('session.permission.next_turn') : ''
  }))

  // 兜底：URL 仍是 pending 时，session_id_changed 到达则替换为真实 ID 并重新 replay
  cleanups.push(onEvent('session_id_changed', (msg: any) => {
    if (msg.old_session_id && msg.old_session_id === sessionId.value) {
      router.replace(`/session/${msg.session_id}`)
      // 清空旧消息，重新拉取真实 ID 的历史
      messages.value = []
      resetReplayTrustBuffers()
      replayReqId.value++
      isLoading.value = true
      send({ type: 'replay', session_id: msg.session_id, direction: 'backward', limit: pageSize.value, req_id: replayReqId.value })
    }
  }))

  cleanups.push(onEvent('error', (msg: any) => {
    if (msg.session_id && msg.session_id !== sessionId.value) return
    if (msg.operation === 'user_message' && (msg.msg_id || msg.request_id)) {
      const message = findMessageByCorrelation(eventCorrelation(msg))
      if (message) {
        clearAckTimeout(message.__msg_id)
        message.deliveryStatus = 'failed'
        message.deliveryReason = msg.reason || ''
        showSendFailure(userMessageFailureKey(msg.reason || ''))
        return
      }
    }
    if (['approval_response', 'question_response', 'question_reject', 'mcp_elicitation_response'].includes(msg.operation) && msg.request_id) {
      clearInteractionSubmitting(msg.request_id)
      const type = msg.operation === 'approval_response' ? 'approval_request' : msg.operation === 'mcp_elicitation_response' ? 'mcp_elicitation_request' : 'question_request'
      const card = messages.value.find((item: any) => item.type === type && item.request_id === msg.request_id)
      if (card) {
        card.submitting = false
        card.error = msg.error || 'Request failed'
      }
      return
    }
    if (msg.operation === 'list_session_agents' || msg.operation === 'set_session_agent') {
      sessionAgentsLoading.value = false
      sessionAgentSubmitting.value = false
      sessionAgentError.value = msg.error || (msg.operation === 'list_session_agents' ? 'Agent list unavailable' : 'Agent switch failed')
      if (sessionAgentListTimer) { clearTimeout(sessionAgentListTimer); sessionAgentListTimer = null }
      if (sessionAgentSwitchTimer) { clearTimeout(sessionAgentSwitchTimer); sessionAgentSwitchTimer = null }
      return
    }
    if (pendingPermission.value) {
      pendingPermission.value = undefined
      if (permissionTimer) { clearTimeout(permissionTimer); permissionTimer = null }
      permissionError.value = msg.error || t('session.permission.failed')
      requestSessionMeta()
      return
    }
    // 带可区分 code 的错误(来自 relay 路由层):停止操作的失败显示为按钮旁的
    // 临时提示,而非消息气泡 —— 避免把"daemon 重连中"这类可恢复状态写进消息流。
    const code = msg.code
    if (code === 'daemon_unreachable' || code === 'session_not_found') {
      const key = code === 'daemon_unreachable' ? 'session.stop_daemon_unreachable' : 'session.stop_session_not_found'
      stopError.value = t(key)
      if (stopErrorTimer) clearTimeout(stopErrorTimer)
      stopErrorTimer = setTimeout(() => { stopError.value = '' }, 3500)
      return
    }
    // Native assistant errors are durable events and must share the replay
    // path so live delivery and refresh use the same event-key deduplication.
    if (msg.event_id || msg.message_id || msg.payload?.event_id || msg.payload?.message_id) {
      processImmediateLiveEvent(msg)
    } else {
      messages.value.push({ id: nextId('e'), type: 'error', content: msg.error || '未知错误' })
    }
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

  // Register every consumer before connecting and requesting replay. A fast
  // replay must never race ahead of its handlers, and auxiliary requests below
  // cannot prevent already-sent history from being consumed.
  connect()
  send({ type: 'list_sessions' })
  send({ type: 'list_daemons' })
  // Gate the timer watch for the initial load too: status defaults to 'running'
  // until replay/session metadata supplies the authoritative state.
  sessionSwitching = true
  loadHistory()
})

// SessionActions handlers (optimistic local updates)
function onDeleted(_sessionId: string) { /* handled by session_deleted WS event */ }
function onPinned(sessionId: string, pinned: boolean) {
  const s = allSessions.value.find((x: any) => x.session_id === sessionId)
  if (s) (s as any).pinned = pinned
}

onUnmounted(() => {
  clearHistorySlowTimer()
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  for (const fn of cleanups) fn()
  cleanups.length = 0
  liveContentBatcher.dispose()
  document.removeEventListener('click', closePermMenu)
  window.removeEventListener('keydown', onFileChangePanelKeydown)
  if (turnTimer) { clearInterval(turnTimer); turnTimer = null }
  if (stopResetTimer) { clearTimeout(stopResetTimer); stopResetTimer = null }
  if (sessionAgentListTimer) { clearTimeout(sessionAgentListTimer); sessionAgentListTimer = null }
  if (sessionAgentSwitchTimer) { clearTimeout(sessionAgentSwitchTimer); sessionAgentSwitchTimer = null }
  clearAllToolTimeouts()
  for (const timer of interactionSubmitTimers.values()) clearTimeout(timer)
  interactionSubmitTimers.clear()
  for (const timer of pendingAckTimers.values()) clearTimeout(timer)
  pendingAckTimers.clear()
  interactionResolutions.clear()
  interruptPendingDraft.value = ''
  clearSessionHeader()
})

function closePermMenu(e: MouseEvent) {
  if (permDropdownEl.value && !permDropdownEl.value.contains(e.target as Node)) {
    showPermMenu.value = false
  }
  if (toolbarOverflowEl.value && !toolbarOverflowEl.value.contains(e.target as Node)) {
    toolbarOverflowOpen.value = false
  }
  if (agentFilterEl.value && !agentFilterEl.value.contains(e.target as Node)) {
    agentFilterOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', closePermMenu)
  window.addEventListener('keydown', onFileChangePanelKeydown)
})
</script>

<style>
.session-layout { position: relative; display: flex; flex: 1; width: 100%; min-width: 0; height: calc(100dvh - var(--topbar-h)); overflow: hidden; }

/* Session Panel */
.session-panel { width: 282px; background: var(--bg-secondary); border-right: 1px solid var(--sidebar-border); display: flex; flex-direction: column; flex-shrink: 0; transition: background var(--transition), border-color var(--transition); }
.session-panel-header { min-height: 66px; padding: 10px 14px 10px 16px; border-bottom: 1px solid var(--sidebar-border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.session-panel-heading-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session-panel-header h3 { min-width: 0; overflow: hidden; color: var(--fg); font-size: 13px; font-weight: 650; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.session-panel-heading-copy > span { overflow: hidden; color: var(--fg-tertiary); font: 10px/14px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.session-new-button { width: 32px; height: 32px; flex: 0 0 auto; border-color: var(--border); background: var(--surface); color: var(--accent); box-shadow: none; }
.session-new-button:hover { border-color: var(--border-light); background: var(--surface-hover); color: var(--accent-hover); }
.agent-filter-popover { position: relative; padding: 8px 10px; border-bottom: 1px solid var(--sidebar-border); }
.agent-filter-trigger { width: 100%; min-width: 0; height: 34px; display: grid; grid-template-columns: 18px minmax(0, 1fr) 18px; align-items: center; gap: 8px; padding: 0 10px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: var(--surface); cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.agent-filter-trigger:hover, .agent-filter-trigger[aria-expanded="true"] { border-color: var(--border-light); color: var(--fg); background: var(--surface-hover); }
.agent-filter-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.agent-filter-trigger > svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.agent-filter-chevron { justify-self: end; transition: transform .15s ease; }
.agent-filter-trigger[aria-expanded="true"] .agent-filter-chevron { transform: rotate(180deg); }
.agent-filter-trigger-label { min-width: 0; overflow: hidden; font-size: 11.5px; font-weight: 600; line-height: 1; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.agent-filter-menu { position: absolute; z-index: 60; top: calc(100% - 3px); right: 10px; left: 10px; display: flex; flex-direction: column; gap: 2px; padding: 5px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); }
.agent-filter-option { width: 100%; min-width: 0; min-height: 34px; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 8px; overflow: hidden; border: 0; border-radius: var(--radius-sm); color: var(--fg-secondary); background: transparent; font: 12px/1.2 var(--font-body); text-align: left; cursor: pointer; }
.agent-filter-option:hover, .agent-filter-option:focus-visible { color: var(--fg); background: var(--surface-hover); outline: none; }
.agent-filter-option[aria-checked="true"] { color: var(--fg); background: var(--accent-muted); }
.agent-filter-check { width: 14px; height: 14px; opacity: 0; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.agent-filter-option[aria-checked="true"] .agent-filter-check { opacity: 1; }
.agent-filter-option-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-filter-count { min-width: 20px; color: var(--fg-tertiary); font: 10.5px/1 var(--font-mono); text-align: right; }
.session-panel-presence { display: flex; align-items: center; gap: 7px; min-height: 30px; padding: 7px 14px 5px; }
.session-panel-presence .status-dot { width: 6px; height: 6px; flex: 0 0 auto; }
.session-panel-presence-copy { min-width: 0; overflow: hidden; color: var(--fg-tertiary); font-size: 11px; line-height: 16px; text-overflow: ellipsis; white-space: nowrap; }
.session-list { flex: 1; overflow-y: auto; padding: 6px 8px 16px; scrollbar-gutter: stable; }
.sl-fold { cursor: pointer; font-size: 12px; color: var(--fg-tertiary); user-select: none; line-height: 1; flex-shrink: 0; width: 12px; text-align: center; transition: color 0.15s; }
.sl-fold:hover { color: var(--fg); }
.sl-children { padding: 2px 0 6px 26px; display: flex; flex-direction: column; gap: 2px; }
.sl-child { display: flex; align-items: center; gap: 6px; padding: 3px 6px; font-size: 12px; color: var(--fg-secondary); border-radius: var(--radius-sm); cursor: pointer; transition: background var(--transition), color var(--transition); }
.sl-child:hover { background: var(--hover); color: var(--fg); }
.sl-child.active { background: var(--accent-bg, rgba(99,102,241,0.12)); color: var(--accent); }
.sl-child-indent { color: var(--fg-tertiary); flex-shrink: 0; }
.sl-child-title { color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-list-item { display: flex; align-items: center; gap: 9px; min-height: 54px; padding: 8px 9px; border: 1px solid transparent; border-radius: var(--radius-md); cursor: pointer; transition: background 0.15s, border-color 0.15s, opacity 0.25s ease, transform .15s ease; margin-bottom: 3px; }
.session-list-item:hover { border-color: var(--border); background: var(--surface-hover); }
.session-list-item.pending-delete { opacity: 0.35; pointer-events: none; }
.session-list-item.active { border-color: color-mix(in srgb, var(--accent) 28%, transparent); background: var(--sidebar-active); box-shadow: inset 2px 0 0 var(--accent); }
.session-list-item .sl-info { flex: 1; min-width: 0; }
.session-list-item .sl-title { overflow: hidden; color: var(--fg); font-size: 13px; font-weight: 600; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.session-list-item .pin-icon { color: var(--accent); flex-shrink: 0; vertical-align: middle; }
.session-list-item .ss-rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: var(--radius-sm); box-shadow: 0 0 0 3px var(--accent-muted); color: var(--fg); font-family: var(--font-body); font-size: 13px; font-weight: 500; padding: 3px 6px; outline: none; width: 100%; }
.session-list-item .sl-title.mono { font-family: var(--font-mono); font-size: 12px; color: var(--accent); }
.session-list-item .sl-meta { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: 3px; overflow: hidden; color: var(--fg-tertiary); font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
.session-list-item .sl-meta .agent-badge { flex-shrink: 0; }

/* Chat Area */
.chat-area { --composer-float-clearance: 156px; --session-content-gutter: max(20px, calc(50% - 460px)); flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; max-width: 100%; overflow: hidden; background: var(--bg); transition: background var(--transition); }

/* Toolbar: identity is allowed to shrink; actions always retain a stable lane. */
.chat-toolbar { min-height: 62px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 7px 58px 7px 18px; gap: 16px; background: color-mix(in srgb, var(--topbar-bg) 92%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); transition: background var(--transition), border-color var(--transition); }
.session-toolbar-identity { flex: 1 1 auto; min-width: 120px; display: flex; align-items: center; gap: 10px; }
.session-toolbar-back { width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center; border: 1px solid transparent; border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; cursor: pointer; }
.session-toolbar-back:hover { color: var(--fg); border-color: var(--border); background: var(--surface-hover); }
.session-toolbar-back:focus-visible, .toolbar-more-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.session-toolbar-back svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.session-toolbar-titles { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
.session-toolbar-title, .session-toolbar-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-toolbar-title { color: var(--fg); font-size: 14px; font-weight: 650; line-height: 19px; letter-spacing: -0.01em; }
.session-toolbar-host { display: flex; align-items: center; gap: 6px; color: var(--fg-tertiary); font: 10.5px/14px var(--font-mono); }
.session-toolbar-host i { width: 3px; height: 3px; flex: 0 0 auto; border-radius: 50%; background: currentColor; opacity: .7; }
.session-toolbar-host span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-toolbar-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; }
.session-toolbar-actions > .context-pill,
.session-toolbar-actions > .model-pill,
.session-toolbar-actions > .effort-pill { display: none; }
.plan-toolbar-button { min-height: 32px; display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; font: 600 11px/1 var(--font-mono); cursor: pointer; }
.plan-toolbar-button:hover { color: var(--fg); background: var(--surface-hover); }
.plan-toolbar-button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }
.plan-toolbar-button.complete { color: var(--success); }
.plan-toolbar-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.file-change-toolbar-button { min-height: 32px; display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; font: 600 11px/1 var(--font-mono); cursor: pointer; }
.file-change-toolbar-button:hover { color: var(--fg); background: var(--surface-hover); }
.file-change-toolbar-button.active { border-color: var(--accent); color: var(--accent); background: var(--accent-muted); }
.file-change-toolbar-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.file-change-panel-backdrop { position: absolute; z-index: 44; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: rgba(1, 4, 9, .48); backdrop-filter: blur(2px); cursor: default; }
.file-change-side-panel { position: absolute; z-index: 45; inset: 0 0 0 auto; width: clamp(760px, 72vw, 1180px); min-width: 0; max-width: calc(100% - 72px); height: 100%; display: flex; flex-direction: column; overflow: hidden; border-left: 1px solid var(--border-light); background: var(--surface); box-shadow: -24px 0 72px rgba(0, 0, 0, .42); }
.file-change-panel-heading { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex: 0 0 auto; padding: 10px 10px 10px 18px; border-bottom: 1px solid var(--border); }
.file-change-panel-heading h2 { margin: 0; color: var(--fg); font-size: 14px; font-weight: 650; }
.file-change-panel-heading span { display: block; margin-top: 4px; color: var(--fg-tertiary); font: 11px/1 var(--font-mono); }
.file-change-panel-close { width: 44px; height: 44px; display: grid; place-items: center; flex: 0 0 auto; border: 0; border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; cursor: pointer; }
.file-change-panel-close:hover { color: var(--fg); background: var(--surface-hover); }
.file-change-panel-close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.file-change-panel-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.file-change-panel-list { min-height: 0; display: flex; flex: 1; flex-direction: column; gap: 10px; overflow-y: auto; padding: 12px 14px 18px; background: var(--bg); scrollbar-gutter: stable; }
.file-change-panel-list .file-change-card { width: 100%; flex: 0 0 auto; }
@media (max-width: 1120px) and (min-width: 769px) { .file-change-side-panel { width: 94vw; max-width: 94vw; } }
.status-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; }
.status-pill.running { background: var(--success-bg); color: var(--success); }
.status-pill .pulse { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: pulse-green 1.5s infinite; }
.model-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; background: var(--accent-muted); color: var(--accent); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.effort-pill { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; background: var(--warning-bg); color: var(--warning); white-space: nowrap; }

.session-id-box { min-height: 32px; display: flex; align-items: center; gap: 6px; padding: 3px 5px 3px 9px; background: transparent; border: 1px solid var(--border); border-radius: var(--radius-md); }
.session-id-text { font-family: var(--font-mono); font-size: 12px; color: var(--fg-secondary); }
.copy-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; background: none; border: none; color: var(--fg-tertiary); cursor: pointer; border-radius: 4px; padding: 0; transition: color 0.15s, background 0.15s; }
.copy-btn:hover { color: var(--accent); background: var(--accent-muted); }
.toolbar-overflow { position: absolute; z-index: 55; top: 15px; right: 18px; flex: 0 0 auto; }
.toolbar-more-btn { width: 32px; height: 32px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; cursor: pointer; }
.toolbar-more-btn:hover, .toolbar-more-btn[aria-expanded="true"] { color: var(--fg); border-color: var(--accent); background: var(--accent-muted); }
.toolbar-more-btn svg { width: 17px; height: 17px; fill: currentColor; }
.toolbar-overflow-menu { position: absolute; z-index: 55; top: calc(100% + 8px); right: 0; width: 248px; display: block; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-lg); animation: menu-in .14s ease-out; }
.toolbar-overflow-metrics { display: flex; flex-wrap: wrap; gap: 5px; padding: 5px 5px 9px; border-bottom: 1px solid var(--border); }
.toolbar-overflow-metrics:empty { display: none; }
.toolbar-overflow-metric { max-width: 100%; overflow: hidden; padding: 4px 7px; border-radius: var(--radius-full); color: var(--fg-secondary); background: var(--surface-active); font: 10px/1 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.toolbar-overflow-item { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 9px; border: 0; border-radius: var(--radius-sm); color: var(--fg-secondary); background: transparent; font: 12px/1.5 var(--font-body); text-align: left; cursor: pointer; }
.toolbar-overflow-item:hover { color: var(--fg); background: var(--surface-hover); }
.toolbar-overflow-item code { color: var(--fg-tertiary); font: 10px/1 var(--font-mono); }
.toolbar-overflow-action { width: 100%; font: 12px/1.5 var(--font-body); }
.toolbar-overflow-action.active { color: var(--accent); background: var(--accent-muted); }
.toolbar-overflow-action.complete { color: var(--success); }
.toolbar-overflow-item-label { min-width: 0; display: inline-flex; align-items: center; gap: 8px; overflow: hidden; }
.toolbar-overflow-item-label > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar-overflow-item-label svg { width: 15px; height: 15px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.toolbar-overflow-separator { height: 1px; margin: 5px 4px; background: var(--border); }
@keyframes menu-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

/* Messages */
.chat-messages { flex: 1; min-height: 0; width: 100%; overflow-y: auto; overflow-x: hidden; padding: 24px var(--session-content-gutter) calc(24px + var(--composer-float-clearance)); display: flex; flex-direction: column; align-items: stretch; gap: 14px; position: relative; overflow-anchor: none; scrollbar-gutter: stable; background: var(--bg); }
/* min-width:0 lets long content (code/URLs) wrap instead of overflowing
   horizontally. max-width + center keeps lines readable on wide screens.
   User bubbles are excluded (they use fit-content + right align). */
/* Agent text: adaptive width — short replies stay narrow, long content grows to 760px.
   Left-aligned (natural document flow), unlike centered tool cards. */
.chat-messages > .agent-block { min-width: 0; max-width: 760px; width: fit-content; align-self: flex-start; }
/* Errors / banners: full width within 860px, centered. (tool-wrap + receipt-card excluded — left-aligned) */
.chat-messages > *:not(.msg):not(.agent-block):not(.tool-wrap):not(.tool-call-group):not(.receipt-card):not(.turn-status-bar) { min-width: 0; max-width: 860px; width: 100%; align-self: center; }
/* Tool cards: left-aligned, not centered. */
.chat-messages > .tool-wrap, .chat-messages > .tool-call-group { min-width: 0; max-width: 860px; width: 100%; align-self: flex-start; }
.chat-messages > *.msg { min-width: 0; max-width: 78%; }
.chat-messages > .banner { margin-bottom: 0; }
.chat-messages > .messages-bottom-spacer { width: 100%; max-width: none; min-height: 0; flex: 1 0 0; }
.turn-group-header { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 860px; width: 100%; align-self: center; padding: 9px 2px 2px; border: 0; border-top: 1px solid var(--border); border-radius: 0; color: var(--fg-secondary); background: transparent; font: 600 11px/1 var(--font-mono); }
.turn-group-label { color: var(--fg-tertiary); text-transform: uppercase; letter-spacing: .04em; }
.turn-group-state { color: var(--warning); }
.turn-group-continuation { color: var(--accent); }
.turn-group-aux-toggle { margin-left: auto; padding: 4px 7px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-secondary); background: transparent; font: inherit; cursor: pointer; }
.turn-group-aux-toggle:hover { color: var(--fg); }
.turn-unknown-event { min-width: 0; max-width: 820px; width: 100%; align-self: center; padding: 10px 12px; border-left: 3px solid var(--warning); color: var(--fg-secondary); background: var(--surface); font: 12px/1.45 var(--font-mono); }
.request-deep-link-target { animation: request-deep-link-highlight 1.8s ease-out; }
@keyframes request-deep-link-highlight {
  0%, 30% { outline: 3px solid var(--warning); outline-offset: 3px; }
  100% { outline: 3px solid transparent; outline-offset: 6px; }
}

/* Empty state */
.session-history-loading { min-height: 180px; display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 20px; color: var(--fg-secondary); text-align: center; }
.session-history-spinner { width: 28px; height: 28px; border: 2px solid var(--border-light); border-top-color: var(--accent); border-radius: 50%; animation: session-history-spin .8s linear infinite; }
.session-history-loading-title { font-size: 14px; font-weight: 600; }
.session-history-loading-slow { max-width: 360px; color: var(--fg-tertiary); font-size: 12px; line-height: 1.5; }
.session-history-retry { min-height: 36px; margin-top: 2px; padding: 7px 16px; border: 1px solid var(--border-light); border-radius: var(--radius-md); color: var(--accent); background: var(--surface); font: 600 13px/1 var(--font-body); cursor: pointer; }
.session-history-retry:hover { border-color: var(--accent); background: var(--accent-muted); }
.session-history-retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@keyframes session-history-spin { to { transform: rotate(360deg); } }
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
.scroll-to-bottom { position: absolute; top: -40px; left: 50%; transform: translateX(-50%); width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--fg-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 10px rgba(0,0,0,0.3); transition: background 0.15s, color 0.15s; z-index: 50; pointer-events: auto; }
.scroll-to-bottom:hover { background: var(--surface-hover); color: var(--fg); }
.scroll-btn-enter-active, .scroll-btn-leave-active { transition: opacity 0.25s ease; }
.scroll-btn-enter-from, .scroll-btn-leave-to { opacity: 0; }

/* Messages — message type styles (msg-user/msg-agent/tool-card/msg-error)
   now live in their own components under components/messages/. The timeline
   and chat-input styles below remain here because they are layout concerns
   of this view, not reusable message rendering. */

/* Timeline */
.timeline { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 2px; flex-shrink: 0; }
.timeline .milestone { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.timeline .milestone .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
.timeline .milestone .dot.active { background: var(--success); }
.timeline .milestone .dot.current { background: var(--success); animation: pulse-green 1.5s infinite; }
.timeline .milestone .label { font-size: 11px; color: var(--fg-tertiary); }
.timeline .milestone .label.active { color: var(--fg-secondary); }
.timeline .milestone .time { font-size: 10px; color: var(--fg-tertiary); font-family: var(--font-mono); }
.timeline .line { flex: 1; height: 1px; background: var(--border); margin: 0 12px; align-self: flex-start; margin-top: 4px; }
.timeline .line.done { background: var(--success); }

/* Floating composer: sits on the session surface without reserving a separate
   footer. The message list owns matching bottom clearance so its final row can
   still scroll above the composer. */
.chat-input-area { position: absolute; z-index: 4; right: 0; bottom: 0; left: 0; padding: 0 var(--session-content-gutter) 20px; background: transparent; pointer-events: none; }
.chat-input-area.ended { display: flex; align-items: center; justify-content: center; padding: 0 var(--session-content-gutter) 20px; }
.ended-text { color: var(--fg-tertiary); font-size: 13px; }
.readonly-hint { color: var(--fg-tertiary); font-size: 13px; font-style: italic; }
.unmanaged-readonly-notice { width: min(760px, 100%); display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 12px; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border)); border-radius: var(--radius-lg); color: var(--fg-secondary); background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: var(--shadow-md), inset 3px 0 0 color-mix(in srgb, var(--accent) 70%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); animation: bar-in .18s ease-out; }
.unmanaged-readonly-icon { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border)); border-radius: 11px; color: var(--accent); background: var(--accent-muted); }
.unmanaged-readonly-icon svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.unmanaged-readonly-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.unmanaged-readonly-heading { display: flex; align-items: center; gap: 7px; }
.unmanaged-readonly-heading strong { color: var(--fg); font-size: 12px; font-weight: 650; letter-spacing: .01em; }
.unmanaged-readonly-heading small { padding: 2px 6px; border-radius: var(--radius-full); color: var(--accent); background: var(--accent-muted); font-size: 9px; font-weight: 650; line-height: 1.3; }
.unmanaged-readonly-description { overflow: hidden; color: var(--fg-tertiary); font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.unmanaged-readonly-agent { max-width: 112px; overflow: hidden; padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--fg-secondary); background: var(--surface-active); font: 10px/1 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }

.chat-input-container { position: relative; container-type: inline-size; pointer-events: auto; background: var(--surface); border: 1px solid var(--border-light); border-radius: var(--radius-xl); box-shadow: var(--shadow-md); transition: border-color 0.15s, box-shadow 0.15s, background var(--transition); }
.chat-input-container.focused { border-color: var(--border-focus); box-shadow: var(--shadow-md), 0 0 0 3px var(--accent-muted); }

.chat-textarea { width: 100%; background: none; border: none; color: var(--fg); font-size: 14px; font-family: var(--font-body); line-height: 1.55; outline: none; resize: none; padding: 13px 16px 5px; min-height: 64px; max-height: 400px; overflow-y: auto; }
/* Drag handle above the textarea — user drags up/down to resize; the handle
   rides the container's top edge and moves with it as height changes. */
.textarea-resize-handle { height: 6px; margin: 4px 8px 0; cursor: ns-resize; display: flex; align-items: center; justify-content: center; border-radius: 3px; transition: background 0.15s; }
.textarea-resize-handle::after { content: ''; width: 32px; height: 3px; border-radius: 2px; background: var(--border-light); transition: background 0.15s; }
.textarea-resize-handle:hover::after { background: var(--accent); }
.chat-textarea::placeholder { color: var(--fg-tertiary); }
.chat-textarea:disabled { opacity: 0.5; }

/* Bottom control row */
.input-controls { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; padding: 7px 9px 9px 12px; gap: 8px; }

/* Permission dropdown (left) */
.perm-dropdown { position: relative; }
.perm-trigger { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; background: none; border: none; color: var(--fg-secondary); font-size: 12px; cursor: pointer; border-radius: var(--radius-sm); transition: color 0.15s, background 0.15s; font-family: var(--font-body); }
.perm-trigger:hover { color: var(--fg); background: var(--surface-hover); }
.perm-trigger:disabled { opacity: .45; cursor: not-allowed; }
.perm-label { font-weight: 500; }

/* Current model pill (right) */
.model-pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); cursor: default; max-width: 180px; }
.model-pill svg { flex-shrink: 0; }
.model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.perm-menu { position: absolute; bottom: calc(100% + 4px); left: 0; min-width: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: 0 4px 16px rgba(0,0,0,0.3); padding: 4px; z-index: 30; }
.perm-menu-item { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 8px 10px; background: none; border: none; color: var(--fg); font-size: 13px; cursor: pointer; border-radius: var(--radius-sm); transition: background 0.1s; font-family: var(--font-body); }
.perm-menu-item:hover { background: var(--surface-hover); }
.perm-menu-item.active { color: var(--accent); }
.perm-menu-item.active svg { color: var(--accent); }
.perm-menu-item:disabled { opacity: .45; cursor: not-allowed; }
.perm-menu-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
.perm-menu-copy small { color: var(--fg-tertiary); font-size: 11px; font-weight: 400; }
.permission-error { position: absolute; left: 0; bottom: 100%; margin-bottom: 6px; white-space: nowrap; color: var(--warning); font-size: 11px; }
.perm-menu-enter-active, .perm-menu-leave-active { transition: opacity 0.15s, transform 0.15s; }
.perm-menu-enter-from, .perm-menu-leave-to { opacity: 0; transform: translateY(4px); }

/* Metadata can shrink independently; actions always keep their hit target. */
.input-meta { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.input-meta .model-pill { min-width: 0; flex: 0 1 auto; max-width: 180px; }
.input-actions { display: flex; align-items: center; gap: 8px; }
.ctx-indicator { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; font-size: 11px; color: var(--fg-tertiary); font-family: var(--font-mono); cursor: help; white-space: pre-line; }

.action-btn { width: 32px; height: 32px; border-radius: 50%; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.15s, opacity 0.15s; }

@container (max-width: 620px) {
  .input-controls { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
  .input-meta { grid-column: 1 / -1; grid-row: 1; justify-content: flex-start; }
  .perm-dropdown { grid-column: 1; grid-row: 2; }
  .input-actions { grid-column: 2; grid-row: 2; }
  .input-meta .model-pill { max-width: 120px; }
  .effort-prefix { display: none; }
}
.send-btn { background: var(--accent); color: #fff; }
.send-btn:hover:not(:disabled) { background: var(--accent-hover); }
.send-btn:disabled { background: var(--border); color: var(--fg-tertiary); cursor: not-allowed; }
.stop-btn { background: var(--fg); color: var(--bg); }
.stop-btn:hover:not(:disabled) { opacity: 0.85; }
.stop-btn:disabled { background: var(--border); color: var(--fg-tertiary); cursor: not-allowed; }
.stop-btn.escalated { background: #e5484d; animation: stop-pulse 1s ease-in-out infinite; }
@keyframes stop-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }

/* 停止操作错误提示:relay 返回 daemon_unreachable/session_not_found 时,
   在停止按钮旁短暂提示,3.5s 自动消失。不写入消息流。 */
.stop-error-hint {
  font-size: 11px;
  color: var(--fg-tertiary);
  white-space: nowrap;
  margin-right: 4px;
}
.opencode-notice {
  align-self: flex-start;
  max-width: 720px;
  padding: 5px 9px;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--fg-tertiary);
  font-size: 12px;
}
.model-switch-notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  max-width: 720px;
  padding: 5px 2px;
  color: var(--fg-tertiary);
  font-size: 12px;
}
.model-switch-notice svg { flex-shrink: 0; color: var(--accent); }
.model-switch-notice code { color: var(--fg-secondary); font: 600 11px/1.2 var(--font-mono); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

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
.turn-status-bar .status-ended-at { color: var(--fg-tertiary); font: 11px/1.2 var(--font-mono); white-space: nowrap; }
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

@media (max-width: 1024px) {
  .session-layout { height: calc(100dvh - var(--topbar-h)); }
  .session-panel { width: 260px; }
}
@media (max-width: 1180px) and (min-width: 769px) {
  .session-toolbar-actions > .context-pill,
  .session-toolbar-actions > .model-pill,
  .session-toolbar-actions > .effort-pill,
  .session-id-box { display: none; }
}
@media (max-width: 900px) and (min-width: 769px) {
  .chat-toolbar { padding: 7px 52px 7px 12px; gap: 8px; }
  .status-pill { padding: 5px 7px; }
  .status-pill-label { display: none; }
  .session-toolbar-identity { min-width: 0; }
}
@media (max-width: 768px) {
  .session-layout { height: calc(var(--visual-viewport-bottom, 100dvh) - var(--mobile-topbar-h)); }
  .chat-area { --composer-float-clearance: 112px; --session-content-gutter: 14px; }
  .session-panel,
  .chat-toolbar { display: none; }
  .mobile-session-toolbar-overflow {
    position: fixed;
    z-index: 82;
    top: max(6px, env(safe-area-inset-top));
    right: 12px;
  }
  .mobile-session-toolbar-overflow .toolbar-more-btn {
    width: 44px;
    height: 44px;
    border-color: transparent;
    border-radius: var(--radius-md);
    color: var(--fg);
    background: transparent;
  }
  .mobile-session-toolbar-overflow .toolbar-more-btn:active,
  .mobile-session-toolbar-overflow .toolbar-more-btn[aria-expanded="true"] { border-color: transparent; color: var(--accent); background: var(--accent-muted); }
  .mobile-session-toolbar-overflow .toolbar-more-btn svg { width: 21px; height: 21px; }
  .mobile-session-toolbar-overflow .toolbar-overflow-menu {
    position: fixed;
    top: calc(var(--mobile-topbar-h) + 7px);
    right: 10px;
    width: min(300px, calc(100vw - 20px));
    max-height: calc(var(--visual-viewport-height, 100dvh) - var(--mobile-topbar-h) - 20px);
    overflow-y: auto;
    padding: 8px;
    border-color: var(--border-light);
    border-radius: var(--radius-xl);
    box-shadow: 0 18px 48px rgba(0, 0, 0, .34);
  }
  .mobile-session-toolbar-overflow .toolbar-overflow-metrics { gap: 6px; padding: 6px 6px 10px; }
  .mobile-session-toolbar-overflow .toolbar-overflow-item { min-height: 44px; padding: 10px 11px; font-size: 14px; }
  .mobile-session-toolbar-overflow .toolbar-overflow-item code { font-size: 11px; }
  .file-change-panel-backdrop { position: fixed; z-index: 88; inset: 0; display: block; background: rgba(0, 0, 0, .42); backdrop-filter: blur(2px); }
  .file-change-side-panel {
    position: fixed;
    z-index: 89;
    inset: auto 0 0;
    width: 100%;
    max-width: none;
    height: min(72%, 680px);
    display: flex;
    border: 1px solid var(--border-light);
    border-bottom: 0;
    border-radius: 18px 18px 0 0;
    box-shadow: 0 -14px 42px rgba(0, 0, 0, .34);
  }
  .file-change-panel-heading { min-height: 58px; padding: 8px 8px 8px 16px; }
  .file-change-panel-list { padding: 10px 10px max(18px, env(safe-area-inset-bottom)); }
  .chat-messages { padding: 14px var(--session-content-gutter) calc(14px + var(--composer-float-clearance)); gap: 12px; }
  .chat-input-area {
    padding: 0 10px max(10px, env(safe-area-inset-bottom));
  }
  .chat-input-area.composer-focused { padding-bottom: 7px; }
  .unmanaged-readonly-notice { grid-template-columns: 34px minmax(0, 1fr); gap: 10px; padding: 10px; border-radius: var(--radius-md); }
  .unmanaged-readonly-icon { width: 34px; height: 34px; border-radius: 10px; }
  .unmanaged-readonly-agent { display: none; }
  .unmanaged-readonly-description { white-space: normal; }
  .textarea-resize-handle { display: none; }
  .chat-input-container {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    grid-template-rows: minmax(31px, auto) auto;
    column-gap: 6px;
    overflow: visible;
    padding: 0 6px 6px 11px;
    border-radius: 15px;
    background: color-mix(in srgb, var(--surface) 96%, transparent);
    box-shadow: 0 12px 32px rgba(0, 0, 0, .38);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }
  .chat-input-container.focused {
    border-color: var(--border-light);
    box-shadow: 0 12px 32px rgba(0, 0, 0, .38);
  }
  .chat-textarea {
    grid-column: 1;
    grid-row: 2;
    min-width: 0;
    min-height: 50px;
    max-height: 112px;
    display: block;
    overflow-y: auto;
    resize: none;
    padding: 8px 2px 7px;
    font-size: 16px;
    line-height: 1.45;
    caret-color: var(--accent);
  }
  .chat-input-container.focused .chat-textarea { min-height: 46px; }
  .input-controls { display: contents; }
  .perm-dropdown {
    grid-column: 1;
    grid-row: 1;
    align-self: center;
    justify-self: start;
    min-width: 0;
    margin-left: -3px;
    z-index: 2;
  }
  .perm-trigger {
    min-width: 0;
    height: 25px;
    gap: 4px;
    padding: 0 7px;
    border-radius: 7px;
    font-size: 10px;
    white-space: nowrap;
  }
  .perm-trigger > svg:first-child { width: 12px; height: 12px; flex: 0 0 auto; }
  .perm-label { overflow: hidden; text-overflow: ellipsis; }
  .perm-menu {
    bottom: calc(100% + 7px);
    left: -8px;
    width: min(250px, calc(100vw - 40px));
    padding: 5px;
    border-color: var(--border-light);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
  }
  .perm-menu-item { min-height: 48px; padding: 7px 9px; border-radius: 8px; }
  .perm-menu-copy small { margin-top: 2px; font-size: 10px; }
  .input-meta {
    grid-column: 1 / 3;
    grid-row: 1;
    align-self: center;
    justify-self: end;
    max-width: calc(100% - 112px);
    gap: 5px;
    margin-right: 2px;
    overflow: hidden;
  }
  .input-meta .model-pill {
    height: 25px;
    max-width: 100px;
    gap: 4px;
    padding: 0 7px;
    border-radius: 7px;
    font-size: 10px;
  }
  .input-meta .model-pill svg { width: 12px; height: 12px; }
  .ctx-indicator {
    height: 25px;
    flex: 0 0 auto;
    gap: 4px;
    padding: 0 4px;
    font-size: 9px;
    white-space: nowrap;
  }
  .ctx-indicator svg { width: 12px; height: 12px; }
  .chat-input-container.focused .ctx-indicator { display: none; }
  .input-actions {
    grid-column: 2;
    grid-row: 2;
    align-self: end;
    justify-self: end;
    position: relative;
    display: grid;
    place-items: center;
    gap: 0;
    padding-bottom: 1px;
  }
  .action-btn {
    width: 42px;
    height: 42px;
    border-radius: 12px;
    transition: transform 100ms ease, opacity 100ms ease, background 100ms ease;
  }
  .action-btn:active:not(:disabled) { transform: scale(.94); }
  .send-btn:disabled,
  .stop-btn:disabled { color: var(--fg-tertiary); background: var(--surface-active); }
  .stop-btn { color: var(--error); background: var(--error-bg); }
  .stop-error-hint {
    position: absolute;
    right: 0;
    bottom: calc(100% + 7px);
    max-width: calc(100vw - 40px);
    overflow: hidden;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    box-shadow: var(--shadow-md);
    text-overflow: ellipsis;
  }
}
@media (prefers-reduced-motion: reduce) {
  .session-history-spinner { animation-duration: 1.8s; }
  .request-deep-link-target { animation: none; outline: 2px solid var(--warning); }
}
</style>
