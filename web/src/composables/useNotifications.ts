import { ref } from 'vue'

const permissionGranted = ref(false)
const permissionDenied = ref(false)
let permissionRequested = false

// Terminal states that should trigger notifications
const TERMINAL_STATES = new Set(['exited', 'error', 'killed', 'completed'])

export function useNotifications() {

  function requestPermission(): void {
    if (permissionRequested) return
    if (!('Notification' in window)) return

    permissionRequested = true
    Notification.requestPermission().then(result => {
      if (result === 'granted') {
        permissionGranted.value = true
      } else if (result === 'denied') {
        permissionDenied.value = true
      }
    })
  }

  /**
   * Send a browser notification if:
   * - Permission is granted
   * - The status is a terminal state
   * - User is not currently viewing this session's page
   */
  function notifySessionStateChange(
    sessionId: string,
    sessionTitle: string,
    newStatus: string,
    currentRouteSessionId?: string
  ): void {
    if (!permissionGranted.value) return
    if (!TERMINAL_STATES.has(newStatus)) return
    // Don't notify if user is viewing this session
    if (currentRouteSessionId === sessionId) return

    const statusLabels: Record<string, string> = {
      exited: '已退出',
      error: '异常退出',
      killed: '已终止',
      completed: '已完成',
    }
    const label = statusLabels[newStatus] || newStatus
    const title = `Session "${sessionTitle || sessionId.slice(0, 8)}" ${label}`

    try {
      const notification = new Notification(title, {
        body: `Session 状态变更为 ${label}`,
        tag: `session-${sessionId}`,
        requireInteraction: false,
      })

      notification.onclick = () => {
        window.focus()
        // Navigate to session detail page
        const base = window.location.origin
        window.location.href = `${base}/session/${sessionId}`
        notification.close()
      }
    } catch {
      // Notification API may not be available in all contexts
    }
  }

  return {
    permissionGranted,
    permissionDenied,
    requestPermission,
    notifySessionStateChange,
  }
}
