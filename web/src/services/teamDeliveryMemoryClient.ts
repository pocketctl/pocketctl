import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
import type { MemoryDeliverySource } from '../types/memory'

export interface DeliveryMemoryStatus {
  source: MemoryDeliverySource | null
  candidates?: { pending: number; stale: number; rejected: number }
  personal_claims?: { confirmed: number; current: number }
  extraction_state?: string | null
}
export interface DeliveryMemoryReadScope {
  userId: number; origin: string; isCurrent: () => boolean; signal?: AbortSignal
}
/** No shared grant cache: each read is pinned to the original account/Relay.
 * The access token goes only to Relay; only its short capability reaches Memory. */
export async function readDeliveryMemoryStatus(taskId: string, submissionId: string, decisionId: string,
  scope: DeliveryMemoryReadScope): Promise<DeliveryMemoryStatus> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  scope.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 15_000)
  try {
  const auth = useAuth(), token = auth.accessToken.value
  function current() {
    if (!scope.isCurrent() || scope.signal?.aborted || auth.user.value?.id !== scope.userId
      || auth.accessToken.value !== token || getRelayOrigin() !== scope.origin) throw new Error('读取范围已变化，请重新打开任务。')
  }
  async function relay(path: string, body?: unknown) {
    current()
    const response = await fetch(scope.origin + path, { method: body ? 'POST' : 'GET', credentials: 'include',
      redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    current()
    if (!response.ok) throw new Error('无法读取个人 Memory 授权，请在记忆页检查服务状态。')
    const result = await response.json(); current(); return result
  }
  const installations = await relay('/api/extensions/v1/installations')
  const installation = installations.installations?.find((row: any) => row.provider_id === 'pocketctl-memory'
    && row.status === 'active' && (!row.owner_scope_kind || row.owner_scope_kind === 'personal'))
  if (!installation || !installation.enabled_services?.includes('memory.manage')) throw new Error('个人 Memory 审核服务尚未启用。')
  // Refresh an expired provider capability once; never widen enabled services.
  for (let attempt = 0; attempt < 2; attempt++) {
    const grant = await relay('/api/extensions/v1/grants', {
      installation_id: installation.installation_id, caller_type: 'web', services: ['memory.manage'],
    })
    current()
    if (typeof grant.grant !== 'string' || !grant.grant || typeof grant.provider_public_origin !== 'string') throw new Error('Memory 服务地址尚未配置。')
    const origin = new URL(grant.provider_public_origin)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Memory 服务地址无效。')
    const response = await fetch(`${origin.origin}/api/v1/memory/delivery-sources/${encodeURIComponent(submissionId)}/decisions/${encodeURIComponent(decisionId)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${grant.grant}` },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    })
    current()
    if (response.status === 401 && attempt === 0) continue
    if (!response.ok) throw new Error(response.status === 404 ? '此 Memory 服务暂不支持交付来源查询。' : '无法核对 Memory 状态，请重试。')
    const result = await response.json(); current()
    if (!validStatus(result, taskId, submissionId, decisionId)) throw new Error('Memory 返回的来源身份或状态不匹配。')
    return result
  }
  throw new Error('无法核对 Memory 状态，请重试。')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Memory 状态读取超时或已中断，请重试。')
    throw error
  } finally {
    clearTimeout(timeout)
    scope.signal?.removeEventListener('abort', abort)
  }
}
function validStatus(value: any, taskId: string, submissionId: string, decisionId: string): value is DeliveryMemoryStatus {
  if (!value || typeof value !== 'object') return false
  if (value.source === null) return true
  const s = value.source, count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0
  return s?.task_id === taskId && s.submission_id === submissionId && s.decision_id === decisionId
    && ['available', 'withdrawn'].includes(s.state) && count(s.spec_revision) && s.spec_revision > 0
    && count(s.submission_version) && s.submission_version > 0
    && ['pending', 'stale', 'rejected'].every(k => count(value.candidates?.[k]))
    && ['confirmed', 'current'].every(k => count(value.personal_claims?.[k]))
    && (value.extraction_state === null || ['running', 'succeeded', 'failed', 'quarantined', 'provider_result_unknown'].includes(value.extraction_state))
}
