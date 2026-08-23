import type {
  AttentionInboxConfig,
  AttentionItemRecord,
  AttentionRecoveryRecord,
} from './types.js'

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function serializeAttentionConfig(config: AttentionInboxConfig) {
  return {
    schema_version: config.schemaVersion,
    mode: config.mode,
    enabled: config.enabled,
    remote_response_enabled: config.remoteResponseEnabled,
    providers: {
      codex: {
        projection: config.providers.codex.projection,
        remote_response: config.providers.codex.remoteResponse,
      },
      opencode: {
        projection: config.providers.opencode.projection,
        remote_response: config.providers.opencode.remoteResponse,
      },
      'claude-code': {
        projection: false,
        remote_response: false,
      },
    },
  }
}

export function serializeAttentionConfigV2(config: AttentionInboxConfig) {
  return {
    ...serializeAttentionConfig(config),
    schema_version: 2,
    recovery: {
      mode: config.recovery.mode,
      projection: config.recovery.projection,
      visible: config.recovery.visible,
    },
  }
}

export function serializeAttentionItem(item: AttentionItemRecord | Record<string, any>) {
  return {
    item_id: item.itemId,
    revision: item.revision,
    provider: item.provider,
    kind: item.kind,
    state: item.state,
    risk: {
      level: item.riskLevel,
      classification_incomplete: item.classificationIncomplete,
      reasons: item.riskReasons ?? [],
    },
    daemon: { id: item.daemonId, display_name: item.daemonDisplayName ?? item.daemonId },
    session: { id: item.sessionId, title: item.sessionTitle ?? item.summary, status: item.sessionStatus ?? null },
    request_id: item.requestId,
    title: item.title,
    summary: item.summary,
    context: item.context ?? {},
    allowed_actions: (item.allowedActions ?? []).map((action: any) => ({
      id: action.id, style: action.style, destructive: action.destructive, label_key: action.labelKey,
    })),
    seen_at: iso(item.seenAt),
    snoozed_until: iso(item.snoozedUntil),
    submitted_at: iso(item.submittedAt),
    resolved_at: iso(item.resolvedAt),
    handled_at: iso(item.handledAt),
    expires_at: iso(item.expiresAt),
    resolution: item.resolution ?? null,
    last_error: item.lastErrorCode ? { code: item.lastErrorCode } : null,
    created_at: iso(item.createdAt),
    updated_at: iso(item.updatedAt),
  }
}

export function serializeAttentionRecovery(item: AttentionRecoveryRecord | Record<string, any>) {
  return {
    recovery_id: item.recoveryId,
    revision: item.revision,
    kind: 'recovery',
    state: item.state,
    reason_code: item.reasonCode,
    daemon: { id: item.daemonId, display_name: item.daemonDisplayName ?? item.daemonId },
    navigation: { type: 'host', daemon_id: item.daemonId },
    last_seen_at: iso(item.lastSeenAt),
    seen_at: iso(item.seenAt),
    snoozed_until: iso(item.snoozedUntil),
    resolved_at: iso(item.resolvedAt),
    handled_at: iso(item.handledAt),
    resolution: item.resolution ?? null,
    created_at: iso(item.createdAt),
    updated_at: iso(item.updatedAt),
  }
}
