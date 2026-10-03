<template>
  <div ref="listRoot" class="session-list">
    <template v-if="isMobile">
      <header class="mobile-session-nav">
        <button class="mobile-session-back" type="button" :aria-label="t('workspace.open_navigation')" @click="openWorkspaceNavigation">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>

        </button>
        <div class="mobile-session-host">
          <strong class="mobile-session-nav-title">{{ t(archivedView ? 'team.task_filter.archived' : 'mobile.host_sessions') }}</strong>
          <small class="mobile-session-host-caption" :title="hostId ? daemonDisplayName : t('token.all_hosts')">{{ hostId ? daemonDisplayName : t('token.all_hosts') }}</small>

        </div>
        <div class="mobile-session-nav-actions">
          <button v-if="teamAccess.enabled.value" class="mobile-team-shortcut" type="button" :aria-label="t('workspace.team_shared_sessions')" @click="$router.push('/teams?tab=sessions')"><WorkspaceIcon name="teams" /></button>
          <AttentionInboxEntryButton
            class="mobile-session-inbox"
            variant="nav"
            icon="bell"
            :scope="hostId ? { type: 'daemon', daemonId: hostId, daemonName: daemonDisplayName } : { type: 'global' }"
          />
          <button
            type="button"
            data-testid="session-list-search-toggle"
            :aria-label="searchPresented ? t('workspace.close_search') : t('workspace.search_sessions')"
            @click="toggleSearch"
          >
            <svg v-if="!searchPresented" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
          </button>
          <button type="button" class="mobile-new-session" data-testid="session-list-new-session" :aria-label="t('session.new_session')" @click="showNewSession = true">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </header>
      <div class="mobile-list-controls">
        <div class="mobile-host-scope">
          <button class="mobile-host-picker-trigger" type="button" aria-haspopup="dialog" :aria-expanded="hostPickerOpen" @click="hostPickerOpen = true"><WorkspaceIcon name="hosts" /><span>{{ hostId ? daemonDisplayName : t('token.all_hosts') }}</span><WorkspaceIcon name="down" /></button>
          <span v-if="hostId && hostStatus !== 'unknown'" class="mobile-daemon-status-copy"><i :class="['mobile-daemon-dot', { online: hostStatus === 'online' }]" />{{ hostStatus === 'online' ? t('workspace.host_heartbeat_now') : hostStatus === 'offline' ? t('team.availability.offline') : t('workspace.connecting') }}</span>
          <span v-else-if="!hostId" class="mobile-host-stats">{{ t('mobile.sessions_host_status', { online: daemons.filter(item => item.daemon_online).length, total: daemons.length }) }}</span>
        </div>
        <div class="mobile-filter-row">
          <div class="mobile-agent-chips" :aria-label="t('session.agent_filter_label')">
            <button v-for="option in mobileAgentOptions" :key="option.value" type="button" :aria-pressed="mobileAgent === option.value" @click="mobileAgent = option.value; scrollListTop()">
              {{ option.label }} <span>{{ option.count }}</span>
            </button>
          </div>
          <button type="button" class="mobile-active-filter" :aria-pressed="mobileActiveOnly" @click="mobileActiveOnly = !mobileActiveOnly; scrollListTop()">{{ t('mobile.sessions_active') }}</button>
        </div>
      </div>
      <div v-if="searchPresented" class="mobile-session-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
        <input
          ref="searchField"
          v-model="searchQuery"
          type="search"
          inputmode="search"
          autocomplete="off"
          autocapitalize="none"
          :placeholder="t('mobile.sessions_search_placeholder')" :aria-label="t('mobile.sessions_search_placeholder')"
          data-testid="session-list-search-field"
        />
        <button v-if="hasSearchQuery" type="button" data-testid="session-list-search-clear" :aria-label="t('workspace.clear_session_search')" @click="clearSearch">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
        </button>
      </div>
      <div class="mobile-result-bar" role="status">
        <span>{{ t('mobile.sessions_result_count', { count: mobileMatchingSessions.length }) }}</span>
        <span v-if="mobileFiltering && !archivedView">{{ t('mobile.sessions_matching_expanded') }}</span>
        <CreateProjectControl v-if="hostId && hostStatus === 'online' && organizationReady && !archivedView" labeled @created="refreshOrganization" />
      </div>
    </template>
    <div v-else class="header-row">
      <h2>{{ t('nav.sessions') }}</h2>
      <div class="header-actions">
        <button v-if="teamAccess.enabled.value" class="btn" data-testid="personal-to-team-sessions" @click="$router.push('/teams?tab=sessions')"> {{ t('workspace.team_sessions') }} </button>
        <button class="btn logout" @click="handleLogout"> {{ t('settings.logout') }} </button>
        <button class="btn primary" @click="showNewSession = true">+ {{ t('session.new_session') }}</button>
      </div>
    </div>
    <div v-if="lastError" class="error-banner">{{ lastError }}</div>
    <div v-if="!sessionDataReady && !lastError" class="session-loading" data-state="loading-sessions" :aria-label="t('workspace.loading_session_records')">
      <div v-for="index in 3" :key="index" class="session-skeleton" :style="{ '--delay': `${index * 70}ms` }">
        <span class="skeleton-dot"></span>
        <div class="skeleton-lines">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </div>
    </div>
    <DaemonInstallGuide
      v-else-if="sortedSessions.length === 0 && !organizationReady"
      data-state="daemon-install-guide"
      :install-command="getInstallCommand()"
      @create="showNewSession = true"
    />
    <div v-if="isMobile && sessionDataReady && mobileFiltering && !mobileMatchingSessions.length" class="mobile-filter-empty">
      <p>{{ t('mobile.sessions_no_match') }}</p>
      <button type="button" @click="clearMobileFilters">{{ t('mobile.sessions_clear_filters') }}</button>
    </div>
    <div v-for="s in visibleEntries" :key="s.kind === 'session' ? s.session_id : `${s.kind}-${s.daemonId || ''}-${s.id}`" :class="['session-group', { 'mobile-host-nested': isMobile && !hostId && organizationReady && !archivedView && s.nested, 'mobile-host-end': s.hostEnd }]" :data-session-drop="s.kind === 'session' ? s.session_id : undefined" :data-project-drop="s.kind === 'project' ? s.id : s.kind === 'ungrouped' ? 'ungrouped' : undefined" :data-daemon-drop="s.daemonId || s.daemon_id">
      <div v-if="s.kind === 'host'" class="mobile-host-section">
        <strong>{{ s.name }}</strong>
        <CreateProjectControl v-if="s.online" labeled @created="refreshOrganization" />
      </div>
      <p v-else-if="s.kind === 'hostNote'" class="mobile-host-note"><WorkspaceIcon name="clock" />{{ t('mobile.sessions_offline_history') }}</p>
      <p v-else-if="s.kind === 'hostEmpty' || s.kind === 'projectEmpty'" class="mobile-host-empty">{{ t(s.kind === 'hostEmpty' ? 'mobile.sessions_host_empty' : 'mobile.sessions_project_empty') }}</p>
      <button v-else-if="s.kind === 'hostMore'" class="mobile-host-more" :disabled="loadingHost === s.daemonId" @click="loadMoreHost(s.daemonId)">{{ t(loadingHost === s.daemonId ? 'workspace.loading_more' : 'attention.load_more') }}<span v-if="s.remaining"> · {{ t('mobile.sessions_remaining', { count: s.remaining }) }}</span></button>
      <div v-else-if="s.kind === 'projectSection'" class="organization-section-label">
        <span> {{ t('workspace.projects') }} </span>
        <CreateProjectControl @created="refreshOrganization" />
      </div>
      <div v-else-if="s.kind === 'project'" class="organization-header" :draggable="!isMobile" @dragstart="!isMobile && (dragProjectId = s.id)" @dragover.prevent @drop.prevent="dropOnProject(s.id)">
        <button type="button" class="organization-fold" :aria-expanded="!isProjectCollapsed(s.id, s.daemonId)" @click="toggleProject(s.id, s.daemonId)">
          <svg v-if="isProjectCollapsed(s.id, s.daemonId)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 10V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2M4 10h17l-3 10H2z"/></svg>
          {{ s.name }} <small>{{ s.count }}</small><WorkspaceIcon v-if="isMobile" :name="isProjectCollapsed(s.id, s.daemonId) ? 'chevron' : 'down'" class="project-disclosure" />
        </button>
        <button v-if="isMobile" type="button" class="organization-action" :aria-label="t('mobile.sessions_manage_project', { name: s.name })" @click="mobileProjectMenu = s"><WorkspaceIcon name="more" /></button>
        <button v-else type="button" class="organization-action" :aria-label="t('session.new_session')" @click="pendingDaemonId = s.daemonId || hostId; pendingProjectId = s.id; showNewSession = true"><WorkspaceIcon name="plus" /><span>{{ t('workspace.plus_new_session') }}</span></button>
      </div>
      <div v-else-if="s.kind === 'ungrouped'" class="organization-header ungrouped" @dragover.prevent @drop.prevent="dropOnProject(null)"> {{ t('workspace.ungrouped') }} <small>{{ s.count }}</small></div>
      <button v-else-if="s.kind === 'archiveBack'" class="organization-back" @click="archivedView = false"> {{ t('workspace.back_to_sessions') }} </button>
      <button v-else-if="s.kind === 'loadMore'" :class="['organization-back', { 'project-load-more': s.id !== 'ungrouped' }]" :data-project-load-more="s.id" @click="loadMoreOrganization(s.id)"> {{ t('attention.load_more') }} </button>
      <MobileSessionCard
        v-else-if="isMobile"
        :session="s"
        :effective-status="getEffectiveStatus(s)"
        :relative-time="formatRelativeTime(s.last_activity_at || s.started_at)"
        :expanded="!!folded[s.session_id]"
        :archived="archivedView"
        :reorderable="organizationReady && !archivedView && !mobileFiltering"
        @pin="toggleMobilePin(s)"
        @delete="pendingDeleteSession = s"
        @drop="handleMobileDrop(s, $event)"
        @open="openSession(s)"
        @toggle-subagents="toggleFold(s.session_id)"
        @show-children="mobileChildrenSession = s"
        @long-press="openMobileMenu"
      >
      <div v-if="s.kind === 'session' && s.children && s.children.length && folded[s.session_id]" :class="['child-rows', { 'mobile-child-panel': isMobile }]">
        <div v-if="isMobile" class="mobile-child-header">
          <strong>{{ t('workspace.derived_activity', {count:s.children.length}) }}</strong>
          <button type="button" @click="mobileChildrenSession = s">
            {{ t('dashboard.view_all') }} <span aria-hidden="true">›</span>
          </button>
        </div>
        <div v-for="c in visibleChildren(s)" :key="c.agentId" :class="['child-row', { 'child-row-sdk': c.kind === 'sdk_session' }]" role="button" tabindex="0"
          :title="c.title || c.agentId.slice(0, 8)"
          @click.stop="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)"
          @keydown.enter="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)">
          <span class="child-indent">↳</span>
          <span v-if="isMobile" :class="['child-status-dot', c.status || 'completed']" aria-hidden="true"></span>
          <span v-if="c.kind === 'sdk_session'" class="child-kind-icon" aria-hidden="true">⚙️</span>
          <span class="child-title">{{ c.title || c.agentId.slice(0, 8) }}</span>
          <span v-if="childAgentTokenTotal(c) > 0" class="child-token">
            {{ isMobile ? `↑${formatCompactToken(c.tokenIn || 0)} ↓${formatCompactToken(c.tokenOut || 0)}` : `🪙 ${formatTokenCount(childAgentTokenTotal(c))}` }}
          </span>
        </div>
        <button v-if="isMobile && !showAllChildren[s.session_id] && s.children.length > 2" class="mobile-child-more" type="button" @click="mobileChildrenSession = s">
          {{ t('workspace.more_derived_activity', {count:s.children.length-2}) }}
        </button>
      </div>
      </MobileSessionCard>
      <div v-else :class="['session-row', { 'pending-delete': s.__pendingDelete }]" draggable="true" @dragstart="dragSessionId = s.session_id" @dragover.prevent @drop.prevent="dropOnSession(s)" @click="!s.__pendingDelete && openSession(s)">
        <span class="status-indicator" :class="getEffectiveStatus(s)">
          <span v-if="getEffectiveStatus(s) === 'running' || getEffectiveStatus(s) === 'busy' || getEffectiveStatus(s) === 'retry'" class="pulse-ring"></span>
          <span v-if="getEffectiveStatus(s) === 'completed'" class="icon">✓</span>
          <span v-else-if="getEffectiveStatus(s) === 'killed'" class="icon">✕</span>
        </span>
        <div class="session-info">
          <div class="session-title">
            <span v-if="s.children && s.children.length" class="fold-toggle" @click.stop="toggleFold(s.session_id)">{{ folded[s.session_id] ? '▾' : '▸' }}</span>
            <SessionPinBadge v-if="!archivedView && s.pinned" />
            <input v-if="renamingId === s.session_id" class="ss-rename-input" v-model="renameInput" maxlength="60"
              @click.stop @keydown.enter="commitRename(s)" @keydown.escape="cancelRename" @blur="commitRename(s)" />
            <span v-else class="session-title-copy">{{ s.title || s.session_id.slice(0, 8) }}</span>
            <span v-if="s.new_badge_pending" class="session-new-badge">NEW</span>
          </div>
          <div class="session-meta">
            <span class="source-badge" :class="s.source">{{ s.source === 'terminal' ? '📺 终端' : '🌐 Web' }}</span>
            <span v-if="s.hostname" class="hostname-badge">💻 {{ s.hostname }}</span>
            <span v-if="subagentBadgeCount(s) > 0" class="subagent-badge">🤖 {{ subagentBadgeCount(s) }}</span>
            <span v-if="sdkChildCount(s) > 0" class="system-badge" :title="t('workspace.sdk_system_session')">⚙️ {{ sdkChildCount(s) }}</span>
            <span v-if="s.totalTokens > 0" class="token-badge" :title="t('session.total_incl_subagent')">🪙 {{ formatTokenCount(s.totalTokens) }}</span>
            <span v-if="s.exit_reason" class="exit-reason">{{ exitReasonLabel(s.exit_reason) }}</span>
            <span class="session-id">{{ s.session_id.slice(0, 8) }}</span>
            <AgentBadge :agent="s.agent" size="sm" />
            <span v-if="s.model" class="model-badge" :title="s.model">{{ s.model }}</span>
          </div>
        </div>
        <span class="session-time">{{ formatRelativeTime(s.last_activity_at || s.started_at) }}</span>
        <SessionActions :session="s" :projects="projects" :archived-view="archivedView" @startRename="startRename" @deleted="onDeleted" @pinned="onPinned" @moved="onMoved" @archived="onArchived" />
      </div>
      <div v-if="!isMobile && s.kind === 'session' && s.children && s.children.length && folded[s.session_id]" :class="['child-rows', { 'mobile-child-panel': isMobile }]">
        <div v-if="isMobile" class="mobile-child-header">
          <strong>{{ t('workspace.derived_activity', {count:s.children.length}) }}</strong>
          <button type="button" @click="showAllChildren[s.session_id] = !showAllChildren[s.session_id]">
            {{ showAllChildren[s.session_id] ? t('session.tool_collapse') : t('dashboard.view_all') }} <span aria-hidden="true">›</span>
          </button>
        </div>
        <div v-for="c in visibleChildren(s)" :key="c.agentId" :class="['child-row', { 'child-row-sdk': c.kind === 'sdk_session' }]" role="button" tabindex="0"
          :title="c.title || c.agentId.slice(0, 8)"
          @click.stop="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)"
          @keydown.enter="$router.push(`/session/${s.session_id}?subagent=${c.agentId}`)">
          <span class="child-indent">↳</span>
          <span v-if="isMobile" :class="['child-status-dot', c.status || 'completed']" aria-hidden="true"></span>
          <span v-if="c.kind === 'sdk_session'" class="child-kind-icon" aria-hidden="true">⚙️</span>
          <span class="child-title">{{ c.title || c.agentId.slice(0, 8) }}</span>
          <span v-if="childAgentTokenTotal(c) > 0" class="child-token">
            {{ isMobile ? `↑${formatCompactToken(c.tokenIn || 0)} ↓${formatCompactToken(c.tokenOut || 0)}` : `🪙 ${formatTokenCount(childAgentTokenTotal(c))}` }}
          </span>
        </div>
        <button v-if="isMobile && !showAllChildren[s.session_id] && s.children.length > 2" class="mobile-child-more" type="button" @click="showAllChildren[s.session_id] = true">
          {{ t('workspace.more_derived_activity', {count:s.children.length-2}) }}
        </button>
      </div>
    </div>
    <button v-if="!archivedView && organizationReady" class="organization-archive-entry" @click="openArchived()"><WorkspaceIcon name="archive" /> {{ t('team.task_filter.archived') }} <span>{{ archivedCount }}</span><WorkspaceIcon name="chevron" /></button>
    <div v-if="canLoadMore && !hasSearchQuery && !organizationReady" ref="loadMoreSentinel" class="session-load-more">
      <button class="session-load-more-btn" type="button" :disabled="isLoadingPage" @click="loadMoreSessions">
        <span v-if="isLoadingPage" class="load-more-spinner" aria-hidden="true"></span>
        {{ isLoadingPage ? t('workspace.loading_more') : t('workspace.load_more_sessions') }}
      </button>
    </div>
    <ActionList v-if="mobileChildrenSession" mobile-sheet :title="t('workspace.derived_activity', { count: mobileChildrenSession.children.length })" @close="mobileChildrenSession = null">
      <button v-for="child in mobileChildrenSession.children" :key="child.agentId" type="button" class="action-item mobile-child-action" @click="$router.push(`/session/${mobileChildrenSession.session_id}?subagent=${child.agentId}`)"><span :class="['child-status-dot', child.status || 'completed']" /><span>{{ child.title || child.agentId.slice(0, 8) }}</span><small>↑{{ formatCompactToken(child.tokenIn || 0) }} ↓{{ formatCompactToken(child.tokenOut || 0) }}</small><WorkspaceIcon name="chevron" /></button>
    </ActionList>
    <ActionList v-if="hostPickerOpen" mobile-sheet :title="t('mobile.sessions_choose_host')" @close="hostPickerOpen = false">
      <button type="button" class="mobile-host-picker-row" :aria-pressed="!hostId" @click="selectMobileHost('')"><WorkspaceIcon name="hosts" /><span><strong>{{ t('token.all_hosts') }}</strong><small>{{ t('mobile.sessions_grouped_hosts', { count: daemons.length }) }}</small></span><WorkspaceIcon v-if="!hostId" name="check" /></button>
      <button v-for="daemon in orderedMobileHosts" :key="daemon.daemon_id" type="button" class="mobile-host-picker-row" :aria-pressed="hostId === daemon.daemon_id" @click="selectMobileHost(daemon.daemon_id)"><WorkspaceIcon name="hosts" /><span><strong>{{ daemon.daemon_alias || daemon.hostname || daemon.daemon_id }}</strong><small>{{ t(daemon.daemon_online ? 'team.availability.online' : 'mobile.sessions_offline_viewable') }}<template v-if="!hostId || hostId === daemon.daemon_id"> · {{ t('mobile.sessions_result_count', { count: mobileFilterSessions.filter(item => item.daemon_id === daemon.daemon_id).length }) }}</template></small></span><WorkspaceIcon v-if="hostId === daemon.daemon_id" name="check" /></button>
    </ActionList>
    <ActionList v-if="mobileProjectMenu" mobile-sheet :title="mobileProjectMenu.name" @close="mobileProjectMenu = null">
      <button type="button" class="action-item" :disabled="!daemons.some(item => item.daemon_id === mobileProjectMenu.daemonId && item.daemon_online)" @click="newSessionInProject"><WorkspaceIcon name="plus" />{{ t('workspace.plus_new_session') }}</button>
      <button type="button" class="action-item" @click="renamingProject = mobileProjectMenu; mobileProjectMenu = null"><WorkspaceIcon name="pencil" />{{ t('workspace.rename_project') }}</button>
      <button type="button" class="action-item" :disabled="projectMenuIndex <= 0" @click="shiftMobileProject(-1)"><WorkspaceIcon name="down" class="point-up" />{{ t('workspace.move_up') }}</button>
      <button type="button" class="action-item" :disabled="projectMenuIndex >= mobileHostProjects.length - 1" @click="shiftMobileProject(1)"><WorkspaceIcon name="down" />{{ t('workspace.move_down') }}</button>
    </ActionList>
    <RenameProjectAction v-if="renamingProject" :project="renamingProject" @close="renamingProject = null" @saved="refreshOrganization" />
    <ActionList v-if="mobileMenuSession" mobile-sheet :title="mobileMenuSession.title || mobileMenuSession.session_id.slice(0, 8)" @close="closeMobileMenu">
      <button v-if="!archivedView" type="button" class="action-item" @click="menuTogglePin"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M9 10.8V4h6v6.8l3 3.2v2H6v-2l3-3.2z"/></svg><span>{{ t(mobileMenuSession.pinned ? 'session.actions.unpin' : 'session.actions.pin') }}</span></button>
      <button type="button" class="action-item" @click="menuCopyId"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><span>{{ t('session.actions.copy_id') }}</span></button>
      <button type="button" class="action-item" @click="menuMoveSession"><WorkspaceIcon name="folder" />{{ t('workspace.move_to_project') }}</button>
      <button type="button" class="action-item" @click="menuRenameSession"><WorkspaceIcon name="pencil" />{{ t('session.actions.rename') }}</button>
      <button type="button" class="action-item" @click="menuArchiveSession"><WorkspaceIcon name="archive" />{{ t(archivedView ? 'workspace.restore_session' : 'workspace.archive_session') }}</button>
      <button v-if="mobileMenuSessionTerminal" type="button" class="action-item danger" @click="menuRequestDelete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6"/></svg><span>{{ t('session.actions.delete') }}</span></button>
    </ActionList>
    <ActionList v-if="mobileRenameSession" mobile-sheet :title="t('session.actions.rename')" @close="!mobileRenameBusy && (mobileRenameSession = null)">
      <form id="mobile-session-rename" @submit.prevent="saveMobileRename"><input v-model="mobileRenameTitle" :aria-label="t('session.actions.rename')" maxlength="60" :disabled="mobileRenameBusy" required /><p v-if="mobileRenameError" role="alert">{{ mobileRenameError }}</p></form>
      <template #footer><button type="button" :disabled="mobileRenameBusy" @click="mobileRenameSession = null">{{ t('common.cancel') }}</button><button type="submit" form="mobile-session-rename" class="primary" :disabled="mobileRenameBusy || !mobileRenameTitle.trim()">{{ t('common.save') }}</button></template>
    </ActionList>
    <ActionList v-if="mobileMoveSession" mobile-sheet :title="t('workspace.move_to_project')" @close="mobileMoveSession = null">
      <button class="action-item" @click="confirmMobileMove(null)"><WorkspaceIcon name="folder" />{{ t('workspace.ungrouped') }}</button>
      <button v-for="project in projects" :key="project.id" class="action-item" @click="confirmMobileMove(project.id)"><WorkspaceIcon name="folder" />{{ project.name }}</button>
    </ActionList>
    <ActionList v-if="pendingArchiveSession" mobile-sheet :title="t('workspace.archive_session')" @close="pendingArchiveSession = null">
      <p>{{ pendingArchiveSession.title || pendingArchiveSession.session_id.slice(0, 8) }}</p><p>{{ t('workspace.archive_hint') }}</p>
      <template #footer><button type="button" @click="pendingArchiveSession = null">{{ t('common.cancel') }}</button><button type="button" class="primary" @click="confirmMobileArchive">{{ t('workspace.confirm_archive') }}</button></template>
    </ActionList>
    <ActionList v-if="pendingDeleteSession" mobile-sheet :title="t('session.actions.delete')" @close="pendingDeleteSession = null">
      <p>{{ pendingDeleteSession.title || pendingDeleteSession.session_id.slice(0, 8) }}</p><p>{{ t('workspace.mobile_delete_desc') }}</p>
      <template #footer><button type="button" @click="pendingDeleteSession = null">{{ t('common.cancel') }}</button><button type="button" class="danger" @click="confirmMobileDelete">{{ t('session.actions.delete') }}</button></template>
    </ActionList>

    <div v-if="mobileToast" class="mobile-toast" role="status">{{ mobileToast }}</div>
    <NewSessionDialog v-if="showNewSession" :daemons="daemons" :project-id="pendingProjectId" :projects="projects" :pre-selected-daemon-id="pendingDaemonId || hostId || undefined" @close="showNewSession = false; pendingProjectId = null; pendingDaemonId = ''" @create="handleCreate" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket'
