import { recoverContinueAdmission, completeContinueAdmission, claimContinueAdmissionOutcome, AdmissionSessionMovedError, mutateContinueAdmissionSession } from '../session-message-admissions.js'
import { createHash } from 'crypto'
import type pg from 'pg'
import * as db from '../db.js'
import { normalizeSessionId } from '../ingress/event-policy.js'
import {
  approvalPush,
  highRiskPush,
  interactivePush,
  isHighRiskCommand,
  questionPush,
  sessionStatusPush,
  summarizeToolInput,
} from '../push.js'
import { notifyUser } from '../push.js'
import {
  claimQuotaReservationSession,
  recoverQuotaReservation,
  QuotaReservationBindingError,
  settleQuotaReservation,
  type QuotaOperation,
  type QuotaReservationBinding,
} from '../quota.js'
import { tokenUsageFeatures } from '../config/token-usage.js'
import {
  createExtensionJournalSinkFromEnv,
  extensionJournalEligibility,
  ExtensionJournalOwnerMissingError,
  type ExtensionJournalSink,
} from '../extensions/journal.js'
import type {
  DurableMaterializationHooks,
  DurableEffectContext,
  MaterializedAudience,
  MaterializedDelivery,
  MaterializationHooks,
  MaterializationInput,
  MaterializationResult,
  PendingOperationIdentity,
} from './types.js'
import { resolveSessionActivityAt } from './session-activity-policy.js'
import { isObserverAgentType } from '../session-observer-policy.js'

const subagentTurnStatuses = new Set([
  'running', 'interrupt_requested', 'completed', 'interrupted', 'failed', 'abandoned',
])

export type MaterializationEffect = (effect: DurableEffectContext) => Promise<void> | void

export interface EventMaterializerOptions {
  pool: pg.Pool
  effectPool?: pg.Pool
  transactionClient?: Pick<pg.PoolClient, 'query'>
  durableHooks?: DurableMaterializationHooks
  hooks?: MaterializationHooks
  /** Staged-rollout gate; production defaults to TOKEN_USAGE_FACTS_WRITE=false. */
  writeTokenUsageFacts?: boolean
  /**
   * Pool used by deferred effect closures. When materialization runs inside
   * the session fence the scoped pool is the fence's PoolClient, which is
   * released before deferred effects execute; those closures must run on the
   * caller's original pools instead.
   */
  deferredPool?: pg.Pool
  /** Post-fence pool for deferred business-effect statements. */
  deferredEffectPool?: pg.Pool
  /**
   * ADR-0003 Source Journal sink. When present, every ownable canonical
   * event appends exactly one journal row on the same transaction client as
   * the events insert — a journal failure rolls the canonical write back.
   * Undefined resolves from RELAY_EXTENSIONS (off → no sink).
   */
  extensionJournalSink?: ExtensionJournalSink | null
}

export interface MaterializationRunOptions {
  deferEffects?: boolean
  assertClaim?: () => Promise<void>
}

export class MaterializationContextError extends Error {
  constructor() {
    super('required materialization context unavailable')
    this.name = 'MaterializationContextError'
  }
}

export class EphemeralMaterializationError extends Error {
  constructor() {
    super('ephemeral event must bypass durable materialization')
    this.name = 'EphemeralMaterializationError'
  }
}

export function createDatabaseMaterializationHooks(pool: pg.Pool): DurableMaterializationHooks {
  return {
    claimQuotaReservationSession: async (binding) => {
      const result = await claimQuotaReservationSession(pool, binding)
      if (!result.matched) throw new QuotaReservationBindingError()
    },
    settleQuotaReservation: async (binding, reason) => {
      const result = await settleQuotaReservation(pool, binding, reason)
      if (!result.matched) throw new QuotaReservationBindingError()
    },
    notifyUser: (userId, payload) => notifyUser(pool, userId, payload as never),
    notifyProUser: async (userId, payload) => {
      const { plan, whitelist } = await db.getUserPlanAndWhitelist(pool, userId)
      if (!whitelist && plan === 'free') return
      await notifyUser(pool, userId, payload as never)
    },
  }
}

/**
 * The durable event ledger is intentionally owned here rather than by an
 * ingress transport.  Router's legacy path and a future inbox worker therefore
 * share exactly the same crash-resume and deduplication contract.
 */
export class EventMaterializer {
  private readonly options: EventMaterializerOptions
  private readonly durableHooks: DurableMaterializationHooks
  private readonly writeTokenUsageFacts: boolean
  private readonly extensionJournalSink: ExtensionJournalSink | null

  constructor(options: EventMaterializerOptions) {
    this.options = options
    this.durableHooks = options.durableHooks ?? createDatabaseMaterializationHooks(options.effectPool ?? options.pool)
    this.writeTokenUsageFacts = options.writeTokenUsageFacts ?? tokenUsageFeatures().writeFacts
    this.extensionJournalSink = options.extensionJournalSink !== undefined
      ? options.extensionJournalSink
      : createExtensionJournalSinkFromEnv()
  }

  private get effectPool(): pg.Pool {
    return this.options.effectPool ?? this.options.pool
  }

