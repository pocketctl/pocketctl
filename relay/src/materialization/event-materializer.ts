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
import { releaseQuotaReservation } from '../quota.js'
import { tokenUsageFeatures } from '../config/token-usage.js'
import type {
  DurableMaterializationHooks,
  DurableEffectContext,
  MaterializedAudience,
  MaterializedDelivery,
  MaterializationHooks,
  MaterializationInput,
  MaterializationResult,
} from './types.js'

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
    releaseQuotaReservation: (reservationId) => releaseQuotaReservation(pool, reservationId),
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
  private readonly durableHooks: DurableMaterializationHooks
  private readonly writeTokenUsageFacts: boolean

  constructor(private readonly options: EventMaterializerOptions) {
    this.durableHooks = options.durableHooks ?? createDatabaseMaterializationHooks(options.effectPool ?? options.pool)
    this.writeTokenUsageFacts = options.writeTokenUsageFacts ?? tokenUsageFeatures().writeFacts
  }

  private get effectPool(): pg.Pool {
    return this.options.effectPool ?? this.options.pool
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
        reservation_id: context.reservationId ?? input.payload.reservation_id,
        daemon_id: input.daemonId,
        hostname: context.hostname ?? 'unknown',
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
    return ['session_created', 'session_discovered', 'session_model_changed'].includes(input.eventType)
      ? 'user'
      : 'session'
  }

  private async persistTombstonedEvent(
    input: MaterializationInput,
    assertClaim: () => Promise<void>,
  ): Promise<MaterializationResult> {
    await assertClaim()
    const event = await db.persistEventWithEffect(
      this.options.pool,
      input.sessionId ?? '',
      input.eventType,
      input.payload,
    )
    if (!event.completed) {
      await assertClaim()
      await db.completeEventEffect(this.options.pool, event.rowID)
    }
    return {
      eventId: event.rowID,
      inserted: event.inserted,
      completed: true,
      deliveries: [],
    }
  }

  private async materializeSessionLifecycle(
    input: MaterializationInput,
    result: MaterializationResult,
    effect: DurableEffectContext,
  ): Promise<boolean> {
    const sessionId = input.sessionId ?? ''
    const payload = input.payload
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
        typeof payload.request_id === 'string' ? payload.request_id : null,
      )
      if (context.reservationId) {
        await effect.step(() => this.durableHooks.releaseQuotaReservation(context.reservationId!))
      }
      await effect.step(() => this.options.hooks?.releasePendingOperation?.(
        input.daemonId, context.requestId ?? null,
      ))
      await effect.assertActive()
      this.options.hooks?.clearPendingSession?.(input.daemonId)
      return true
    }
    if (input.eventType === 'session_discovered') {
      await effect.step(async () => {
        // Source is a strict special case: only zcode observer sessions are
        // recorded with source='observer'. Every other agent — even one that
        // forges source='observer' in its payload — is recorded as 'terminal'.
        // This keeps the observer source a closed set and prevents a forged
        // payload from impersonating a read-only sync.
        const source = payload.agent === 'zcode' && payload.source === 'observer'
          ? 'observer'
          : 'terminal'
        await db.upsertSession(
          this.effectPool, sessionId, input.daemonId,
          typeof payload.agent === 'string' ? payload.agent : 'claude-code',
          typeof payload.cwd === 'string' ? payload.cwd : '',
          typeof payload.status === 'string' ? payload.status : 'busy',
          typeof payload.title === 'string' && payload.title ? payload.title : undefined,
          source, undefined, input.userId ?? undefined,
          typeof payload.model === 'string' ? payload.model : undefined,
          typeof payload.control_mode === 'string' ? payload.control_mode : undefined,
          Array.isArray(payload.capabilities) ? payload.capabilities as string[] : undefined,
        )
        this.options.hooks?.bindSession?.(sessionId, input.daemonId)
      })
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
      const outcome = await db.updateSessionStatusForEvent(
        this.effectPool,
        eventID,
        nextStep,
        sessionId,
        input.daemonId,
        typeof payload.status === 'string' ? payload.status : 'unknown',
        typeof payload.exit_reason === 'string' ? payload.exit_reason : undefined,
        input.userId ?? undefined,
        typeof payload.turn_started_at === 'string' ? payload.turn_started_at : undefined,
      )
      if (outcome.suppressed) result.deliveries = []
      else this.options.hooks?.bindSession?.(sessionId, input.daemonId)
    })
    if (result.deliveries.length === 0) return true
    if (payload.cost_usd != null) {
      await effect.step(() => db.updateSessionCost(this.effectPool, sessionId, Number(payload.cost_usd)))
    }
    const status = typeof payload.status === 'string' ? payload.status : 'unknown'
    if (['running', 'busy', 'retry', 'idle', 'waiting', 'waiting_approval', 'waiting_question'].includes(status)) {
      if (input.context?.reservationId) {
        await effect.step(() => this.durableHooks.releaseQuotaReservation(input.context!.reservationId!))
      }
      await effect.step(() => this.options.hooks?.releasePendingOperation?.(
        input.daemonId, input.context?.requestId
          ?? (typeof payload.request_id === 'string' ? payload.request_id : null),
      ))
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
    if (input.eventType !== 'subagent_discovered') return false
    const payload = input.payload
    const sessionId = input.sessionId ?? ''
    await effect.step(async () => {
      const relation = {
        parentSessionId: sessionId,
        agentId: String(payload.agent_id ?? ''),
        rootSessionId: String(payload.root_session_id ?? sessionId),
        kind: payload.agent === 'codex' ? 'codex_subagent'
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
  ): MaterializationEffect {
    return async (effect) => {
      // Preserve the legacy generic session accumulator for older payloads
      // carrying usage, while restricting immutable accounting facts to the
      // canonical agent_text event. subagent_usage is paired bookkeeping and
      // must trigger neither path, otherwise a child turn is counted twice.
      const usage = input.eventType === 'subagent_usage'
        ? undefined
        : input.payload.usage as db.TokenUsageDelta | undefined
      const factEligible = input.eventType === 'agent_text'
      const factKey = input.inboxId > 0 ? `inbox:${input.inboxId}` : undefined
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
      if (await this.materializeSessionLifecycle(input, result, effect)) return
      if (await this.materializeInteraction(input, result.eventId, effect)) return
      if (await this.materializeSubagent(input, effect)) return
      await this.materializeGenericEvent(input, effect)
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
    if (input.inboxId > 0
      && input.sessionId
      && await db.isSessionDeleted(this.effectPool, input.sessionId)) {
      return this.persistTombstonedEvent(input, assertClaim)
    }
    await this.authorizeDaemonSession(input)
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
      input.sessionId ?? '',
      input.eventType,
      input.payload,
    )
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
      const lateEffect = effect ?? lateMaterializer.businessEffect(input, result)
      result.applyEffects = async (): Promise<void> => {
        const latest = await db.getEventEffectState(latePool, event.rowID)
        if (latest?.completed) return
        const nextStep = latest?.nextStep ?? event.nextStep
        let stepIndex = 0
        const context: DurableEffectContext = {
          resuming: nextStep > 0,
          assertActive: assertClaim,
          step: async (stepEffect) => {
            const currentStep = stepIndex++
            if (currentStep < nextStep) return
            await assertClaim()
            await stepEffect()
            await assertClaim()
            await db.advanceEventEffectStep(latePool, event.rowID, currentStep + 1)
          },
          atomicStep: async (stepEffect) => {
            const currentStep = stepIndex++
            if (currentStep < nextStep) return
            await assertClaim()
            await stepEffect(event.rowID, currentStep + 1)
          },
        }
        await lateEffect(context)
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
      let stepIndex = 0
      const context: DurableEffectContext = {
        resuming: nextStep > 0,
        assertActive: assertClaim,
        step: async (stepEffect) => {
          const currentStep = stepIndex++
          if (currentStep < nextStep) return
          await assertClaim()
          await stepEffect()
          await assertClaim()
          await db.advanceEventEffectStep(this.options.pool, event.rowID, currentStep + 1)
        },
        atomicStep: async (stepEffect) => {
          const currentStep = stepIndex++
          if (currentStep < nextStep) return
          await assertClaim()
          await stepEffect(event.rowID, currentStep + 1)
        },
      }
      await activeEffect(context)
    }
    const finalizeEffect = async () => {
      await assertClaim()
      await db.completeEventEffect(this.options.pool, event.rowID)
    }
    await applyEffects()
    await finalizeEffect()
    return result
  }

  async materialize(
    input: MaterializationInput,
    effect?: MaterializationEffect,
    options: MaterializationRunOptions = {},
  ): Promise<MaterializationResult> {
    if (!input.sessionId) {
      return this.materializeUnlocked(input, effect, options)
    }
    // Both the durable and the legacy inline path authorize and persist under
    // the same per-session advisory fence so authorization and the canonical
    // insert cannot be separated by a cross-tenant race. The fence rides the
    // canonical-persistence pool (options.pool); business effects keep their
    // dedicated effect pool for the post-commit deferred phase.
    return db.withSessionMaterializationFence(
      this.options.pool,
      input.sessionId,
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
        return scoped.materializeUnlocked(input, effect, options)
      },
    )
  }
}