import type { DaemonEvent } from '../composables/useWebSocket'
import { formatRelativeTime } from '../composables/useRelativeTime'
import { useAuth } from '../composables/useAuth'
import { useTeamAccess } from '../composables/useTeamAccess'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import SessionActions from '../components/SessionActions.vue'
import AgentBadge from '../components/AgentBadge.vue'
import MobileSessionCard from '../components/MobileSessionCard.vue'
import WorkspaceIcon from '../components/WorkspaceIcon.vue'
import RenameProjectAction from '../components/RenameProjectAction.vue'
import { agentDisplayName } from '../utils/agentDisplay'
import SessionPinBadge from '../components/SessionPinBadge.vue'
import CreateProjectControl from '../components/CreateProjectControl.vue'
import DaemonInstallGuide from '../components/DaemonInstallGuide.vue'
import { getInstallCommand, getRelayOrigin } from '../composables/useEnv'
import { listProjects, listOrganizedSessions, moveSession, archiveSession, reorderProjects, reorderSession, markSessionSeen, type SessionProject } from '../services/sessionOrganization'
import { formatTokenCount, childAgentTokenTotal } from '../utils/tokenFormat'
import { useLocale } from '../composables/useLocale'
import ActionList from '../components/ActionList.vue'
import { useSessionRename } from '../composables/useSessionRename'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import { sortMobileSessions } from '../utils/sessionPriority'
import { hasSessionSearchQuery, matchesSessionSearch } from '../utils/sessionSearch'
import {
  SESSION_REMOTE_PAGE_SIZE,
  SESSION_RENDER_BATCH_SIZE,
  mergeSessionPage,
  nextVisibleSessionCount,
} from '../utils/sessionListPagination'
import AttentionInboxEntryButton from '../components/attention-inbox/AttentionInboxEntryButton.vue'