  private quotaOutcome(input: MaterializationInput): {
    operation: QuotaOperation
    reason: 'session_created' | 'session_create_failed' | 'session_active'
  } | null {
    if (input.eventType === 'session_created') return { operation: 'create', reason: 'session_created' }
    if (input.eventType === 'session_create_failed') {
      return { operation: 'create', reason: 'session_create_failed' }
    }
    if (input.eventType !== 'session_status') return null
    const status = typeof input.payload.status === 'string' ? input.payload.status : ''
    return ['running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(status)
      ? { operation: 'resume', reason: 'session_active' }
      : null
  }

  private async recoverQuotaContext(input: MaterializationInput): Promise<MaterializationInput> {
    if (input.eventType === 'user_message_receipt' && input.userId !== null && input.sessionId
      && typeof input.payload.request_id === 'string'
      && ['accepted','rejected'].includes(String(input.payload.status))) {
      const admission = await recoverContinueAdmission(this.options.pool, {
        userId: input.userId, daemonId: input.daemonId, sessionId: input.sessionId,
        requestId: input.payload.request_id,
      }, typeof input.payload.msg_id === 'string' ? input.payload.msg_id : null, input.payload.status as 'accepted' | 'rejected')
      if (admission) return { ...input, sessionId: admission.canonicalSessionId ?? admission.sessionId,
        payload: {...input.payload,session_id:admission.canonicalSessionId ?? admission.sessionId}, context: { ...input.context, admission,
        requestId: admission.requestId, reservationId: null, quotaOperation: undefined } }
      return input
    }
    const outcome = this.quotaOutcome(input)
    if (!outcome) return input
    // This recovery runs before materializeUnlocked(), which owns the fenced
    // tombstone check. Reject a deleted session here as well so a stale quota
    // binding cannot mask the permanent unknown-session outcome. The fenced
    // check remains the authoritative TOCTOU guard before persistence.
    if (input.sessionId && await db.isSessionDeleted(this.effectPool, input.sessionId)) {
      throw new db.UnknownDaemonSessionError()
    }
    const requestId = typeof input.context?.requestId === 'string' && input.context.requestId
      ? input.context.requestId
      : typeof input.payload.request_id === 'string' && input.payload.request_id
        ? input.payload.request_id
        : null
    const strictLifecycleOutcome = input.eventType === 'session_created'
      || input.eventType === 'session_create_failed'
      || (input.eventType === 'session_status' && requestId !== null)
    if (input.userId === null || !requestId) {
      if (strictLifecycleOutcome) throw new QuotaReservationBindingError()
      return input
    }
    const recovered = await recoverQuotaReservation(this.options.pool, {
      userId: input.userId,
      daemonId: input.daemonId,
      requestId,
      operation: outcome.operation,
      sessionId: outcome.operation === 'resume' || input.eventType === 'session_created'
        ? input.sessionId
        : null,
    }, outcome.reason)
    // Persisted ingress context is an acceptable fast path only when it already
    // contains the complete server-issued tuple. The first durable transition
    // still revalidates it. A daemon payload alone is never authority to create
    // a session, deliver a failure, or close a resume reservation.
    if (!recovered) {
      if (input.eventType === 'session_status' && input.sessionId) {
        const admission = await recoverContinueAdmission(this.options.pool, {
          userId: input.userId, daemonId: input.daemonId, sessionId: input.sessionId, requestId,
        })
        if (admission) return { ...input, sessionId: admission.canonicalSessionId ?? admission.sessionId,
        payload: {...input.payload,session_id:admission.canonicalSessionId ?? admission.sessionId}, context: { ...input.context, requestId,
          admission, reservationId: null, quotaOperation: undefined } }
      }
      const context = input.context
      const sessionMatches = outcome.operation === 'create'
        ? input.eventType === 'session_create_failed' || Boolean(input.sessionId)
        : Boolean(input.sessionId)
      if (context?.reservationId && context.requestId === requestId
        && context.quotaOperation === outcome.operation && sessionMatches) {
        return input
      }
      throw new QuotaReservationBindingError()
    }
    return {
      ...input,
      context: {
        ...input.context,
        requestId: recovered.binding.requestId,
        reservationId: recovered.binding.reservationId,
        quotaOperation: recovered.binding.operation,
        agentType: recovered.agentType || input.context?.agentType || 'unknown',
        cwd: recovered.cwd ?? input.context?.cwd ?? '',
        hostname: recovered.hostname,
      },
    }
  }

  /**
   * Events without a canonical session still need a bounded, server-derived
   * effect-ledger namespace. The event hash contributes type + request id;
   * this prefix contributes authenticated tenant + registered daemon.
   */
  private ledgerSessionId(input: MaterializationInput): string {
    if (input.eventType !== 'session_create_failed') return input.sessionId ?? ''
    const namespace = createHash('sha256')
      .update(JSON.stringify([input.userId ?? 0, input.daemonId]))
      .digest('hex')
      .slice(0, 48)
    return `quota-failure:${namespace}`
  }

  private pendingOperationIdentity(input: MaterializationInput): PendingOperationIdentity | null {
    const context = input.context
    if (input.userId === null || !context?.requestId || !context.quotaOperation) return null
    if (!input.sessionId
      && !(input.eventType === 'session_create_failed' && context.quotaOperation === 'create')) return null
    return {
      reservationId: context.reservationId ?? null,
      userId: input.userId,
      daemonId: input.daemonId,
      requestId: context.requestId,
      operation: context.quotaOperation,
      sessionId: input.sessionId || null,
    }
  }

  private quotaReservationBinding(input: MaterializationInput): QuotaReservationBinding | null {
    const identity = this.pendingOperationIdentity(input)
    if (!identity?.reservationId) return null
    return { ...identity, reservationId: identity.reservationId }
  }

  private delivery(
    input: MaterializationInput,
    eventId: number | null,
    audience: MaterializedAudience = 'session',
    payload: Record<string, unknown> = input.payload,
    ordinal = 0,
  ): MaterializedDelivery {
    const requestId = typeof payload.request_id === 'string' && payload.request_id
      ? payload.request_id
      : null
    return {
      inboxId: input.inboxId,
      daemonId: input.daemonId,
      eventId,
      userId: input.userId,
      audience,
      sessionId: input.sessionId,
      requestId,
      ordinal,
      deliveryKey: `${eventId === null ? `inbox:${input.inboxId}` : `event:${eventId}`}:${audience}:${requestId ?? '-'}:${ordinal}`,
      type: typeof payload.type === 'string' ? payload.type : input.eventType,
      payload,
    }
  }

  private deliveryPayload(input: MaterializationInput): Record<string, unknown> {
    if (input.eventType === 'session_created') {
      const context = input.context ?? {}
      return {
        ...input.payload,
        request_id: context.requestId ?? input.payload.request_id,
        reservation_id: context.reservationId ?? undefined,
        daemon_id: input.daemonId,
        hostname: context.hostname ?? 'unknown',
      }
    }
    if (input.eventType === 'session_create_failed') {
      const context = input.context ?? {}
      return {
        ...input.payload,
        request_id: context.requestId ?? input.payload.request_id,
        reservation_id: context.reservationId ?? undefined,
        daemon_id: input.daemonId,
      }
    }
    if (input.eventType === 'session_discovered') {
      return {
        ...input.payload,
        daemon_id: input.daemonId,
        hostname: input.context?.hostname ?? 'unknown',
      }
    }
    return input.payload
  }

  private async normalizeObserverPolicy(input: MaterializationInput): Promise<MaterializationInput> {
    let observer = input.eventType === 'session_discovered'
      && isObserverAgentType(input.payload.agent)
    if (!observer && input.eventType === 'session_meta'
      && input.sessionId && input.userId !== null) {
      const policy = await db.getSessionRuntimePolicy(
        this.options.pool, input.sessionId, input.userId,
      )
      observer = isObserverAgentType(policy?.agentType)
    }
    if (!observer) return input
    return {
      ...input,
      payload: {
        ...input.payload,
        ...(input.eventType === 'session_discovered' ? { source: 'observer' } : {}),
        control_mode: 'legacy_read_only',
        capabilities: ['history_sync'],
      },
    }
  }

  private async upsertDiscoveredSession(
    input: MaterializationInput,
    bindSession: boolean,
  ): Promise<void> {
    const payload = input.payload
    const sessionId = input.sessionId ?? ''
    const agentType = typeof payload.agent === 'string' ? payload.agent : 'claude-code'
    const observer = isObserverAgentType(agentType)
    // Agent identity is the server-recognized discriminator. Payload claims
    // can never promote an observer to a managed/write-capable session (or
    // let another agent forge observer identity).
    const source = observer ? 'observer' : 'terminal'
    const controlMode = observer
      ? 'legacy_read_only'
      : typeof payload.control_mode === 'string' ? payload.control_mode : undefined
    const capabilities = observer
      ? ['history_sync']
      : Array.isArray(payload.capabilities) ? payload.capabilities as string[] : undefined
    await db.upsertSession(
      this.effectPool, sessionId, input.daemonId,
      agentType,
      typeof payload.cwd === 'string' ? payload.cwd : '',
      typeof payload.status === 'string' ? payload.status : 'busy',
      typeof payload.title === 'string' && payload.title ? payload.title : undefined,
      source, undefined, input.userId ?? undefined,
      typeof payload.model === 'string' ? payload.model : undefined,
      controlMode,
      capabilities,
    )
    if (agentType === 'codex-desktop' && input.userId !== null) {
      await db.reclassifyCodexDesktopTokenUsageFacts(
        this.effectPool, sessionId, input.userId,
      )
    }
    if (bindSession) this.options.hooks?.bindSession?.(sessionId, input.daemonId)
  }

  private async materializeNonEvent(input: MaterializationInput): Promise<MaterializationResult | null> {
    if (input.eventType === 'session_discovered'
      && await db.isSessionDeleted(this.effectPool, input.sessionId ?? '')) {
      return { eventId: null, inserted: false, completed: true, deliveries: [] }
    }
    if (input.eventType === 'interaction_result'
      || (input.eventType === 'error'
        && ['approval_response', 'question_response', 'question_reject'].includes(String(input.payload.operation ?? '')))) {
      return {
        eventId: null,
        inserted: false,
        completed: true,
        deliveries: [this.delivery(input, null, 'interaction-origin')],
      }
    }
    if (input.eventType === 'subagent_usage') {
      const usage = input.payload.usage as db.TokenUsageDelta | undefined
      const agentId = typeof input.payload.agent_id === 'string' ? input.payload.agent_id : ''
      if (agentId && usage) {
        const recordUsage = this.options.transactionClient
          ? db.recordSubagentUsageInTransaction.bind(null, this.options.transactionClient)
          : db.recordSubagentUsage.bind(null, this.options.pool)
        await recordUsage({
          daemonId: input.daemonId,
          seq: typeof input.payload.seq === 'number' ? input.payload.seq : undefined,
          eventId: typeof input.payload.event_id === 'string' ? input.payload.event_id : '',
          parentSessionId: input.sessionId ?? '',
          agentId,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheRead: usage.cache_read_tokens || 0,
          cacheCreate: usage.cache_create_tokens || 0,
        })
      }
      return { eventId: null, inserted: false, completed: true, deliveries: [] }
    }
    return null
  }

  private deliveryAudience(input: MaterializationInput): MaterializedAudience {
    return ['session_created', 'session_create_failed', 'session_discovered', 'session_model_changed'].includes(input.eventType)
      ? 'user'
      : 'session'
  }

  private async materializeSessionLifecycle(
    input: MaterializationInput,
    result: MaterializationResult,
    effect: DurableEffectContext,
    options: {
      observerPolicyPrefix?: boolean
      observerPolicyApplied?: boolean
      bindObserverSession?: boolean
    } = {},
  ): Promise<boolean> {
    let sessionId = input.sessionId ?? ''
    const payload = input.payload
    if (input.eventType === 'session_create_failed') {
      const identity = this.pendingOperationIdentity(input)
      const binding = this.quotaReservationBinding(input)
      if (binding?.operation === 'create') {
        await effect.step(() => this.durableHooks.settleQuotaReservation(binding, 'session_create_failed'))
      }
      if (identity?.operation === 'create') {
        await effect.step(() => this.options.hooks?.releasePendingOperation?.(identity))
      }
      return true
    }
    if (input.eventType === 'session_id_changed') {
      const oldSessionId = normalizeSessionId(payload.old_session_id) ?? ''
      await effect.step(async () => {
        if (!oldSessionId) {
          // No (or non-canonical) old identity: only establish the new one
          // under the guarded identity upsert.
          await db.ensureDaemonSessionIdentity(this.effectPool, sessionId, input.daemonId, input.userId ?? undefined)
          this.options.hooks?.bindSession?.(sessionId, input.daemonId)
          return
        }
        // renameOwnedDaemonSession validates old ownership and new-id
        // availability atomically; hooks run only after that success.
        await db.renameOwnedDaemonSession(this.effectPool, {
          oldSessionId,
          newSessionId: sessionId,
          daemonId: input.daemonId,
          userId: input.userId,
        })
        this.options.hooks?.bindSession?.(sessionId, input.daemonId)
        this.options.hooks?.renameSession?.(oldSessionId, sessionId, input.daemonId)
      })
      return true
    }
    if (input.eventType === 'session_created') {
      const context = input.context
      if (!context?.hostname || context.agentType === undefined || context.cwd === undefined
        || (input.inboxId > 0 && context.agentType === '')) {
        throw new MaterializationContextError()
      }
      const identity = this.pendingOperationIdentity(input)
      const binding = this.quotaReservationBinding(input)
      if (binding?.operation === 'create') {
        await effect.step(() => this.durableHooks.claimQuotaReservationSession(binding))
      }
      await effect.step(async () => {
        await db.upsertSession(
          this.effectPool, sessionId, input.daemonId,
          context.agentType || '', context.cwd || '', 'running',
          typeof payload.title === 'string' && payload.title ? payload.title : undefined,
          'daemon', undefined, input.userId ?? undefined,
          typeof payload.model === 'string' ? payload.model : undefined,
          typeof payload.control_mode === 'string' ? payload.control_mode : undefined,
          Array.isArray(payload.capabilities) ? payload.capabilities as string[] : undefined,
        )
        this.options.hooks?.bindSession?.(sessionId, input.daemonId)
      })
      await effect.assertActive()
      this.options.hooks?.prepareSessionCreated?.(
        sessionId,
        input.daemonId,
        context.requestId ?? null,
      )
      if (binding?.operation === 'create') {
        await effect.step(() => this.durableHooks.settleQuotaReservation(binding, 'session_created'))
      }
      if (identity?.operation === 'create') {
        await effect.step(() => this.options.hooks?.releasePendingOperation?.(identity))
      }
      await effect.assertActive()
      this.options.hooks?.clearPendingSession?.(input.daemonId)
      return true
    }
    if (input.eventType === 'session_discovered') {
      if (!options.observerPolicyApplied) {
        await effect.step(() => this.upsertDiscoveredSession(
          input,
          options.observerPolicyPrefix !== true || options.bindObserverSession === true,
        ))
      }
      if (options.observerPolicyPrefix) return true
      if (input.userId !== null) {
        await effect.step(() => this.options.hooks?.broadcastQuota?.(input.userId!))
      }
      return true
    }
    if (input.eventType === 'session_model_changed') {
      await effect.step(async () => {
        await db.updateSessionModel(this.effectPool, sessionId, String(payload.model ?? ''))
        this.options.hooks?.bindSession?.(sessionId, input.daemonId)
      })
      return true
    }
    if (input.eventType === 'session_agent_changed') {
      await effect.step(() => db.updateSessionActiveAgent(
        this.effectPool, sessionId, String(payload.current_agent ?? ''),
      ))
      return true
    }
    if (input.eventType === 'session_meta') {
      if (typeof payload.control_mode === 'string' && Array.isArray(payload.capabilities)) {
        await effect.step(() => db.updateSessionControl(
          this.effectPool, sessionId, payload.control_mode as string, payload.capabilities as string[],
        ))
      }
      return true
    }
    if (input.eventType !== 'session_status') return false

    await effect.assertActive()
    await effect.atomicStep(async (eventID, nextStep) => {
      const updateStatus = (pool: pg.Pool, canonicalSessionId: string) => db.updateSessionStatusForEvent(
        pool,
        eventID,
        nextStep,
        canonicalSessionId,
        input.daemonId,
        typeof payload.status === 'string' ? payload.status : 'unknown',
        typeof payload.exit_reason === 'string' ? payload.exit_reason : undefined,
        input.userId ?? undefined,
        typeof payload.turn_started_at === 'string' ? payload.turn_started_at : undefined,
      )
      const mutation = input.context?.admission
        ? await mutateContinueAdmissionSession(this.effectPool, input.context.admission, updateStatus)
        : { sessionId, value: await updateStatus(this.effectPool, sessionId) }
      const outcome = mutation.value
      if (mutation.sessionId !== sessionId) {
        sessionId = mutation.sessionId
        input.sessionId = sessionId
        payload.session_id = sessionId
        result.deliveries = result.deliveries.map(delivery => ({ ...delivery, sessionId,
          payload: { ...delivery.payload, session_id: sessionId } }))
      }
      if (outcome.suppressed) result.deliveries = []
      else this.options.hooks?.bindSession?.(sessionId, input.daemonId)
    })
    if (result.deliveries.length === 0) return true
    if (payload.cost_usd != null) {
      await effect.step(() => db.updateSessionCost(this.effectPool, sessionId, Number(payload.cost_usd)))
    }
    const status = typeof payload.status === 'string' ? payload.status : 'unknown'
    if (['running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(status)) {
      const identity = this.pendingOperationIdentity(input)
      const binding = this.quotaReservationBinding(input)
      if (binding?.operation === 'resume') {
        await effect.step(() => this.durableHooks.settleQuotaReservation(binding, 'session_active'))
      }
      if (identity?.operation === 'resume') {
        await effect.step(() => this.options.hooks?.releasePendingOperation?.(identity))
      }
    }
    if (input.userId !== null) {
      await effect.step(() => this.options.hooks?.broadcastQuota?.(input.userId!))
    }
    if (input.userId !== null && ['completed', 'error', 'killed', 'exited'].includes(status)) {
      await effect.step(() => this.durableHooks.notifyUser(
        input.userId!,
        sessionStatusPush(String(payload.title ?? ''), status, sessionId),
      ))
    }
    return true
  }

  private async materializeInteraction(
    input: MaterializationInput,
    eventId: number | null,
    effect: DurableEffectContext,
  ): Promise<boolean> {
    if (!['approval_request', 'interactive_prompt', 'question_request'].includes(input.eventType)) return false
    if (input.userId === null) return true
    const payload = input.payload
    const sessionId = input.sessionId ?? ''
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''
    const shouldPush = input.inboxId > 0 && requestId && eventId !== null
      ? await db.claimRequestPushEffect(this.effectPool, input.userId, requestId, eventId)
      : effect.resuming || !requestId || (this.options.hooks?.shouldPush?.(requestId) ?? true)
    if (!shouldPush) return true
    try {
      if (input.eventType === 'approval_request') {
        const tool = String(payload.tool ?? '')
        const summary = summarizeToolInput(tool, payload.input)
        await effect.step(() => this.durableHooks.notifyUser(
          input.userId!,
          approvalPush(String(payload.title ?? ''), tool, summary, sessionId, requestId),
        ))
        if (isHighRiskCommand(tool, summary)) {
          await effect.step(() => this.durableHooks.notifyProUser(
            input.userId!,
            highRiskPush(String(payload.title ?? ''), tool, summary, sessionId, requestId),
          ))
        }
      } else if (input.eventType === 'interactive_prompt') {
        const inputPayload = payload.input as Record<string, unknown> | undefined
        await effect.step(() => this.durableHooks.notifyUser(
          input.userId!,
          interactivePush(String(payload.title ?? ''), String(inputPayload?.prompt ?? ''), sessionId, requestId),
        ))
      } else {
        const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : []
        const first = questions[0]
        await effect.step(() => this.durableHooks.notifyUser(
          input.userId!,
          questionPush(String(first?.question ?? first?.header ?? ''), sessionId, requestId),
        ))
      }
    } catch (error) {
      if (requestId) this.options.hooks?.forgetPush?.(requestId)
      throw error
    }
    return true
  }

  private async materializeSubagent(
    input: MaterializationInput,
    effect: DurableEffectContext,
  ): Promise<boolean> {
    const payload = input.payload
    const sessionId = input.sessionId ?? ''
    if (input.eventType === 'turn_status') {
      const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : ''
      const status = typeof payload.turn_status === 'string' ? payload.turn_status : ''
      if (!sessionId || !agentId || !subagentTurnStatuses.has(status)) return false
      await effect.step(() => db.upsertSubagentStatus(
        this.options.transactionClient ?? this.effectPool,
        sessionId,
        agentId,
        status,
      ))
      return true
    }
    if (input.eventType !== 'subagent_discovered') return false
    await effect.step(async () => {
      const relation = {
        parentSessionId: sessionId,
        agentId: String(payload.agent_id ?? ''),
        rootSessionId: String(payload.root_session_id ?? sessionId),
        kind: payload.subagent_kind === 'sdk_session' ? 'sdk_session'
            : payload.agent === 'codex' ? 'codex_subagent'
            : payload.agent === 'zcode' ? 'zcode_subagent'
            : 'claude_subagent',
        toolUseId: typeof payload.call_id === 'string' ? payload.call_id : undefined,
        agentType: typeof payload.subagent_type === 'string' ? payload.subagent_type : undefined,
        title: typeof payload.subagent_desc === 'string' ? payload.subagent_desc : undefined,
      }
      if (this.options.transactionClient) {
        await db.reconcileSubagentInTransaction(this.options.transactionClient, relation)
      } else {
        await db.reconcileSubagent(this.effectPool, relation)
      }
      this.options.hooks?.bindSession?.(sessionId, input.daemonId)
    })
    return true
  }

  private async materializeGenericEvent(
    input: MaterializationInput,
    effect: DurableEffectContext,
  ): Promise<void> {
    if (input.payload.reason !== 'resolved_elsewhere') {
      await effect.assertActive()
      if (input.eventType === 'approval_resolved') {
        this.options.hooks?.clearInteractionOrigin?.(
          input.sessionId ?? '', String(input.payload.request_id ?? ''), 'approval_response',
        )
      } else if (input.eventType === 'question_resolved') {
        this.options.hooks?.clearInteractionOrigin?.(
          input.sessionId ?? '', String(input.payload.request_id ?? ''),
          input.payload.rejected ? 'question_reject' : 'question_response',
        )
      }
    }
  }

  private businessEffect(
    input: MaterializationInput,
    result: MaterializationResult,
    scope: 'all' | 'observer_policy_prefix' = 'all',
  ): MaterializationEffect {
    return async (effect) => {
      // Activity is appended after every event's existing effects so durable
      // effect-step ordinals remain compatible with rows created by older relays.
      const materializeActivity = async () => {
        const activityAt = resolveSessionActivityAt(input)
        if (activityAt && input.sessionId) {
          const writeActivity = input.eventType === 'session_discovered'
            ? db.restoreSessionActivity
            : db.advanceSessionActivity
          await effect.step(() => writeActivity(this.effectPool, input.sessionId!, activityAt))
        }
        // New effects append after all legacy effects, including activity.
        if (input.context?.admission) {
          await effect.step(() => completeContinueAdmission(this.effectPool, input.context!.admission!,
            input.eventType === 'user_message_receipt' ? String(input.payload.status) as 'accepted' | 'rejected' : 'session_active'))
          if (input.eventType === 'user_message_receipt' && input.userId !== null) {
            await effect.step(() => this.options.hooks?.broadcastQuota?.(input.userId!))
          }
        }
      }
      // Preserve the legacy generic session accumulator for older payloads
      // carrying usage, while restricting immutable accounting facts to the
      // canonical agent_text event. subagent_usage is paired bookkeeping and
      // must trigger neither path, otherwise a child turn is counted twice.
      const usage = input.eventType === 'subagent_usage'
        ? undefined
        : input.payload.usage as db.TokenUsageDelta | undefined
      const factEligible = input.eventType === 'agent_text'
      const factKey = input.inboxId > 0 ? `inbox:${input.inboxId}` : undefined
      const observerDiscovery = input.eventType === 'session_discovered'
        && isObserverAgentType(input.payload.agent)
      // Keep observer policy at ordinal 0. This both creates a first-seen
      // session before usage accounting and preserves Fix Round 1's durable
      // meaning for pending rows already checkpointed at nextStep 1.
      if (observerDiscovery) {
        await this.materializeSessionLifecycle(input, result, effect, {
          observerPolicyPrefix: true,
          bindObserverSession: scope === 'all',
        })
      }
      if (usage != null && input.payload.is_subagent !== true) {
        await effect.atomicStep((eventID, nextStep) => db.incrementSessionTokensForEvent(
          this.effectPool,
          eventID,
          nextStep,
          input.sessionId ?? '',
          usage,
          { writeFact: this.writeTokenUsageFacts && factEligible, receivedAt: input.receivedAt, factKey },
        ))
      } else if (usage != null && input.payload.is_subagent === true
        && this.writeTokenUsageFacts && factEligible) {
        await effect.atomicStep((eventID, nextStep) => db.recordTokenUsageFactForEvent(
          this.effectPool,
          eventID,
          nextStep,
          {
            factKey: factKey ?? `event:${eventID}`,
            userId: input.userId,
            daemonId: input.daemonId,
            sessionId: input.sessionId ?? '',
            agentType: typeof input.payload.agent === 'string'
              ? input.payload.agent
              : input.context?.agentType,
            model: typeof input.payload.model === 'string' ? input.payload.model : undefined,
            receivedAt: input.receivedAt,
            usage,
          },
        ))
      }
      if (scope === 'observer_policy_prefix') {
        return
      }
      if (await this.materializeSessionLifecycle(input, result, effect, {
        observerPolicyApplied: observerDiscovery,
      })) {
        await materializeActivity()
        return
      }
      if (await this.materializeInteraction(input, result.eventId, effect)) {
        await materializeActivity()
        return
      }
      if (await this.materializeSubagent(input, effect)) {
        await materializeActivity()
        return
      }
      await this.materializeGenericEvent(input, effect)
      await materializeActivity()
    }
  }

  private createEffectContext(
    checkpointPool: pg.Pool,
    eventID: number,
    nextStep: number,
    assertClaim: () => Promise<void>,
  ): DurableEffectContext {
    let stepIndex = 0
    return {
      resuming: nextStep > 0,
      assertActive: assertClaim,
      step: async (stepEffect) => {
        const currentStep = stepIndex++
        if (currentStep < nextStep) return
        await assertClaim()
        await stepEffect()
        await assertClaim()
        await db.advanceEventEffectStep(checkpointPool, eventID, currentStep + 1)
      },
      atomicStep: async (stepEffect) => {
        const currentStep = stepIndex++
        if (currentStep < nextStep) return
        await assertClaim()
        await stepEffect(eventID, currentStep + 1)
      },
    }
  }

  /**
   * Cross-tenant authorization chokepoint: every daemon-provided session id
   * is untrusted and must prove ownership before canonical persistence, any
   * lifecycle mutation, accounting effect, push, or delivery construction.
   */
  private async authorizeDaemonSession(input: MaterializationInput): Promise<void> {
    if (!input.sessionId) return
    if (input.eventType === 'session_id_changed') {
      const oldSessionId = normalizeSessionId(input.payload.old_session_id)
      if (oldSessionId) {
        await db.assertDaemonSessionAccess(this.options.pool, {
          sessionId: oldSessionId,
          daemonId: input.daemonId,
          userId: input.userId,
          policy: 'must_exist',
        })
      }
      await db.assertDaemonSessionAccess(this.options.pool, {
        sessionId: input.sessionId,
        daemonId: input.daemonId,
        userId: input.userId,
        policy: 'allow_create',
      })
      return
    }
    const policy: db.DaemonSessionPolicy = ['session_created', 'session_discovered'].includes(input.eventType)
      ? 'allow_create'
      : input.eventType === 'session_status'
        ? 'allow_missing_status'
        : 'must_exist'
    await db.assertDaemonSessionAccess(this.options.pool, {
      sessionId: input.sessionId,
      daemonId: input.daemonId,
      userId: input.userId,
      policy,
    })
  }

  /**
   * ADR-0003 journal append. Runs on the scoped pool, which inside a fence is
   * the advisory-locked transaction client, so the source row commits with
   * the canonical events row or not at all. Dedup replays re-append through
   * ON CONFLICT DO NOTHING, repairing a journal row lost to an older crash
   * without duplicating feed identity.
   */
  private async appendExtensionJournal(
    input: MaterializationInput,
    eventId: number,
  ): Promise<void> {
    if (!this.extensionJournalSink) return
    const eligibility = extensionJournalEligibility({
      ownerUserId: input.userId,
      ledgerSessionId: this.ledgerSessionId(input),
      sessionId: input.sessionId,
    })
    if (!eligibility.journal) {
      // An ownable event without a server-derived owner is an authorization
      // defect: fail loudly instead of journaling unisolated content.
      if (eligibility.reason === 'skipped_no_owner') throw new ExtensionJournalOwnerMissingError()
      return
    }
    await this.extensionJournalSink.appendCanonicalEvent(
      this.options.pool as unknown as Pick<pg.PoolClient, 'query'>,
      {
        sourceEventId: eventId,
        ownerUserId: input.userId!,
        sessionId: this.ledgerSessionId(input),
        eventType: input.eventType,
        occurredAt: input.receivedAt ?? null,
        payload: input.payload,
      },
    )
  }

  private async materializeUnlocked(
    input: MaterializationInput,
    effect?: MaterializationEffect,
    options: MaterializationRunOptions = {},
  ): Promise<MaterializationResult> {
    if ([
      'generate_title_request',
      'generate_subagent_title_request',
      'session_title_update',
    ].includes(input.eventType)) {
      throw new EphemeralMaterializationError()
    }
    const assertClaim = options.assertClaim ?? (async () => undefined)
    if (input.sessionId
      && await db.isSessionDeleted(this.effectPool, input.sessionId)) {
      // Tombstones intentionally do not retain an owner identity. Treat every
      // daemon event for one as permanently unknown instead of persisting an
      // unauthorizable canonical event. The transport layer classifies this
      // error as permanent so ACK/dead-letter progress remains possible.
      throw new db.UnknownDaemonSessionError()
    }
    if (input.context?.admission) {
      await claimContinueAdmissionOutcome(this.options.pool,input.context.admission,
        input.eventType === 'user_message_receipt' ? input.payload.status as 'accepted' | 'rejected' : 'session_active')
    }
    await this.authorizeDaemonSession(input)
    input = await this.normalizeObserverPolicy(input)
    if ([
      'session_discovered',
      'interaction_result',
      'error',
      'subagent_usage',
    ].includes(input.eventType)) {
      const nonEvent = await this.materializeNonEvent(input)
      if (nonEvent) return nonEvent
    }
    const event = await db.persistEventWithEffect(
      this.options.pool,
      this.ledgerSessionId(input),
      input.eventType,
      input.payload,
      5,
      input.userId,
      input.context?.admission?.sessionId ?? this.ledgerSessionId(input),
    )
    await this.appendExtensionJournal(input, event.rowID)
    const result: MaterializationResult = {
      eventId: event.rowID,
      inserted: event.inserted,
      completed: event.completed,
      // Completed ledger rows still reconstruct the exact delivery. Task 9
      // needs this to repair an outbox write after a process crash.
      deliveries: [this.delivery(
        input,
        event.rowID,
        this.deliveryAudience(input),
        this.deliveryPayload(input),
      )],
    }
    if (options.deferEffects && !event.completed
      && input.eventType === 'session_discovered'
      && isObserverAgentType(input.payload.agent)) {
      // Router's legacy path defers ordinary effects until daemon seq ordering
      // catches up. Observer classification is authorization state, so commit
      // its ownership-guarded business-effect prefix with the canonical event
      // while this session's cross-process advisory transaction is still held.
      // Driving the real effect program preserves the established policy-first
      // ordinals and resumes from the ledger's recorded next step.
      await this.businessEffect(input, result, 'observer_policy_prefix')(
        this.createEffectContext(
          this.options.pool, event.rowID, event.nextStep, assertClaim,
        ),
      )
    }
    if (input.eventType === 'session_status'
      && event.nextStep >= db.SESSION_STATUS_SUPPRESSED_EFFECT_STEP) {
      result.deliveries = []
    }
    if (event.completed) return result

    if (options.deferEffects) {
      // Deferred effects run after the fence transaction commits, so neither
      // the ledger helpers nor the effect steps may touch the released
      // PoolClient. Rebuild the effect against the caller's original pool.
      const latePool = this.options.deferredPool ?? this.options.pool
      const lateEffectPool = this.options.deferredEffectPool ?? latePool
      const lateMaterializer = new EventMaterializer({
        pool: latePool,
        effectPool: lateEffectPool,
        durableHooks: this.options.durableHooks,
        hooks: this.options.hooks,
        writeTokenUsageFacts: this.writeTokenUsageFacts,
      })
      result.applyEffects = async (): Promise<void> => {
        const latest = await db.getEventEffectState(latePool, event.rowID)
        if (latest?.completed) return
        const nextStep = latest?.nextStep ?? event.nextStep
        // A trusted rename may commit while these effects are deferred.
        const currentInput = input.context?.admission ? await lateMaterializer.recoverQuotaContext(input) : input
        if (currentInput.sessionId !== input.sessionId) {
          result.deliveries = result.deliveries.map(delivery => ({...delivery,sessionId:currentInput.sessionId,
            payload:{...delivery.payload,session_id:currentInput.sessionId}}))
        }
        const lateEffect = effect ?? lateMaterializer.businessEffect(currentInput, result)
        await lateEffect(this.createEffectContext(
          latePool, event.rowID, nextStep, assertClaim,
        ))
      }
      result.finalizeEffect = async () => {
        await assertClaim()
        await db.completeEventEffect(latePool, event.rowID)
      }
      return result
    }

    const activeEffect = effect ?? this.businessEffect(input, result)

    const applyEffects = async (): Promise<void> => {
      const latest = await db.getEventEffectState(this.options.pool, event.rowID)
      if (latest?.completed) return
      const nextStep = latest?.nextStep ?? event.nextStep
      await activeEffect(this.createEffectContext(
        this.options.pool, event.rowID, nextStep, assertClaim,
      ))
    }
    const finalizeEffect = async () => {
      await assertClaim()
      await db.completeEventEffect(this.options.pool, event.rowID)
    }
    await applyEffects()
    await finalizeEffect()
    return result
  }

  async materialize(input: MaterializationInput, effect?: MaterializationEffect, options: MaterializationRunOptions = {}): Promise<MaterializationResult> {
    for (let attempt=0; attempt<3; attempt++) {
      try { return await this.materializeAttempt(input,effect,options) }
      catch (error) { if (!(error instanceof AdmissionSessionMovedError) || attempt === 2) throw error }
    }
    throw new AdmissionSessionMovedError('session identity did not stabilize')
  }

  private async materializeAttempt(
    input: MaterializationInput,
    effect?: MaterializationEffect,
    options: MaterializationRunOptions = {},
  ): Promise<MaterializationResult> {
    const recoveredInput = await this.recoverQuotaContext(input)
    // With a journal sink injected, quota-failure ledger events (the only
    // persisted events without a wire session id) are fenced on their
    // synthetic ledger identity so the journal append stays inside the same
    // transaction as the canonical insert.
    const fenceSessionId = recoveredInput.sessionId
      || (this.extensionJournalSink ? this.ledgerSessionId(recoveredInput) : '')
    if (!fenceSessionId) {
      return this.materializeUnlocked(recoveredInput, effect, options)
    }
    // Both the durable and the legacy inline path authorize and persist under
    // the same per-session advisory fence so authorization and the canonical
    // insert cannot be separated by a cross-tenant race. The fence rides the
    // canonical-persistence pool (options.pool); business effects keep their
    // dedicated effect pool for the post-commit deferred phase.
    return db.withSessionMaterializationFence(
      this.options.pool,
      fenceSessionId,
      (client) => {
        // The advisory transaction owns this client. Every query made by the
        // scoped materializer must reuse it, otherwise a supported pool size of
        // one would wait on itself forever. Deferred effect closures are the
        // exception: they run post-commit and must use the original pool.
        const queryable = client as unknown as pg.Pool
        const scoped = new EventMaterializer({
          ...this.options,
          pool: queryable,
          effectPool: queryable,
          transactionClient: client,
          durableHooks: this.options.durableHooks,
          deferredPool: this.options.deferredPool ?? this.options.pool,
          deferredEffectPool: this.options.deferredEffectPool
            ?? this.options.effectPool
            ?? this.options.pool,
        })
        return scoped.materializeUnlocked(recoveredInput, effect, options)
      },
    )
  }
}
