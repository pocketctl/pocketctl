import type { UserPreferences } from '../composables/useUserPreferences'

type WorkspaceNotice = { key: string; titleKey: string; body: string; path: string }
export function workspaceNotification(
  message: Record<string, any>, preferences: UserPreferences['notifications'], currentSession: string,
): WorkspaceNotice | null {
  if (!preferences.browser || message.resync || message.is_subagent || message.agent_id) return null
  if (['session_status', 'turn_status'].includes(message.type) && message.session_id && message.session_id !== currentSession) {
    const status = message.turn_status || message.status
    const failed = ['error', 'failed'].includes(status)
    const completed = ['completed', 'exited'].includes(status)
    if ((failed && preferences.errors) || (completed && preferences.completed)) return {
      key: `session:${message.session_id}:${message.turn_id || ''}:${failed ? 'error' : 'completed'}`,
      titleKey: failed ? 'settings.notif_error' : 'settings.notif_session',
      body: message.title || message.session_id,
      path: `/session/${encodeURIComponent(message.session_id)}`,
    }
  }
  if (message.type === 'daemon_status' && message.status === 'offline' && preferences.daemon) return {
    key: `daemon:${message.daemon_id}:offline`, titleKey: 'settings.notif_host',
    body: message.alias || message.hostname || message.daemon_id, path: '/hosts',
  }
  if (message.type === 'product_update' && preferences.updates && typeof message.title === 'string') return {
    key: `update:${message.id}`, titleKey: 'settings.notif_product', body: message.title, path: '/settings',
  }
  return null
}