const { renamingId, renameInput, startRename, commitRename, cancelRename } = useSessionRename()
const { t } = useLocale()

const { connect, send, onEvent, effectiveStatus } = useWebSocket()
const { isLoggedIn, accessToken, logout, user, renameSession } = useAuth()
const teamAccess = useTeamAccess()
const $router = useRouter()
const route = useRoute()
const sessions = ref<any[]>([])
const daemons = ref<any[]>([])
const showNewSession = ref(false)
const lastError = ref('')
const hasLoadedSessions = ref(false)
const folded = ref<Record<string, boolean>>({})
const showAllChildren = ref<Record<string, boolean>>({})
const { isMobile } = useResponsiveLayout()
const hostId = computed(() => typeof route.query.host === 'string' ? route.query.host : '')
const visibleCount = ref(SESSION_RENDER_BATCH_SIZE)
const hasMoreRemoteSessions = ref(false)
const nextSessionCursor = ref<string | null>(null)
const isLoadingPage = ref(false)
const requestingNextPage = ref(false)
const liveSessionIds = new Set<string>()
const loadMoreSentinel = ref<HTMLElement | null>(null)
let loadMoreObserver: IntersectionObserver | null = null
const triggerNewSession = inject<Ref<number>>('triggerNewSession', ref(0))
const searchPresented = ref(false)
const searchQuery = ref('')
const searchField = ref<HTMLInputElement | null>(null)
const pendingDeleteSession = ref<any | null>(null)
const pendingArchiveSession = ref<any | null>(null)
const mobileChildrenSession = ref<any>(null)
const mobileMenuSession = ref<any | null>(null)
const mobileRenameSession = ref<any>(null)
const mobileRenameTitle = ref(''), mobileRenameError = ref(''), mobileRenameBusy = ref(false)
const mobileMoveSession = ref<any | null>(null)
const mobileToast = ref('')
let mobileToastTimer: ReturnType<typeof setTimeout> | null = null
let normalScrollY: number | null = null
watch(triggerNewSession, (value) => {
  if (value > 0) showNewSession.value = true
})

const sortedSessions = computed(() => {
  const rootSessions = sessions.value.filter(s => !s.isSubagent)
  if (isMobile.value) return sortMobileSessions(rootSessions)

  return [...rootSessions].sort((a, b) => {
    // Pinned first
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    const ta = a.last_activity_at ? new Date(a.last_activity_at).getTime() : (a.started_at ? new Date(a.started_at).getTime() : 0)
    const tb = b.last_activity_at ? new Date(b.last_activity_at).getTime() : (b.started_at ? new Date(b.started_at).getTime() : 0)
    return tb - ta
  })
})
const displayedSessions = computed(() => sortedSessions.value.slice(0, visibleCount.value))
const hasSearchQuery = computed(() => hasSessionSearchQuery(searchQuery.value))
const searchResults = computed(() => hasSearchQuery.value
  ? sortedSessions.value.filter(session => matchesSessionSearch(session, searchQuery.value))
  : [])
const renderedSessions = computed(() => hasSearchQuery.value ? searchResults.value : displayedSessions.value)
const projects = ref<SessionProject[]>([])
const organizationReady = ref(false)
const archivedView = ref(route.query.view === 'archived')
const openWorkspaceNavigation = inject<() => void>('openWorkspaceNavigation', () => window.dispatchEvent(new Event('pocketctl:open-navigation')))
watch(() => route.query.view, view => { if (view === 'archived') void openArchived(); else if (view === 'active') archivedView.value = false })
const archivedCount = ref(0)
const archivedSessions = ref<any[]>([])
const archiveReady = ref(false)
const sessionDataReady = computed(() => archivedView.value ? archiveReady.value : hasLoadedSessions.value || organizationReady.value)
const archivedCursor = ref<string | null>(null)
const bucketSessions = ref<Record<string, any[]>>({})
const bucketCursors = ref<Record<string, string | null>>({})
const projectOrderRevision = ref(0)
const ungroupedRevision = ref(0)
const pendingProjectId = ref<string | null>(null)
const pendingDaemonId = ref('')
const dragProjectId = ref<string | null>(null)
const dragSessionId = ref<string | null>(null)
const collapsedProjects = ref<Record<string, boolean>>({})
const collapseKey = computed(() => `pocketctl-project-folds:${getRelayOrigin()}:${user?.value?.id || 'anonymous'}`)
watch(collapseKey, key => { try { collapsedProjects.value = JSON.parse(localStorage.getItem(key) || '{}') } catch { collapsedProjects.value = {} } }, { immediate: true })
const serverSearchResults = ref<any[]>([])
const serverSearchCursor = ref<string | null>(null)
const renderedEntries = computed<any[]>(() => {
  if (archivedView.value) return [{ kind:'archiveBack', id:'back' }, ...archivedSessions.value.filter(s => !!s.archived_at).map(s => ({ ...s, kind:'session' })), ...(archivedCursor.value ? [{kind:'loadMore',id:'archived'}] : [])]
  if (!organizationReady.value) return renderedSessions.value.filter(s => !s.archived_at).map(s => ({ ...s, kind:'session' }))
  if (hasSearchQuery.value) return [...serverSearchResults.value.map(s => ({ ...s, kind:'session' })), ...(serverSearchCursor.value ? [{kind:'loadMore',id:'search'}] : [])]
  const entries: any[] = []
  entries.push({ kind:'projectSection', id:'projects' })
  for (const p of projects.value) {
    entries.push({ ...p, kind:'project' })
    if (!collapsedProjects.value[p.id]) entries.push(...(bucketSessions.value[p.id] || []).map(s => ({ ...s, kind:'session' })))
    if (!collapsedProjects.value[p.id] && bucketCursors.value[p.id]) entries.push({kind:'loadMore',id:p.id})
  }
  entries.push({ kind:'ungrouped', id:'ungrouped', count:bucketSessions.value.ungrouped?.length || 0 })
  entries.push(...(bucketSessions.value.ungrouped || []).map(s => ({ ...s, kind:'session' })))
  if (bucketCursors.value.ungrouped) entries.push({kind:'loadMore',id:'ungrouped'})
  return entries
})
const mobileAgent = ref('all')
const mobileActiveOnly = ref(false)
const hostPickerOpen = ref(false)
const mobileProjectMenu = ref<any>(null)
const renamingProject = ref<SessionProject | null>(null)
const listRoot = ref<HTMLElement>()
const hostLimits = ref<Record<string, number>>({})
const hostScrolls = new Map<string, number>()
const loadingHost = ref('')
const mobileHostCursors = ref<Record<string, Record<string, string | null>>>({})
function listScroller(): HTMLElement | null {
  let parent = listRoot.value?.parentElement
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent
    parent = parent.parentElement
  }
  return document.scrollingElement as HTMLElement | null
}
function scrollListTop() { const scroller = listScroller(); if (scroller) scroller.scrollTop = 0 }
function clearMobileFilters() { mobileAgent.value = 'all'; mobileActiveOnly.value = false; searchQuery.value = ''; searchPresented.value = false; scrollListTop() }
async function selectMobileHost(id: string) {
  hostScrolls.set(hostId.value, listScroller()?.scrollTop || 0)
  hostPickerOpen.value = false
  const query = { ...route.query }; if (id) query.host = id; else delete query.host
  await $router.push({ path: '/sessions', query })
  await nextTick()
  const scroller = listScroller(); if (scroller) scroller.scrollTop = hostScrolls.get(id) || 0
}
const sessionAgent = (session: any) => session.agent_type || session.agent || 'unknown'
const mobileFilterSessions = computed(() => {
  const rows = archivedView.value ? archivedSessions.value.filter(item => !!item.archived_at)
    : organizationReady.value ? Object.values(bucketSessions.value).flat() : sortedSessions.value.filter(item => !item.archived_at)
  const live = new Map(sessions.value.map(item => [item.session_id, item]))
  return [...new Map(rows.map(item => {
    const current = live.get(item.session_id)
    return [item.session_id, current ? { ...item, status: current.status, title: current.title || item.title, pinned: current.pinned, children: current.children?.length ? current.children : item.children, model: current.model || item.model } : item]
  })).values()].filter(item => !hostId.value || item.daemon_id === hostId.value)
})
const mobileAgentOptions = computed(() => [
  { value: 'all', label: t('common.all'), count: mobileFilterSessions.value.length },
  ...[...new Set(mobileFilterSessions.value.map(sessionAgent))].map(value => ({
    value, label: agentDisplayName(value), count: mobileFilterSessions.value.filter(item => sessionAgent(item) === value).length,
  })),
])
const mobileFiltering = computed(() => hasSearchQuery.value || mobileActiveOnly.value || mobileAgent.value !== 'all')
const matchesMobileFilters = (item: any) => (mobileAgent.value === 'all' || sessionAgent(item) === mobileAgent.value)
  && (!mobileActiveOnly.value || (daemons.value.find(host => host.daemon_id === item.daemon_id)?.daemon_online !== false && ['running', 'busy', 'retry', 'waiting_approval', 'waiting_question'].includes(getEffectiveStatus(item))))
