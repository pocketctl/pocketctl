import type pg from 'pg'

import * as db from '../db.js'
import { quotaEnforcementMode, resolveEntitlements } from '../entitlements.js'
import {
  admitSessionMessage,
  claimContinueAdmissionOutcome,
  completeContinueAdmission,
  recoverContinueAdmission,
} from '../session-message-admissions.js'
import {
  markQuotaReservationUncertain,
  reserveConcurrentSession,
  settleQuotaReservation,
  type QuotaOperation,
} from '../quota.js'
import {
  TeamDispatchRepository,
  dispatchAuthorizationMatches,
  type ClaimedDispatch,
  type DispatchAuthorization,
} from './dispatch-repository.js'
import type { TeamEvent } from './types.js'
import { TeamContextDeliveryService } from './context-delivery.js'

export interface TeamDispatchTransport {
  send(input: { daemonId: string; ownerUserId: number; capability: string; command: Record<string, unknown> }): boolean
}

interface DispatchNotifier {
  event?(sessionId: string, participantUserIds: number[], event: TeamEvent): void
}

export class TeamDispatchService {
  private readonly repository: TeamDispatchRepository
  private readonly contextDelivery: TeamContextDeliveryService
  private readonly timeoutMs: number
  private readonly pollIntervalMs: number
  private readonly daemonEventChains = new Map<string, Promise<void>>()
  private readonly receiptTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activeDispatches = new Map<string, Promise<void>>()
  private pollTimer?: ReturnType<typeof setTimeout>
  private stopped = true

  constructor(
    private readonly pool: pg.Pool,
    private readonly transport: TeamDispatchTransport,
    private readonly notifier: DispatchNotifier = {},
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ) {
    this.repository = new TeamDispatchRepository(pool)
    this.contextDelivery = new TeamContextDeliveryService(pool)
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
  }

