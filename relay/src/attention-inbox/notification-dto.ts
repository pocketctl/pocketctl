import type {MaintenanceSummary} from '../session-lifecycle/maintenance-summary.js'
import type {
  LifecycleAction,
  LifecycleJobState,
} from '../session-lifecycle/types.js'

export interface NotificationSubject {
  id: string
  sessionId: string
  daemonId: string
  title: string
  daemonName: string
  action: LifecycleAction
  state: Exclude<LifecycleJobState, 'queued'>
  activityAt: string
  executedAt: string | null
  effectivePurgeAt: string | null
  reasonCode: string
  stages?: Record<string,string>
  navigation: { type: 'session' | 'lifecycle_detail'; id: string }
}
export interface SystemNotification {
  id: string
  revision: number
  kind: 'system'
  topic: 'session_lifecycle'
  createdAt: string
  readAt: string | null
  expiresAt: string
  subjectCount: number
  subjects: NotificationSubject[]
  subjectsNextCursor: string | null
  maintenance?: MaintenanceSummary
  requiresApproval: false
}
export function serializeNotificationSubject(s: NotificationSubject) {
  return {
    subject_id: s.id,
    session_id: s.sessionId,
    daemon_id: s.daemonId,
    title: s.title,
    daemon_name: s.daemonName,
    action: s.action,
    result: s.state,
    last_activity_at: s.activityAt,
    executed_at: s.executedAt,
    effective_purge_at: s.effectivePurgeAt,
    reason_code: s.reasonCode,
    stages:s.stages??{},
    navigation: s.navigation,
  }
}
export function serializeSystemNotification(n: SystemNotification) {
  return {
    notification_id: n.id,
    revision: n.revision,
    kind: n.kind,
    topic: n.topic,
    created_at: n.createdAt,
    read_at: n.readAt,
    expires_at: n.expiresAt,
    subject_count: n.subjectCount,
    subject_preview: n.subjects.map(serializeNotificationSubject),
    subjects_next_cursor: n.subjectsNextCursor,
    ...(n.maintenance?{maintenance:n.maintenance}:{}),
    requires_approval: false,
  }
}