const mobileMatchingSessions = computed(() => {
  const local = mobileFilterSessions.value.filter(item => {
    if (!hasSearchQuery.value) return true
    const daemon = daemons.value.find(host => host.daemon_id === item.daemon_id)
    return matchesSessionSearch(item, searchQuery.value) || matchesSessionSearch({ title: [item.cwd, daemon?.hostname, daemon?.daemon_alias, projects.value.find(project => project.id === item.project_id)?.name].filter(Boolean).join(' ') }, searchQuery.value)
  })
  const remote = hasSearchQuery.value && !archivedView.value ? serverSearchResults.value.filter(item => !item.archived_at && (!hostId.value || item.daemon_id === hostId.value)) : []
  return [...new Map([...remote, ...local].map(item => [item.session_id, item])).values()].filter(matchesMobileFilters)
    .sort((a, b) => archivedView.value ? 0 : Number(!!b.pinned) - Number(!!a.pinned))
})
const orderedMobileHosts = computed(() => [...daemons.value].sort((a,b) => Number(!!b.daemon_online) - Number(!!a.daemon_online)))
const mobileHostProjects = computed(() => projects.value.filter(project => !project.count || mobileFilterSessions.value.some(item => item.project_id === project.id && item.daemon_id === mobileProjectMenu.value?.daemonId)))
const projectMenuIndex = computed(() => mobileHostProjects.value.findIndex(project => project.id === mobileProjectMenu.value?.id))
function newSessionInProject() {
  pendingDaemonId.value = mobileProjectMenu.value.daemonId
  pendingProjectId.value = mobileProjectMenu.value.id
  mobileProjectMenu.value = null; showNewSession.value = true
}
async function shiftMobileProject(direction: number) {
  const sibling = mobileHostProjects.value[projectMenuIndex.value + direction]
  if (!sibling) return
  const ids = projects.value.map(project => project.id)
  const from = ids.indexOf(mobileProjectMenu.value.id), to = ids.indexOf(sibling.id)
  ;[ids[from], ids[to]] = [ids[to], ids[from]]
  mobileProjectMenu.value = null
  try { await reorderProjects(ids, projectOrderRevision.value); await refreshOrganization() }
  catch (error) { showMobileToast(String(error)) }
}
function isProjectCollapsed(id: string, daemonId?: string) {
  return isMobile.value ? !mobileFiltering.value && !!collapsedProjects.value[`${daemonId || hostId.value}:${id}`] : !!collapsedProjects.value[id]
}
const visibleEntries = computed<any[]>(() => {
  if (!isMobile.value) return renderedEntries.value
  if (archivedView.value) return [{ kind:'archiveBack', id:'back' }, ...mobileMatchingSessions.value.map(item => ({ ...item, kind:'session' })), ...(archivedCursor.value ? [{ kind:'loadMore', id:'archived' }] : [])]
  if (!organizationReady.value) return mobileMatchingSessions.value.slice(0, mobileFiltering.value ? undefined : visibleCount.value).map(item => ({ ...item, kind:'session' }))
  const rows = mobileMatchingSessions.value
  const known = new Map(orderedMobileHosts.value.map(host => [host.daemon_id,host]))
  for (const row of rows) if (!known.has(row.daemon_id)) known.set(row.daemon_id, { daemon_id:row.daemon_id, hostname:row.hostname || row.daemon_id, daemon_online:row.daemon_online })
  const result: any[] = []
  for (const [daemonId, daemon] of [...known].sort((a,b) => Number(!!b[1].daemon_online) - Number(!!a[1].daemon_online))) {
    if (hostId.value && hostId.value !== daemonId) continue
    const hostRows = rows.filter(item => item.daemon_id === daemonId)
    if (mobileFiltering.value && !hostRows.length) continue
    if (!hostId.value) result.push({kind:'host',id:daemonId,name:daemon.daemon_alias || daemon.hostname || daemonId,online:daemon.daemon_online === true})
    const add = (item: any) => result.push({ ...item, daemonId, nested:true })
    if (daemon.daemon_online === false) add({kind:'hostNote',id:daemonId})
    const shown = hostRows.slice(0, mobileFiltering.value ? undefined : hostLimits.value[daemonId] || 3)
    for (const project of projects.value) {
      const projectRows = shown.filter(item => item.project_id === project.id)
      const count = hostRows.filter(item => item.project_id === project.id).length
      if (!projectRows.length && (count || mobileFiltering.value || project.count)) continue
      add({...project,kind:'project',count})
      if (!isProjectCollapsed(project.id,daemonId)) {
        projectRows.forEach(item => add({...item,kind:'session'}))
        if (!projectRows.length) add({kind:'projectEmpty',id:project.id})
      }
    }
    const ungrouped = shown.filter(item => !item.project_id || !projects.value.some(project => project.id === item.project_id))
    if (ungrouped.length) {
      add({kind:'ungrouped',id:'ungrouped',count:hostRows.filter(item => !item.project_id).length})
      ungrouped.forEach(item => add({...item,kind:'session'}))
    }
    if (!hostRows.length && !projects.value.some(project => !project.count)) add({kind:'hostEmpty',id:daemonId})
    if (hostRows.length > shown.length || Object.values(mobileHostCursors.value[daemonId] || {}).some(Boolean)) add({kind:'hostMore',id:daemonId,remaining:hostRows.length-shown.length})
    if (result.length) result[result.length-1].hostEnd = true
  }
  if (hasSearchQuery.value && serverSearchCursor.value) result.push({kind:'loadMore',id:'search'})
  return result
})
async function loadMoreHost(daemonId: string) {
  if (loadingHost.value) return
  hostLimits.value[daemonId] = (hostLimits.value[daemonId] || 3) + 3
  if (hostLimits.value[daemonId] <= mobileMatchingSessions.value.filter(item => item.daemon_id === daemonId).length || !Object.values(mobileHostCursors.value[daemonId] || {}).some(Boolean)) return
  loadingHost.value = daemonId
  try {
    for (const [bucket,cursor] of Object.entries(mobileHostCursors.value[daemonId] || {})) if (cursor) await loadMobileBucket(bucket,daemonId,cursor)
  } catch (error) { showMobileToast(String(error)) }
  finally { loadingHost.value = '' }
}
async function handleMobileDrop(moving: any, target: HTMLElement) {
  if (target.dataset.daemonDrop !== moving.daemon_id) { showMobileToast(t('mobile.sessions_same_host_only')); return }
  dragSessionId.value = moving.session_id
  if (target.dataset.sessionDrop) {
    const session = mobileFilterSessions.value.find(item => item.session_id === target.dataset.sessionDrop)
    if (session) await dropOnSession(session)
  } else if (target.dataset.projectDrop) await dropOnProject(target.dataset.projectDrop === 'ungrouped' ? null : target.dataset.projectDrop)
}

async function loadBucket(bucket: string, cursor?: string, generation = organizationGeneration) {
    const page = await listOrganizedSessions({ bucket, daemonId:hostId.value || undefined, cursor, limit:bucket === 'ungrouped' ? 30 : 5 })
    if (generation !== organizationGeneration) return
    const live = new Map(sessions.value.map(s => [s.session_id,s]))
    const rows = page.sessions.filter(s => !s.archived_at).map(s => ({ ...s, agent:s.agent_type, children:live.get(s.session_id)?.children || s.children || [],
      subagent_count:live.get(s.session_id)?.subagent_count || s.subagent_count || 0 }))
    bucketSessions.value[bucket] = cursor ? [...(bucketSessions.value[bucket] || []), ...rows.filter(s => !(bucketSessions.value[bucket] || []).some(old => old.session_id === s.session_id))] : rows
    bucketCursors.value[bucket] = page.next_cursor
}
let organizationGeneration = 0
async function loadMobileBucket(bucket: string, daemonId: string, cursor?: string, generation = organizationGeneration) {
  const page = await listOrganizedSessions({ bucket, daemonId, cursor, limit: Math.max(30, Math.min(100, (bucketSessions.value[bucket] || []).filter(item => item.daemon_id === daemonId).length)) })
  if (generation !== organizationGeneration) return
  const rows = page.sessions.filter(item => !item.archived_at && item.daemon_id === daemonId).map(item => ({ ...item, agent: item.agent_type || item.agent }))
  const previous = bucketSessions.value[bucket] || []
  bucketSessions.value[bucket] = [...new Map([...previous.filter(item => cursor || item.daemon_id !== daemonId), ...rows].map(item => [item.session_id,item])).values()]
  mobileHostCursors.value[daemonId] = { ...mobileHostCursors.value[daemonId], [bucket]: page.next_cursor }
}
async function refreshOrganization() {
  const generation = ++organizationGeneration
  try {
    const snapshot = await listProjects(hostId.value || undefined)
    if (generation !== organizationGeneration) return
    projects.value = snapshot.projects
    archivedCount.value = snapshot.archived_count
    projectOrderRevision.value = snapshot.project_order_revision
    ungroupedRevision.value = snapshot.ungrouped_revision
    if (isMobile.value && (daemons.value.length || hostId.value)) {
      const hosts = hostId.value ? [hostId.value] : daemons.value.map(item => item.daemon_id)
      const buckets = ['ungrouped', ...snapshot.projects.map(project => project.id)]
      const loads = hosts.flatMap(daemonId => buckets.map(bucket => () => loadMobileBucket(bucket,daemonId,undefined,generation)))
      for (let offset = 0; offset < loads.length; offset += 6) {
        if (generation !== organizationGeneration) return
        await Promise.all(loads.slice(offset,offset + 6).map(load => load()))
      }
      if (generation !== organizationGeneration) return
      for (const bucket in bucketSessions.value) if (!buckets.includes(bucket)) delete bucketSessions.value[bucket]
    } else await Promise.all([loadBucket('ungrouped',undefined,generation), ...snapshot.projects.filter(p => isMobile.value || !collapsedProjects.value[p.id]).map(p => loadBucket(p.id,undefined,generation))])
    if (generation !== organizationGeneration) return
    organizationReady.value = true
    if (archivedView.value) await openArchived()
  } catch { /* Keep the existing session list available during API upgrades. */ }
}