  enqueue(callIds: string[]): void {
    for (const callId of callIds) {
      if (this.activeDispatches.has(callId)) continue
      const dispatch = this.dispatch(callId).catch(async error => {
      console.error('[team-dispatch] dispatch failed', { callId, error })
      await this.contextDelivery.stop(callId, 'uncertain', 'dispatch_internal_error').catch(() => {})
      await this.repository.stop(callId, 'uncertain', 'dispatch_internal_error').catch(() => {})
      }).finally(() => {
        if (this.activeDispatches.get(callId) === dispatch) this.activeDispatches.delete(callId)
      })
      this.activeDispatches.set(callId, dispatch)
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped || this.pollTimer) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      void this.pollPending().catch(error => console.error('[team-dispatch] pending poll failed', { error }))
        .finally(() => this.schedulePoll(this.pollIntervalMs))
    }, delayMs)
    this.pollTimer.unref?.()
  }

  private async pollPending(): Promise<void> {
    this.enqueue(await this.repository.listPendingCallIds())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedulePoll(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
    await Promise.allSettled(this.activeDispatches.values())
  }

  async dispatch(callId: string): Promise<void> {
    const claimed = await this.repository.claim(callId)
    if (!claimed) return
    const ownerUserId = claimed.authorization.owner_user_id
    let teamContext
    try {
      teamContext = await this.contextDelivery.prepare(callId)
    } catch (error) {
      await this.repository.stop(callId, 'blocked', 'context_snapshot_unavailable')
      throw error
    }
    const { plan, whitelist } = await db.getUserPlanAndWhitelist(this.pool, ownerUserId)
    const entitlements = resolveEntitlements(plan, whitelist)
    const limit = quotaEnforcementMode() === 'enforce' ? entitlements.maxConcurrentSessions : null
    const baseCommand: Record<string, unknown> = {
      type: claimed.nativeSessionId ? 'collaboration_user_message' : 'collaboration_session_create',
      session_id: claimed.nativeSessionId ?? undefined,
      agent: claimed.provider,
      content: claimed.content,
      request_id: claimed.providerRequestId,
      msg_id: claimed.callId,
      collaboration: claimed.authorization,
      team_context: teamContext,
    }

    let reservationId: string | null = null
    let expiresAt: number | null = null
    let operation: QuotaOperation = claimed.nativeSessionId ? 'resume' : 'create'
    let reused = false
    if (!claimed.nativeSessionId) {
      const decision = await reserveConcurrentSession(this.pool, {
        userId: ownerUserId, requestId: claimed.providerRequestId, operation: 'create',
        daemonId: claimed.authorization.daemon_id, agentType: claimed.provider,
        cwd: `team-binding:${claimed.authorization.binding_id}`, limit,
      })
      if (!decision.allowed) {
        await this.contextDelivery.stop(callId, 'failed', decision.reason)
        await this.repository.stop(callId, 'blocked', decision.reason)
        return
      }
      reservationId = decision.reservationId
      expiresAt = decision.expiresAt
      reused = decision.reused
    } else {
      const admitted = await admitSessionMessage(this.pool, {
        userId: ownerUserId,
        daemonId: claimed.authorization.daemon_id,
        sessionId: claimed.nativeSessionId,
        requestId: claimed.providerRequestId,
        command: baseCommand,
        limit,
      })
      if (admitted.kind === 'conflict' || admitted.kind === 'forbidden') {
        const reason = admitted.kind === 'conflict' ? 'admission_conflict' : admitted.reason ?? 'session_not_found'
        await this.contextDelivery.stop(callId, 'failed', reason)
        await this.repository.stop(callId, 'blocked', reason)
        return
      }
      const decision = admitted.kind === 'resume' ? admitted.decision : {
        allowed: true as const,
        reservationId: admitted.admission.id,
        expiresAt: admitted.admission.expiresAt.getTime(),
        reused: admitted.reused,
      }
      if (!decision.allowed) {
        await this.contextDelivery.stop(callId, 'failed', decision.reason)
        await this.repository.stop(callId, 'blocked', decision.reason)
        return
      }
      reservationId = decision.reservationId
      expiresAt = decision.expiresAt
      reused = decision.reused
    }
    await this.repository.attachReservation(callId, reservationId)
    if (reused) {
      await this.contextDelivery.stop(callId, 'uncertain', 'request_already_admitted')
      await this.repository.stop(callId, 'uncertain', 'request_already_admitted')
      return
    }
    const command = {
      ...baseCommand,
      quota_grant: {
        reservation_id: reservationId ?? `unlimited-${claimed.providerRequestId}`,
        expires_at: expiresAt ?? Date.now() + 20_000,
        operation,
      },
    }
    const sent = this.transport.send({
      daemonId: claimed.authorization.daemon_id,
      ownerUserId,
      capability: 'team_collaboration_dispatch_v1',
      command,
    })
    if (!sent) {
      await this.settleNotSent(claimed, reservationId, operation)
      await this.contextDelivery.stop(callId, 'failed', 'daemon_unavailable')
      await this.repository.stop(callId, 'blocked', 'daemon_unavailable')
      return
    }
    await this.contextDelivery.markDispatched(callId)
    const timer = setTimeout(() => {
      this.receiptTimers.delete(claimed.callId)
      void this.markTimedOut(claimed, reservationId, operation)
    }, this.timeoutMs)
    timer.unref?.()
    this.receiptTimers.set(claimed.callId, timer)
  }

  private async settleNotSent(claimed: ClaimedDispatch, reservationId: string | null, operation: QuotaOperation): Promise<void> {
    if (!reservationId) return
    const binding = {
      reservationId,
      userId: claimed.authorization.owner_user_id,
      daemonId: claimed.authorization.daemon_id,
      requestId: claimed.providerRequestId,
      operation,
      sessionId: claimed.nativeSessionId,
    }
    const admission = claimed.nativeSessionId
      ? await recoverContinueAdmission(this.pool, {
        userId: binding.userId, daemonId: binding.daemonId, sessionId: claimed.nativeSessionId, requestId: binding.requestId,
      }, claimed.callId, 'rejected')
      : null
    if (admission) {
      await claimContinueAdmissionOutcome(this.pool, admission, 'rejected')
      await completeContinueAdmission(this.pool, admission, 'rejected')
    } else if (operation === 'create') {
      await settleQuotaReservation(this.pool, { ...binding, sessionId: null }, 'session_create_failed')
    } else {
      await settleQuotaReservation(this.pool, binding, 'session_active')
    }
  }

  private async markTimedOut(claimed: ClaimedDispatch, reservationId: string | null, operation: QuotaOperation): Promise<void> {
    await this.repository.stop(claimed.callId, 'uncertain', 'dispatch_timeout')
    await this.contextDelivery.stop(claimed.callId, 'uncertain', 'dispatch_timeout')
    if (!reservationId) return
    await markQuotaReservationUncertain(this.pool, {
      reservationId,
      userId: claimed.authorization.owner_user_id,
      daemonId: claimed.authorization.daemon_id,
      requestId: claimed.providerRequestId,
      operation,
      sessionId: claimed.nativeSessionId,
    }, 'grant_timeout').catch(() => {})
  }

  async handleDaemonEvent(daemonId: string, ownerUserId: number, message: Record<string, unknown>): Promise<void> {
    const projected = await this.repository.projectDaemonEvent(daemonId, ownerUserId, message)
    if (projected) {
      if (projected.event.call_id) this.clearReceiptTimer(projected.event.call_id)
      this.notifier.event?.(projected.event.team_session_id, projected.participantUserIds, projected.event)
      return
    }
    const authorization = message.collaboration as DispatchAuthorization | undefined
    if (!authorization || authorization.protocol_version !== 1 || authorization.daemon_id !== daemonId
      || authorization.owner_user_id !== ownerUserId || typeof authorization.call_id !== 'string') return
    const accounting = await this.repository.callAccounting(authorization.call_id)
    if (!dispatchAuthorizationMatches(accounting, authorization, daemonId, ownerUserId)) return

    const nativeSessionId = typeof message.session_id === 'string' ? message.session_id : ''
    if (message.type === 'session_created' && nativeSessionId && authorization.operation === 'create') {
      if (!await this.repository.bindNativeSession(authorization.call_id, daemonId, ownerUserId, nativeSessionId)) return
      await this.settleCreatedSession(accounting, nativeSessionId)
      return
    }
    if (message.type === 'collaboration_context_receipt') {
      const teamContext = message.team_context as Record<string, unknown> | undefined
      if (!teamContext) return
      await this.contextDelivery.recordReceipt({
        callId: authorization.call_id, daemonId, ownerUserId,
        contextVersion: Number(teamContext.context_version), contentHash: String(teamContext.content_hash ?? ''),
        payloadHash: String(teamContext.payload_hash ?? ''), accepted: message.status === 'accepted',
        outcome: typeof message.reason === 'string' ? message.reason : null,
      })
      return
    }
    if (message.type !== 'collaboration_dispatch_receipt') return
    this.clearReceiptTimer(authorization.call_id)
    const status = message.status === 'accepted' ? 'accepted' : 'rejected'
    const reason = typeof message.reason === 'string' ? message.reason : null
    if (nativeSessionId && authorization.operation === 'create') {
      await this.repository.bindNativeSession(authorization.call_id, daemonId, ownerUserId, nativeSessionId)
    }
    if (!await this.repository.recordReceipt(authorization.call_id, daemonId, ownerUserId, status, reason)) return
    if (status === 'accepted' && authorization.operation === 'message' && nativeSessionId) {
      await this.settleAcceptedMessage(accounting, nativeSessionId)
    }
  }

  private clearReceiptTimer(callId: string): void {
    const timer = this.receiptTimers.get(callId)
    if (timer) clearTimeout(timer)
    this.receiptTimers.delete(callId)
  }

  observeDaemonEvent(daemonId: string, ownerUserId: number, message: Record<string, unknown>): void {
    const previous = this.daemonEventChains.get(daemonId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.handleDaemonEvent(daemonId, ownerUserId, message))
    this.daemonEventChains.set(daemonId, current)
    void current.catch(error => console.error('[team-dispatch] daemon event failed', { daemonId, error })).finally(() => {
      if (this.daemonEventChains.get(daemonId) === current) this.daemonEventChains.delete(daemonId)
    })
  }

  private async settleCreatedSession(accounting: any, nativeSessionId: string): Promise<void> {
    if (!accounting.quota_reservation_id) return
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await settleQuotaReservation(this.pool, {
        reservationId: String(accounting.quota_reservation_id), userId: Number(accounting.owner_user_id),
        daemonId: accounting.daemon_id, requestId: accounting.provider_request_id,
        operation: 'create', sessionId: nativeSessionId,
      }, 'session_created')
      if (result.matched) return
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
    await this.repository.stop(accounting.call_id, 'uncertain', 'create_accounting_pending')
  }

  private async settleAcceptedMessage(accounting: any, nativeSessionId: string): Promise<void> {
    if (!accounting.quota_reservation_id) return
    const admission = await recoverContinueAdmission(this.pool, {
      userId: Number(accounting.owner_user_id), daemonId: accounting.daemon_id,
      sessionId: nativeSessionId, requestId: accounting.provider_request_id,
    }, accounting.call_id, 'accepted')
    if (admission) {
      await claimContinueAdmissionOutcome(this.pool, admission, 'accepted')
      await completeContinueAdmission(this.pool, admission, 'accepted')
      return
    }
    await settleQuotaReservation(this.pool, {
      reservationId: String(accounting.quota_reservation_id), userId: Number(accounting.owner_user_id),
      daemonId: accounting.daemon_id, requestId: accounting.provider_request_id,
      operation: 'resume', sessionId: nativeSessionId,
    }, 'session_active')
  }

  async handleDaemonDisconnected(daemonId: string): Promise<void> {
    await Promise.all([
      this.repository.markDaemonUncertain(daemonId),
      this.contextDelivery.markDaemonUncertain(daemonId),
    ])
  }
}
