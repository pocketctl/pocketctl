import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'

export interface MemoryOperationalSnapshot {
  state: 'ready' | 'syncing' | 'degraded' | 'error' | 'offline'
  last_error_code: string | null
  reported_at?: string | null
}

const STATUS_TIMEOUT_MS = 10_000

/** One deadline covers the first request, auth refresh, retry and body decode. */
export async function readMemoryOperationalStatus(installationId: string): Promise<MemoryOperationalSnapshot | null> {
  const { accessToken, doRefreshToken } = useAuth()
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new Error('memory_status_unavailable'))
    }, STATUS_TIMEOUT_MS)
  })
  const request = () => {
    if (controller.signal.aborted) throw new Error('memory_status_unavailable')
    return fetch(`${getRelayOrigin()}/api/extensions/v1/status`, {
      headers: { Authorization: `Bearer ${accessToken.value}`, Accept: 'application/json' },
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
  }
  const read = async () => {
    let response = await request()
    if (controller.signal.aborted) throw new Error('memory_status_unavailable')
    if (response.status === 401 && await doRefreshToken()) response = await request()
    if (!response.ok) throw new Error('memory_status_unavailable')
    const body = await response.json() as { installations?: Array<MemoryOperationalSnapshot & { installation_id: string }> }
    const row = body.installations?.find(item => item.installation_id === installationId)
    if (!row || !['ready', 'syncing', 'degraded', 'error', 'offline'].includes(row.state)) return null
    return row
  }
  try {
    // A transport/auth helper that ignores AbortSignal must still release the UI.
    return await Promise.race([read(), expired])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