function toggleProject(id: string, daemonId?: string) {
  if (isMobile.value && mobileFiltering.value) { showMobileToast(t('mobile.sessions_matching_expanded')); return }
  const key = isMobile.value ? `${daemonId || hostId.value}:${id}` : id
  collapsedProjects.value[key] = !collapsedProjects.value[key]
  localStorage.setItem(collapseKey.value,JSON.stringify(collapsedProjects.value))
  if (!collapsedProjects.value[key] && !bucketSessions.value[id]) void loadBucket(id).catch(error => { lastError.value = String(error) })
}
async function openArchived(cursor?: string) {
  archivedView.value = true
  const archiveHost = hostId.value
  try {
    const page = await listOrganizedSessions({ view:'archived', daemonId:hostId.value || undefined, limit:100, cursor })
    if (archiveHost !== hostId.value) return
    archivedSessions.value = cursor ? [...archivedSessions.value,...page.sessions.filter(s => !archivedSessions.value.some(old => old.session_id === s.session_id))] : page.sessions
    archivedCursor.value = page.next_cursor
    archiveReady.value = true
  }
  catch (error) { lastError.value = error instanceof Error ? error.message : t('workspace.archive_read_failed') }
}
async function loadMoreOrganization(id: string) {
  if (id === 'archived') return openArchived(archivedCursor.value || undefined)
  if (id === 'search') return loadSearch(serverSearchCursor.value || undefined)
  try { await loadBucket(id,bucketCursors.value[id] || undefined) }
  catch (error) { lastError.value = String(error) }
}
async function openSession(s: any) {
  try { await markSessionSeen(s.session_id); s.new_badge_pending = false } catch {}
  $router.push(`/session/${s.session_id}`)
}
function onMoved(_id: string, _projectId: string | null) { void refreshOrganization() }
function onArchived(id: string, archived: boolean) {
  if (archived) for (const bucket of Object.keys(bucketSessions.value)) bucketSessions.value[bucket] = bucketSessions.value[bucket].filter(s => s.session_id !== id)
  else archivedSessions.value = archivedSessions.value.filter(s => s.session_id !== id)
  void refreshOrganization()
}
async function dropOnProject(id: string | null) {
  if (dragProjectId.value && id && dragProjectId.value !== id) {
    const ids = projects.value.map(p => p.id)
    ids.splice(ids.indexOf(dragProjectId.value),1); ids.splice(ids.indexOf(id),0,dragProjectId.value)
    try { await reorderProjects(ids,projectOrderRevision.value); await refreshOrganization() } catch (error) { lastError.value = String(error) }
    dragProjectId.value = null; return
  }
  if (!dragSessionId.value) return
  const sessionId = dragSessionId.value; dragSessionId.value = null
  try { await moveSession(sessionId,id); await refreshOrganization() } catch (error) { lastError.value = String(error) }
}
async function dropOnSession(target: any) {
  const movingId = dragSessionId.value; dragSessionId.value = null
  if (!movingId || movingId === target.session_id) return
  const moving = Object.values(bucketSessions.value).flat().find(s => s.session_id === movingId)
  try {
    if (moving?.project_id !== target.project_id) await moveSession(movingId,target.project_id || null)
    else {
      const bucket = target.project_id || 'ungrouped'
      const page = await listOrganizedSessions({ bucket,daemonId:hostId.value || undefined,limit:1 })
      await reorderSession(bucket,movingId,target.session_id,page.revision)
    }
    await refreshOrganization()
  } catch (error) { lastError.value = String(error) }
}
async function loadSearch(cursor?: string) {
  const query = searchQuery.value
  const searchHost = hostId.value
  try {
    const page = await listOrganizedSessions({ view:'active', q:query, daemonId:hostId.value || undefined, limit:100, cursor })
    if (searchQuery.value !== query || hostId.value !== searchHost) return
    serverSearchResults.value = cursor ? [...serverSearchResults.value,...page.sessions.filter(s => !serverSearchResults.value.some(old => old.session_id === s.session_id))] : page.sessions
    serverSearchCursor.value = page.next_cursor
  } catch (error) { lastError.value = String(error) }
}
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, query => {
  if (searchTimer) clearTimeout(searchTimer)
  if (!query.trim()) { serverSearchResults.value = []; serverSearchCursor.value = null; return }
  searchTimer = setTimeout(() => { void loadSearch() }, 250)
})
watch(hostId, () => {
  serverSearchResults.value = []; serverSearchCursor.value = null
  hasMoreRemoteSessions.value = false; nextSessionCursor.value = null; visibleCount.value = SESSION_RENDER_BATCH_SIZE
  requestSessionPage()
  void refreshOrganization().then(() => { if (hasSearchQuery.value) void loadSearch() })
})
const selectedDaemon = computed(() => daemons.value.find(daemon => daemon.daemon_id === hostId.value))
// 主机状态三态：daemon_list 未到(loading)不误报离线；无主机上下文或未知主机(unknown)隐藏状态行
const hasLoadedDaemons = ref(false)
const hostStatus = computed<'loading' | 'unknown' | 'online' | 'offline'>(() => {
  if (!hostId.value) return 'unknown'
  if (!hasLoadedDaemons.value) return 'loading'
  return selectedDaemon.value
    ? (selectedDaemon.value.daemon_online === true ? 'online' : 'offline')
    : 'unknown'
})
const daemonDisplayName = computed(() => selectedDaemon.value?.daemon_alias || selectedDaemon.value?.hostname || t('mobile.host_sessions'))
const canLoadMore = computed(() =>
  visibleCount.value < sortedSessions.value.length ||
  (Boolean(hostId.value) && hasMoreRemoteSessions.value),
)

function requestSessionPage(cursor?: string) {
  isLoadingPage.value = true
  requestingNextPage.value = Boolean(cursor)
  if (hostId.value) {
    send({
      type: 'list_sessions',
      daemon_id: hostId.value,
      limit: SESSION_REMOTE_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })
    return
  }
  send({ type: 'list_sessions' })
}

function loadMoreSessions() {
  if (isLoadingPage.value) return
  if (visibleCount.value < sortedSessions.value.length) {
    visibleCount.value = nextVisibleSessionCount(visibleCount.value, sortedSessions.value.length)
    return
  }
  if (hostId.value && hasMoreRemoteSessions.value && nextSessionCursor.value) {
    requestSessionPage(nextSessionCursor.value)
  }
}

watch([canLoadMore, loadMoreSentinel], async ([canLoad]) => {
  await nextTick()
  loadMoreObserver?.disconnect()
  if (!canLoad || !loadMoreSentinel.value || typeof IntersectionObserver === 'undefined') return
  loadMoreObserver = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) loadMoreSessions()
  }, { rootMargin: '160px 0px' })
  loadMoreObserver.observe(loadMoreSentinel.value)
})

function getEffectiveStatus(s: any): string {
  return effectiveStatus({ status: s.status, daemon_id: s.daemon_id })
}

function exitReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    user_interrupt: t('workspace.user_interrupted'),
    normal_exit: t('workspace.normal_exit'),
    process_crash: t('workspace.process_crash'),
    signal_kill: t('workspace.terminated'),
    unknown: t('session.status.exited'),
  }
  return labels[reason] || t('session.status.exited')
}

function toggleFold(id: string) {
  folded.value[id] = !folded.value[id]
}

function visibleChildren(session: any) {
  if (!isMobile.value || showAllChildren.value[session.session_id]) return session.children
  return session.children.slice(0, 2)
}

// SDK-spawned system sessions (kind sdk_session, e.g. plugin security
// reviews) ride the children list; the 🤖 badge counts only real subagents.
function subagentBadgeCount(session: any): number {
  if (session.children?.length) {
    return session.children.filter((c: any) => c.kind !== 'sdk_session').length
  }
  return session.subagent_count || 0
}

function sdkChildCount(session: any): number {
  return (session.children || []).filter((c: any) => c.kind === 'sdk_session').length
}

function formatCompactToken(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.0', '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.0', '')}k`
  return String(value)
}

async function toggleSearch() {
  if (searchPresented.value) {
    clearSearch()
    searchPresented.value = false
    return
  }
  searchPresented.value = true
  await nextTick()
  searchField.value?.focus()
}

function clearSearch() {
  searchQuery.value = ''
  searchField.value?.focus()
  if (normalScrollY !== null) {
    const restoreY = normalScrollY
    normalScrollY = null
    if (restoreY > 0) nextTick(() => { const scroller = listScroller(); if (scroller) scroller.scrollTop = restoreY })
  }
}

watch(hasSearchQuery, active => {
  if (active && normalScrollY === null) normalScrollY = listScroller()?.scrollTop || 0
})

function toggleMobilePin(session: any) {
  const pinned = !session.pinned
  session.pinned = pinned
  send({ type: 'session_pin', session_id: session.session_id, pinned })
  onPinned(session.session_id, pinned)
}

// ---- m 端长按上下文菜单(方案 B) ----
const mobileMenuSessionTerminal = computed(() =>
  mobileMenuSession.value && ['exited', 'completed', 'killed', 'error'].includes(mobileMenuSession.value.status)
)

function openMobileMenu(session: any) {
  mobileMenuSession.value = session
}

function closeMobileMenu() {
  mobileMenuSession.value = null
}

function showMobileToast(text: string) {
  mobileToast.value = text
  if (mobileToastTimer) clearTimeout(mobileToastTimer)
  mobileToastTimer = setTimeout(() => { mobileToast.value = '' }, 1800)
}

function menuTogglePin() {
  if (archivedView.value) return
  const session = mobileMenuSession.value
  if (!session) return
  toggleMobilePin(session)
  closeMobileMenu()
  showMobileToast(session.pinned ? t('workspace.pinned') : t('workspace.unpinned'))
}

function menuCopyId() {
  const session = mobileMenuSession.value
  if (!session) return
  navigator.clipboard?.writeText(session.session_id).catch(() => undefined)
  closeMobileMenu()
  showMobileToast(t('workspace.session_id_copied'))
}

function menuRequestDelete() {
  pendingDeleteSession.value = mobileMenuSession.value
  closeMobileMenu()
}
function menuRenameSession() {
  mobileRenameSession.value = mobileMenuSession.value
  mobileRenameTitle.value = mobileMenuSession.value.title || ''
  mobileRenameError.value = ''; closeMobileMenu()
  void nextTick(() => document.querySelector<HTMLInputElement>('#mobile-session-rename input')?.focus())
}
async function saveMobileRename() {
  if (!mobileRenameSession.value || mobileRenameBusy.value || !mobileRenameTitle.value.trim()) return
  const id = mobileRenameSession.value.session_id, title = mobileRenameTitle.value.trim()
  mobileRenameBusy.value = true; mobileRenameError.value = ''
  try {
    const error = await renameSession(id,title)
    if (error) throw new Error(error)
    for (const row of [...sessions.value, ...Object.values(bucketSessions.value).flat(), ...archivedSessions.value, ...serverSearchResults.value]) if (row.session_id === id) row.title = title
    mobileRenameSession.value = null
  } catch (error) { mobileRenameError.value = error instanceof Error ? error.message : t('workspace.rename_failed') }
  finally { mobileRenameBusy.value = false }
}
function menuMoveSession() { mobileMoveSession.value = mobileMenuSession.value; closeMobileMenu() }
async function confirmMobileMove(projectId: string | null) {
  const session = mobileMoveSession.value
  if (!session) return
  try { await moveSession(session.session_id,projectId); mobileMoveSession.value = null; await refreshOrganization() }
  catch (error) { showMobileToast(error instanceof Error ? error.message : t('workspace.move_failed')) }
}
async function menuArchiveSession() {
  const session = mobileMenuSession.value
  closeMobileMenu()
  if (!session) return
  if (!archivedView.value) { pendingArchiveSession.value = session; return }
  try { await archiveSession(session.session_id,false); onArchived(session.session_id,false) }
  catch (error) { showMobileToast(error instanceof Error ? error.message : t('workspace.restore_failed')) }
}
async function confirmMobileArchive() {
  const session = pendingArchiveSession.value
  if (!session) return
  try { await archiveSession(session.session_id,true); onArchived(session.session_id,true); pendingArchiveSession.value = null }
  catch (error) { showMobileToast(error instanceof Error ? error.message : t('workspace.archive_failed')) }
}

function onMobileSheetKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (pendingDeleteSession.value) pendingDeleteSession.value = null
  else closeMobileMenu()
}

onMounted(() => window.addEventListener('keydown', onMobileSheetKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onMobileSheetKeydown))

function confirmMobileDelete() {
  const session = pendingDeleteSession.value
  if (!session) return
  session.__pendingDelete = true
  send({ type: 'session_delete', session_id: session.session_id })
  onDeleted(session.session_id)
  pendingDeleteSession.value = null
  showMobileToast(t('workspace.session_deleted'))
}

let unsubscribeEvents: (() => void) | undefined
let sessionRequestTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  const token = accessToken.value
  if (!token) { $router.push('/login'); return }
  connect()
  void refreshOrganization().then(() => { if (route.query.view === 'archived') return openArchived() })

  sessionRequestTimer = setTimeout(() => { requestSessionPage() }, 500)
  send({ type: 'list_daemons' })

  unsubscribeEvents = onEvent((evt: DaemonEvent) => {
    if (['session_organization_changed','session_created','session_discovered'].includes((evt as any).type)) { void refreshOrganization() }
    if (evt.type === 'error') {
      lastError.value = evt.error || 'Unknown error'
      isLoadingPage.value = false
      requestingNextPage.value = false
      setTimeout(() => { lastError.value = '' }, 5000)
    }
    if (evt.type === 'session_list') {
      const event = evt as any
      if (hostId.value && event.daemon_id !== hostId.value) return
      const list = Array.isArray(event.sessions) ? event.sessions : []
      const normalized = list.map((s: any) => ({
          session_id: s.session_id,
          status: s.status,
          agent: s.agent_type || 'claude-code',
          started_at: new Date(s.created_at),
          last_activity_at: s.last_activity_at ? new Date(s.last_activity_at) : undefined,
          cwd: s.cwd,
          title: s.title || '',
          source: s.source || 'daemon',
          daemon_id: s.daemon_id,
          hostname: s.hostname || '',
          exit_reason: s.exit_reason,
          daemon_online: s.daemon_online,
          subagent_count: s.subagent_count || 0,
          totalTokens: s.totalTokens ?? 0,
          tokInput: s.tokInput ?? 0,
          tokOutput: s.tokOutput ?? 0,
          tokCacheRead: s.tokCacheRead ?? 0,
          tokCacheCreate: s.tokCacheCreate ?? 0,
          model: s.model || '',
          pinned: s.pinned || false,
          project_id: s.project_id, archived_at: s.archived_at, new_badge_pending: s.new_badge_pending, effort: s.effort,
          parentSessionId: s.parent_session_id ?? null,
          isSubagent: !!s.is_subagent,
          children: s.children ?? [],
        }))
      if (hostId.value) {
        if (requestingNextPage.value) {
          sessions.value = mergeSessionPage(sessions.value, normalized)
        } else {
          const liveSessions = sessions.value.filter(session => liveSessionIds.has(session.session_id))
          sessions.value = mergeSessionPage(normalized, liveSessions)
          visibleCount.value = SESSION_RENDER_BATCH_SIZE
        }
        hasMoreRemoteSessions.value = Boolean(event.has_more)
        nextSessionCursor.value = typeof event.next_cursor === 'string' ? event.next_cursor : null
      } else {
        sessions.value = normalized
      }
      hasLoadedSessions.value = true
      isLoadingPage.value = false
      requestingNextPage.value = false
    }
    if (evt.type === 'daemon_list') {
      daemons.value = (evt as any).daemons || []
      hasLoadedDaemons.value = true
      if (isMobile.value) void refreshOrganization()
    }
    if (evt.type === 'daemon_status') {
      const event = evt as any
      hasLoadedDaemons.value = true
      const index = daemons.value.findIndex(daemon => daemon.daemon_id === event.daemon_id)
      if (index >= 0) {
        const daemon = daemons.value[index]
        daemons.value[index] = {
          ...daemon,
          ...(event.hostname ? { hostname: event.hostname } : {}),
          ...(event.agents ? { agents: event.agents } : {}),
          ...(event.alias !== undefined ? { daemon_alias: event.alias } : {}),
          ...(event.status === 'online' ? { daemon_online: true } : {}),
          ...(event.status === 'offline' ? { daemon_online: false } : {}),
          status: event.status,
        }
      } else if (event.status === 'online') {
        daemons.value.push({
          daemon_id: event.daemon_id,
          hostname: event.hostname || 'unknown',
          agents: event.agents || [],
          daemon_alias: event.alias || null,
          daemon_online: true,
          status: 'online',
        })
      }
    }
    if (evt.type === 'session_status' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) {
        existing.status = evt.status
        if (evt.exit_reason) existing.exit_reason = evt.exit_reason
        if (evt.last_activity_at) existing.last_activity_at = new Date(evt.last_activity_at)
      }
    }
    if (evt.type === 'session_id_changed' && evt.session_id) {
      const old = (evt as any).old_session_id
      const existing = sessions.value.find(s => s.session_id === old)
      if (existing) existing.session_id = evt.session_id
    }
    if (evt.type === 'session_created' && evt.session_id) {
      if ((!hostId.value || (evt as any).daemon_id === hostId.value) && !sessions.value.find(s => s.session_id === evt.session_id)) {
        liveSessionIds.add(evt.session_id)
        hasLoadedSessions.value = true
        sessions.value.unshift({ session_id: evt.session_id, status: 'running', agent: (evt as any).agent_type || (evt as any).agent || 'claude-code', started_at: new Date(), title: evt.title || '', source: 'daemon', last_activity_at: new Date(), model: (evt as any).model || '' })
      }
    }
    if (evt.type === 'session_discovered' && evt.session_id) {
      if ((!hostId.value || (evt as any).daemon_id === hostId.value) && !sessions.value.find(s => s.session_id === evt.session_id)) {
        const replayed = evt.resync === true
        const sourceActivityAt = evt.last_activity_at ? new Date(evt.last_activity_at) : undefined
        // Older daemons cannot provide a trustworthy timestamp for replayed
        // discoveries. The authoritative session_list refresh will add those
        // without manufacturing "now" in the browser.
        if (replayed && (!sourceActivityAt || Number.isNaN(sourceActivityAt.getTime()))) return
        if (!replayed) liveSessionIds.add(evt.session_id)
        hasLoadedSessions.value = true
        const activityAt = sourceActivityAt || new Date()
        const discovered = {
          session_id: evt.session_id,
          status: evt.status || 'busy',
          agent: (evt as any).agent || 'claude-code',
          started_at: activityAt,
          title: evt.title || 'Terminal Session',
          source: 'terminal',
          cwd: evt.cwd,
          last_activity_at: activityAt,
          subagent_count: (evt as any).subagent_count || 0,
          daemon_id: (evt as any).daemon_id || '',
          hostname: (evt as any).hostname || '',
          model: (evt as any).model || '',
        }
        if (replayed) sessions.value.push(discovered)
        else sessions.value.unshift(discovered)
      }
    }
    if (evt.type === 'session_model_changed' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.model = (evt as any).model || existing.model
    }
    if (evt.type === 'session_title_update' && evt.session_id) {
      const existing = sessions.value.find(s => s.session_id === evt.session_id)
      if (existing) existing.title = evt.title || existing.title
    }
    if (evt.type === 'session_deleted' && evt.session_id) {
      onDeleted(evt.session_id)
      void refreshOrganization()
    }
    if (evt.type === 'session_pinned' && evt.session_id) {
      onPinned(evt.session_id, (evt as any).pinned)
    }
  })
})

onBeforeUnmount(() => { organizationGeneration++; clearTimeout(sessionRequestTimer); loadMoreObserver?.disconnect(); unsubscribeEvents?.(); if (searchTimer) clearTimeout(searchTimer); if (mobileToastTimer) clearTimeout(mobileToastTimer) })

// SessionActions handlers (local optimistic updates; WS events above keep multi-client in sync)
function onDeleted(sessionId: string) {
  sessions.value = sessions.value.filter(s => s.session_id !== sessionId)
  for (const bucket in bucketSessions.value) bucketSessions.value[bucket] = bucketSessions.value[bucket].filter(s => s.session_id !== sessionId)
  archivedSessions.value = archivedSessions.value.filter(s => s.session_id !== sessionId)
  serverSearchResults.value = serverSearchResults.value.filter(s => s.session_id !== sessionId)
}
function onPinned(sessionId: string, pinned: boolean) {
  const s = sessions.value.find(s => s.session_id === sessionId)
  if (s) s.pinned = pinned
  for (const row of [...Object.values(bucketSessions.value).flat(), ...serverSearchResults.value]) if (row.session_id === sessionId) row.pinned = pinned
}

function handleCreate(data: { agent: string; cwd: string; prompt: string }) {
  send({ type: 'session_create', agent: data.agent, cwd: data.cwd, prompt: data.prompt })
  showNewSession.value = false
}

function handleLogout() {
  logout()
  $router.push('/login')
}
</script>

<style scoped>
.session-list { padding: 20px; max-width: 800px; margin: 0 auto; }
.organization-section-label { display: flex; align-items: center; justify-content: space-between; margin: 14px 8px 7px; color: var(--fg-secondary); font-size: 11px; font-weight: 700; letter-spacing: .09em; }
.organization-header { display: flex; align-items: center; gap: 10px; min-height: 43px; margin: 14px 0 6px; padding: 0 12px; border-radius: 9px; background: var(--surface); color: var(--fg-secondary); font-size: 13px; font-weight: 650; }
.organization-header.ungrouped { background: transparent; border-top: 1px solid var(--border); border-radius: 0; }
.organization-fold { display: flex; align-items: center; gap: 9px; flex: 1; min-width: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; }
.organization-fold svg { width: 18px; height: 18px; flex-shrink: 0; }
.organization-header small { margin-left: auto; font: 11px var(--font-mono); color: var(--fg-tertiary); }
.organization-action { border: 0; background: transparent; color: var(--accent); font-size: 12px; cursor: pointer; }
.organization-archive-entry,.organization-back { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 43px; padding: 0 12px; border: 0; border-radius: 9px; background: transparent; color: var(--fg-secondary); cursor: pointer; text-align: left; }
.organization-archive-entry span { margin-left: auto; }
.organization-archive-entry:hover,.organization-back:hover { background: var(--surface-hover); }
.project-load-more { width: calc(100% - 13px); margin-left: 13px; color: var(--accent); font-size: 12px; }
.session-new-badge { display: inline-flex; padding: 2px 5px; border-radius: 4px; color: var(--accent); background: var(--accent-muted); font-size: 9px; font-weight: 700; }
.header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header-row h2 { font-size: 20px; }
.btn { padding: 8px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 14px; }
.btn.primary { background: #238636; border-color: #238636; }
.btn.primary:hover { background: #2ea043; }
.btn.logout { background: transparent; border-color: #30363d; color: #8b949e; font-size: 13px; }
.btn.logout:hover { border-color: #f85149; color: #f85149; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.session-loading { display: grid; gap: 10px; padding-top: 6px; }
.session-skeleton { display: flex; min-height: 76px; align-items: flex-start; gap: 12px; padding: 14px; border: 1px solid var(--border, #21262d); border-radius: 12px; background: var(--surface, #161b22); animation: skeleton-in .35s ease both; animation-delay: var(--delay); }
.skeleton-dot { width: 10px; height: 10px; flex: 0 0 10px; margin-top: 5px; border-radius: 50%; background: var(--surface-active, #30363d); }
.skeleton-lines { display: grid; width: 100%; gap: 8px; }
.skeleton-lines span { height: 10px; border-radius: 6px; background: linear-gradient(90deg, var(--surface-active, #21262d), var(--surface-hover, #30363d), var(--surface-active, #21262d)); background-size: 200% 100%; animation: skeleton-shimmer 1.4s ease-in-out infinite; }
.skeleton-lines span:first-child { width: 52%; height: 14px; }
.skeleton-lines span:nth-child(2) { width: 68%; }
.skeleton-lines span:last-child { width: 34%; }
.error-banner { background: #3d1214; border: 1px solid #da3633; color: #f85149; padding: 12px 16px; border-radius: 8px; margin-bottom: 12px; font-size: 14px; }
.session-load-more { display: flex; justify-content: center; padding: 8px 0 18px; }
.session-load-more-btn { display: inline-flex; min-height: 40px; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border: 1px solid var(--border, #30363d); border-radius: 999px; background: var(--surface, #161b22); color: var(--fg-secondary, #c9d1d9); font-size: 12px; cursor: pointer; }
.session-load-more-btn:disabled { cursor: default; opacity: .65; }
.load-more-spinner { width: 13px; height: 13px; border: 2px solid var(--border-light, #484f58); border-top-color: var(--accent, #58a6ff); border-radius: 50%; animation: load-more-spin .7s linear infinite; }
.session-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border: 1px solid #21262d; border-radius: 8px; margin-bottom: 8px; cursor: pointer; background: #161b22; transition: opacity 0.25s ease; }
.session-row.pending-delete { opacity: 0.35; pointer-events: none; }
.session-row:hover { border-color: #30363d; background: #1c2129; }

/* Status indicator — unified dot/icon system */
.status-indicator {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  position: relative; font-size: 9px; font-weight: 700;
}
.status-indicator.running { background: #22C55E; }
.status-indicator.running .pulse-ring {
  position: absolute; inset: -3px; border-radius: 50%; border: 2px solid #22C55E;
  animation: pulse-ring 1.5s infinite;
}
.status-indicator.busy { background: #d29922; }
.status-indicator.busy .pulse-ring {
  position: absolute; inset: -3px; border-radius: 50%; border: 2px solid #d29922;
  animation: pulse-ring 1.5s infinite;
}
.status-indicator.idle { background: #EAB308; }
.status-indicator.waiting_approval { background: #F97316; }
.status-indicator.waiting_question { background: #A855F7; }
.status-indicator.exited { background: #6B7280; }
.status-indicator.completed { background: #9CA3AF; color: white; }
.status-indicator.error { background: #EF4444; }
.status-indicator.killed { background: #DC2626; color: white; }
.status-indicator.disconnected {
  background: transparent; border: 2px dashed #3B82F6;
  animation: none;
}

.exit-reason { font-size: 11px; color: #6B7280; }
.session-id { font-family: monospace; font-size: 12px; color: #58a6ff; }
.model-badge {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #8b949e;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11px;
}
.session-time { margin-left: auto; color: #8b949e; font-size: 13px; white-space: nowrap; }
.session-info { flex: 1; min-width: 0; }
.session-title { font-size: 14px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 2px; }
.session-title :deep(.session-pin-badge) { margin-right: 5px; }
.ss-rename-input { background: var(--bg, #0d1117); border: 1px solid #58a6ff; border-radius: 6px; box-shadow: 0 0 0 3px rgba(88,166,255,0.15); color: #e6edf3; font-family: inherit; font-size: 14px; font-weight: 500; padding: 4px 8px; outline: none; width: 100%; max-width: 200px; }
.session-meta { display: flex; align-items: center; gap: 8px; }
.source-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; }
.source-badge.terminal { background: #1f3a5f; color: #79c0ff; }
.source-badge.daemon { background: #1a3a2a; color: #7ee787; }
.hostname-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #1c2333; color: #8b949e; }
.subagent-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #2d1a3e; color: #c084fc; }
.system-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: rgba(210,168,255,.08); color: #d2a8ff; border: 1px solid rgba(210,168,255,.4); }
.child-kind-icon { font-size: 11px; }
.child-row-sdk .child-title { color: #d2a8ff; }
.token-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #1a2e1a; color: #7ee787; }

/* Fold toggle */
.session-group { margin-bottom: 8px; }
.fold-toggle { cursor: pointer; margin-right: 4px; font-size: 14px; color: #8b949e; user-select: none; line-height: 1; }
.fold-toggle:hover { color: #e6edf3; }

/* Child rows */
.child-rows { padding: 4px 0 4px 42px; }
.child-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 13px; color: #8b949e; border-radius: var(--radius-sm); cursor: pointer; transition: background 0.15s, color 0.15s; }
.child-row:hover { background: var(--hover, rgba(255,255,255,0.04)); color: #c9d1d9; }
.child-indent { color: #6B7280; font-size: 12px; flex-shrink: 0; }
.child-title { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.child-token { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: var(--success-bg); color: var(--success); }

.mobile-session-nav,
.mobile-daemon-status,
.mobile-session-search,
.mobile-search-summary,
.mobile-search-empty { display: none; }

/* m 端底部 sheet:长按菜单 + 删除确认(方案 B) */
.mobile-sheet-scrim {
  position: fixed;
  inset: 0;
  z-index: 240;
  background: rgba(1, 4, 9, .62);
  backdrop-filter: blur(2px);
  animation: mobile-sheet-fade .18s ease;
}
.mobile-sheet {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 241;
  padding: 8px 14px calc(14px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border-light);
  border-radius: 16px 16px 0 0;
  background: var(--surface);
  box-shadow: 0 -8px 30px rgba(0, 0, 0, .35);
  animation: mobile-sheet-up .26s cubic-bezier(.2, .8, .2, 1);
}
.mobile-sheet-grab { width: 36px; height: 4px; margin: 4px auto 10px; border-radius: 2px; background: var(--border-light); }
.mobile-sheet-title { margin-bottom: 4px; overflow: hidden; color: var(--fg); font-size: 13.5px; font-weight: 650; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
.mobile-sheet-desc { margin-top: 2px; color: var(--fg-secondary); font-size: 12px; line-height: 1.6; text-align: center; }
.mobile-sheet-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 8px;
  min-height: 46px;
  padding: 12px 14px;
  border: 0;
  border-radius: 10px;
  background: var(--surface-hover);
  color: var(--fg);
  font-size: 13.5px;
  font-weight: 550;
}
.mobile-sheet-item:active { background: var(--surface-active); }
.mobile-sheet-item svg { width: 16px; height: 16px; flex: 0 0 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.mobile-sheet-item.danger { color: var(--error); }
.mobile-sheet-cancel { margin-top: 10px; padding: 12px; border-radius: 10px; background: var(--bg-secondary); color: var(--fg-secondary); font-size: 13px; font-weight: 600; text-align: center; cursor: pointer; }
.mobile-sheet-row { display: flex; gap: 10px; margin-top: 12px; }
.mobile-sheet-btn { flex: 1; min-height: 46px; padding: 12px; border: 0; border-radius: 10px; background: var(--surface-hover); color: var(--fg); font-size: 13.5px; font-weight: 650; }
.mobile-sheet-btn.danger { background: var(--error); color: #fff; }
.mobile-toast {
  position: fixed;
  inset: auto 0 18px;
  z-index: 250;
  margin: 0 auto;
  width: max-content;
  max-width: 86%;
  padding: 9px 16px;
  border-radius: var(--radius-full, 9999px);
  background: color-mix(in srgb, var(--accent) 88%, #000);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
  animation: mobile-toast-in .22s cubic-bezier(.2, .8, .2, 1);
}
@keyframes mobile-sheet-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mobile-sheet-up { from { transform: translateY(102%); } to { transform: translateY(0); } }
@keyframes mobile-toast-in { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .mobile-sheet, .mobile-sheet-scrim, .mobile-toast { animation: none; }
}

/* Mobile */
@media (max-width: 768px) {
  .session-list { min-height: 100dvh; padding: 0 10px 20px; background: var(--bg); }
  .header-row { display: none; }
  .mobile-session-nav {
    position: sticky;
    top: 0;
    z-index: 60;
    display: grid;
    min-height: calc(56px + env(safe-area-inset-top));
    grid-template-columns: minmax(82px, auto) minmax(0, 1fr) auto;
    align-items: center;
    margin: 0 -10px;
    padding: max(6px, env(safe-area-inset-top)) 10px 7px;
    background: color-mix(in srgb, var(--bg) 94%, transparent);
    backdrop-filter: blur(14px);
  }
  .mobile-session-back {
    min-width: 0;
    height: 32px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0;
    border: 0;
    color: var(--accent);
    background: transparent;
    font-size: 15px;
    white-space: nowrap;
  }
  .mobile-session-back svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .mobile-session-host { min-width: 0; display: grid; justify-items: center; gap: 1px; }
  .mobile-session-nav-title { width: 100%; min-width: 0; max-width: 100%; margin: 0; overflow: hidden; color: var(--fg); font: 600 17px/21px var(--font-display); text-align: center; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-daemon-status { min-width: 0; display: flex; align-items: center; justify-content: center; gap: 5px; color: var(--fg-secondary); font-size: 11px; line-height: 14px; }
  .mobile-daemon-status-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-session-nav-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
  .mobile-session-nav-actions button {
    width: 32px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--border-light);
    border-radius: 50%;
    color: var(--fg-secondary);
    background: var(--surface-hover);
  }
  .mobile-session-nav-actions .mobile-new-session { border-color: var(--primary-btn); color: var(--bg); background: var(--primary-btn); }
  .mobile-session-nav-actions svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .mobile-session-nav-actions .mobile-session-inbox {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    overflow: visible;
    padding: 0;
    border-color: color-mix(in srgb, var(--accent) 28%, var(--border-light));
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface-hover));
  }
  .mobile-session-nav-actions .mobile-session-inbox.has-attention {
    border-color: color-mix(in srgb, var(--warning) 38%, var(--border-light));
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 10%, var(--surface-hover));
  }
  .mobile-session-nav-actions .mobile-session-inbox:active { background: var(--surface-active); }
  .mobile-session-nav-actions .mobile-session-inbox:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .mobile-daemon-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-tertiary); }
  .mobile-daemon-dot.online { background: var(--success); }
  .mobile-session-search {
    display: flex;
    height: 36px;
    align-items: center;
    gap: 7px;
    margin: 0 0 8px;
    padding: 0 10px;
    border: 1px solid var(--border-light);
    border-radius: 10px;
    background: var(--surface-hover);
  }
  .mobile-session-search > svg { width: 16px; height: 16px; flex: 0 0 16px; fill: none; stroke: var(--fg-tertiary); stroke-width: 2; stroke-linecap: round; }
  .mobile-session-search input { min-width: 0; flex: 1; padding: 0; border: 0; outline: 0; color: var(--fg); background: transparent; font: 13px var(--font-body); -webkit-appearance: none; appearance: none; }
  .mobile-session-search input::-webkit-search-cancel-button { display: none; }
  .mobile-session-search button { width: 28px; height: 28px; display: grid; flex: 0 0 28px; place-items: center; padding: 0; border: 0; color: var(--fg-tertiary); background: transparent; }
  .mobile-session-search button svg { width: 18px; height: 18px; fill: currentColor; stroke: var(--surface-hover); stroke-width: 1.8; }
  .mobile-search-summary { display: block; margin: 0 0 8px; color: var(--fg-tertiary); font-size: 11px; line-height: 14px; }
  .mobile-search-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 44px 18px; text-align: center; }
  .mobile-search-empty strong { color: var(--fg); font-size: 14px; font-weight: 500; }
  .mobile-search-empty span { color: var(--fg-secondary); font-size: 12px; }
  .error-banner { margin-top: 4px; }
  .session-loading { gap: 8px; padding-top: 8px; }
  .session-skeleton { min-height: 73px; gap: 10px; padding: 12px 10px 12px 14px; }
  .skeleton-dot { width: 8px; height: 8px; flex-basis: 8px; margin-top: 6px; }
  .session-group { margin-bottom: 8px; }
  .child-rows.mobile-child-panel {
    margin: -10px 6px 0;
    padding: 14px 11px 9px;
    border: 1px solid var(--border-light);
    border-top: 0;
    border-radius: 0 0 10px 10px;
    background: color-mix(in srgb, var(--accent) 4.5%, transparent);
  }
  .mobile-child-header { min-height: 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
  .mobile-child-header strong { color: var(--fg-secondary); font-size: 11px; font-weight: 600; }
  .mobile-child-header button, .mobile-child-more { padding: 0; border: 0; color: var(--accent); background: transparent; font-size: 10px; font-weight: 500; }
  .child-row { min-height: 28px; gap: 7px; padding: 3px 1px; color: var(--fg-secondary); font-size: 11px; }
  .child-indent { width: 12px; color: #6e7681; font-size: 12px; text-align: center; }
  .child-status-dot { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: #6e7681; }
  .child-status-dot.running, .child-status-dot.busy, .child-status-dot.retry { background: var(--success); }
  .child-status-dot.error { background: var(--error); }
  .child-title { flex: 1; color: var(--fg-secondary); }
  .child-token { padding: 0; border-radius: 0; color: #6e7681; background: transparent; font: 10px var(--font-mono); white-space: nowrap; }
  .mobile-child-more { margin: 2px 0 0 25px; color: #6e7681; font-weight: 400; }
  .session-load-more { padding-bottom: 8px; }
  .btn { padding: 10px 14px; font-size: 13px; min-height: 44px; }
}
@keyframes pulse-ring { 0% { opacity: 0.8; transform: scale(1); } 100% { opacity: 0; transform: scale(1.6); } }
@keyframes load-more-spin { to { transform: rotate(360deg); } }
@keyframes skeleton-shimmer { to { background-position: -200% 0; } }
@keyframes skeleton-in { from { opacity: 0; transform: translateY(4px); } }

/* iOS sidebar reference: compact toolbar, horizontal filters and grouped cards. */
@media (max-width: 768px) {
  .session-list { padding: 0 10px max(24px, env(safe-area-inset-bottom)); }
  .mobile-session-nav { grid-template-columns: 38px minmax(0, 1fr) auto; min-height: calc(62px + env(safe-area-inset-top)); padding: max(4px, env(safe-area-inset-top)) 12px 4px; border-bottom: 1px solid var(--border); background: var(--bg); backdrop-filter: none; }
  .mobile-session-back { width: 38px; min-height: 44px; justify-content: flex-start; }
  .mobile-session-back svg { width: 22px; height: 22px; }
  .mobile-session-host { justify-items: start; gap: 3px; }
  .mobile-session-nav-title { font: 600 17px/22px var(--font-body); text-align: left; }
  .mobile-session-host-caption { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-tertiary); font-size: 11px; }
  .mobile-session-nav-actions { gap: 4px; }
  .mobile-session-nav-actions button { width: 36px; height: 36px; position: relative; }
  .mobile-session-nav-actions button::after { content: ''; position: absolute; inset: -4px; }
  .mobile-session-nav-actions .mobile-session-inbox { width: 36px; height: 36px; min-width: 36px; min-height: 36px; }
  .mobile-session-nav-actions .mobile-team-shortcut { display: none; }
  .mobile-session-presence { display: flex; align-items: center; gap: 6px; margin: 12px 6px 14px; color: var(--fg-secondary); font-size: 12px; }
  .mobile-agent-filters { margin: 0 6px 20px; }
  .mobile-agent-filters p { margin: 0 0 7px; color: var(--fg-tertiary); font-size: 11px; }
  .mobile-agent-chips { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding: 1px 0; }
  .mobile-agent-chips button { flex: 0 0 auto; min-height: 44px; padding: 0 13px; border: 1px solid var(--border); border-radius: 23px; background: var(--surface); color: var(--fg-secondary); font: 500 13px var(--font-body); }
  .mobile-agent-chips button[aria-pressed=true] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); background: var(--accent-muted); }
  .mobile-agent-chips span { font-variant-numeric: tabular-nums; opacity: .7; margin-left: 3px; }
  .mobile-session-search { height: 44px; margin: 0 6px 12px; }
  .mobile-session-search input { font-size: 16px; }
  .organization-section-label { min-height: 30px; margin: 0 12px 6px; font-size: 12px; font-weight: 500; letter-spacing: 0; }
  .organization-header { min-height: 44px; margin: 12px 0 6px; border-radius: 11px; }
  .organization-header.ungrouped { border: 0; padding-top: 6px; }
  .organization-action { width: 44px; min-height: 44px; display: grid; place-items: center; }
  .organization-action span { display: none; }
  .organization-action svg { width: 18px; height: 18px; }
  .organization-archive-entry { margin-top: 12px; min-height: 50px; border-top: 1px solid var(--border); border-radius: 0; font-size: 12px; }
  .organization-archive-entry svg { width: 18px; height: 18px; }
  .mobile-search-summary { margin-left: 6px; }
}

@media(max-width:768px) {
  .mobile-list-controls { padding: 10px 6px 0; }
  .mobile-host-scope { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
  .mobile-host-scope > .action-select { max-width: 60%; min-width: 0; }
  .mobile-host-scope :deep(.action-select-trigger) { min-height: 36px; border: 0; background: none; padding: 0; color: var(--accent); font-size: 13px; font-weight: 600; }
  .mobile-host-stats,.mobile-host-scope .mobile-daemon-status-copy { margin-left: auto; color: var(--fg-tertiary); font-size: 11px; display: flex; align-items: center; gap: 5px; }
  .mobile-filter-row { display: flex; align-items: center; gap: 8px; }
  .mobile-agent-chips { flex: 1; min-width: 0; }
  .mobile-agent-chips button { min-height: 36px; padding: 7px 11px; font-size: 12px; }
  .mobile-active-filter { flex-shrink: 0; min-height: 36px; border: 1px solid var(--border); border-radius: 9px; padding: 0 10px; background: none; color: var(--fg-secondary); font-size: 12px; }
  .mobile-active-filter[aria-pressed=true] { background: var(--accent-muted); color: var(--accent); border-color: var(--accent); }
  .mobile-loaded-summary { margin: 10px 0 8px; color: var(--fg-tertiary); font-size: 11px; }
  .mobile-host-section { display: flex; align-items: center; min-height: 44px; padding: 2px 6px 0; margin-top: 12px; gap: 10px; }
  .mobile-host-section strong { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; color: var(--fg); }
  .mobile-host-section button { width: 44px; height: 44px; border: 0; color: var(--accent); background: none; }
  .mobile-host-section svg { width: 18px; height: 18px; }
  .organization-header { background: transparent; min-height: 34px; margin: 4px 0; padding-left: 6px; font-weight: 500; font-size: 12px; }
  .organization-fold { color: var(--fg-secondary); }
  .organization-header.ungrouped { min-height: 28px; font-size: 11px; }
}

@media(max-width:768px) {
  .session-group.mobile-host-nested { margin-left: 16px; }
  .mobile-filter-empty { padding: 28px 16px; color: var(--fg-secondary); font-size: 13px; text-align: center; }
  .mobile-filter-empty button { min-height: 44px; padding: 0 16px; border: 1px solid var(--border); border-radius: 10px; color: var(--accent); background: var(--surface); }
}

/* Host-group hierarchy and dimensions from ios-sidebar/index.html rev13. */
.mobile-host-picker-row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 10px 2px; border: 0; border-bottom: 1px solid var(--border); background: none; color: var(--fg); text-align: left; }
.mobile-host-picker-row > svg { flex: 0 0 20px; width: 20px; height: 20px; color: var(--accent); }
.mobile-host-picker-row > span { flex: 1; min-width: 0; display: grid; gap: 5px; }
.mobile-host-picker-row strong { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.mobile-host-picker-row small { color: var(--fg-tertiary); font-size: 11px; }
.point-up { transform: rotate(180deg); }
.mobile-drop-active { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: 10px; }
@media(max-width:768px) {
  .mobile-session-host-caption { display: none; }
  .mobile-session-nav-actions { gap: 8px; }
  .mobile-session-nav-actions button, .mobile-session-nav-actions .mobile-session-inbox { width: 32px; height: 32px; min-width: 32px; min-height: 32px; }
  .mobile-list-controls { padding: 10px 6px 0; }
  .mobile-host-picker-trigger { display: flex; align-items: center; gap: 7px; max-width: 65%; min-height: 36px; border: 0; background: none; color: var(--accent); padding: 0; font-size: 13px; font-weight: 600; }
  .mobile-host-picker-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-host-picker-trigger svg { width: 16px; height: 16px; flex-shrink: 0; }
  .mobile-filter-row { padding-bottom: 10px; }
  .mobile-agent-chips button, .mobile-active-filter { min-height: 34px; }
  .mobile-active-filter { font-size: 11px; padding: 0 9px; }
  .mobile-result-bar { display: flex; align-items: center; gap: 8px; min-height: 35px; padding: 0 6px; color: var(--fg-tertiary); font-size: 11px; }
  .mobile-result-bar > :first-child { margin-right: auto; }
  .session-group { margin-bottom: 0; }
  .session-group.mobile-host-nested { border-left: 1px solid var(--border); margin-left: 6px; padding: 0 0 0 10px; }
  .session-group:not(.mobile-host-nested) { padding-left: 6px; }
  .session-group:has(.mobile-host-section) { padding-left: 0; }
  .session-group.mobile-host-end { padding-bottom: 2px; margin-bottom: 12px; }
  .mobile-host-section { margin: 0; padding: 2px 6px 0; }
  .mobile-host-section :deep(.project-create-trigger.labeled) { width: auto; height: auto; }
  .mobile-host-section :deep(.project-create-trigger.labeled svg) { width: 12px; height: 12px; }
  .organization-header { padding: 0; min-height: 32px; margin: 0 0 5px; gap: 6px; }
  .organization-fold { padding: 0; gap: 6px; min-height: 32px; font-size: 12px; }
  .organization-fold svg { width: 13px; height: 13px; }
  .organization-header small { margin-left: 0; font-size: 10px; }
  .organization-fold .project-disclosure { width: 10px; height: 10px; }
  .organization-action { width: 32px; min-height: 32px; color: var(--fg-tertiary); }
  .organization-header.ungrouped { min-height: 25px; padding: 0; margin: 4px 0 5px; }
  .mobile-card-stack { margin-bottom: 8px; }
  .mobile-host-note { display: flex; gap: 6px; align-items: flex-start; margin: 0; padding: 2px 2px 10px; font-size: 11px; line-height: 1.7; color: var(--fg-tertiary); }
  .mobile-host-note svg { width: 13px; height: 13px; flex-shrink: 0; margin-top: 3px; }
  .mobile-host-empty { margin: 0; padding: 12px 2px; font-size: 11px; color: var(--fg-tertiary); }
  .mobile-host-more { min-height: 40px; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: transparent; color: var(--accent); font-size: 12px; }
  .mobile-host-more:disabled { opacity: .5; }
  .child-rows.mobile-child-panel { margin: -1px 0 0; padding: 8px 11px; border-radius: 0 0 12px 12px; }
}

</style>
