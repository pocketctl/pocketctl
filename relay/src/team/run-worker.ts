import { coordinatorPrompt, parseTeamRunDecision, TeamRunDecisionError } from './run-decision.js'
import { TeamRunRepository, type TeamRunMutation } from './run-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamEvent, TeamRun } from './types.js'

interface TeamRunWorkerRepository {
  claimNext(workerId: string, leaseMs: number): ReturnType<TeamRunRepository['claimNext']>
  loadWork(runId: string, leaseToken: number): ReturnType<TeamRunRepository['loadWork']>
  scheduleCall(input: Parameters<TeamRunRepository['scheduleCall']>[0]): ReturnType<TeamRunRepository['scheduleCall']>
  transition(input: Parameters<TeamRunRepository['transition']>[0]): ReturnType<TeamRunRepository['transition']>
  cancelPending(runId: string, leaseToken: number): Promise<number>
  defer(runId: string, leaseToken: number, delayMs: number): Promise<void>
}

interface TeamRunWorkerOptions {
  repository: TeamRunWorkerRepository
  workerId: string
  leaseMs?: number
  pollIntervalMs?: number
  onEvent?: (sessionId: string, participantUserIds: number[], event: TeamEvent) => void
  onCall?: (callId: string) => void
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class TeamRunWorker {
  private readonly leaseMs: number
  private readonly pollIntervalMs: number
  private readonly setTimer: NonNullable<TeamRunWorkerOptions['setTimer']>
  private readonly clearTimer: NonNullable<TeamRunWorkerOptions['clearTimer']>
  private timer?: ReturnType<typeof setTimeout>
  private activeRun?: Promise<boolean>
  private stopped = true

  constructor(private readonly options: TeamRunWorkerOptions) {
    this.leaseMs = Math.max(1_000, options.leaseMs ?? 15_000)
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 500)
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer))
  }

  private publish(mutation: TeamRunMutation): void {
    this.options.onEvent?.(mutation.run.team_session_id, mutation.participantUserIds, mutation.event)
  }

  private async transition(input: Parameters<TeamRunWorkerRepository['transition']>[0]): Promise<void> {
    this.publish(await this.options.repository.transition(input))
  }

  private async schedule(input: Parameters<TeamRunWorkerRepository['scheduleCall']>[0]): Promise<void> {
    const scheduled = await this.options.repository.scheduleCall(input)
    this.options.onEvent?.(scheduled.teamSessionId, scheduled.participantUserIds, scheduled.event)
    this.options.onCall?.(scheduled.callId)
  }

  async runOnce(): Promise<boolean> {
    if (this.activeRun) return this.activeRun
    const running = this.processOne()
    this.activeRun = running
    try { return await running } finally { if (this.activeRun === running) this.activeRun = undefined }
  }

  private async processOne(): Promise<boolean> {
    const lease = await this.options.repository.claimNext(this.options.workerId, this.leaseMs)
    if (!lease) return false
    const snapshot = await this.options.repository.loadWork(lease.run.id, lease.leaseToken)
    if (!snapshot) return true
    const { run, latestCall } = snapshot
    const transitionBase = { runId: run.id, leaseToken: lease.leaseToken }

    if (run.stop_requested) {
      await this.options.repository.cancelPending(run.id, lease.leaseToken)
      if (latestCall && ['dispatched', 'accepted'].includes(latestCall.state)) {
        await this.options.repository.defer(run.id, lease.leaseToken, this.pollIntervalMs)
      } else if (latestCall?.state === 'uncertain') {
        await this.transition({ ...transitionBase, state: 'blocked', terminalReason: 'dispatch_uncertain', content: 'Run stop is blocked until an uncertain call is reconciled.' })
      } else {
        await this.transition({ ...transitionBase, state: 'cancelled', terminalReason: 'stop_requested', content: 'Run cancelled after all accepted calls settled.' })
      }
      return true
    }

    if (new Date(run.deadline_at).getTime() <= Date.now()) {
      await this.options.repository.cancelPending(run.id, lease.leaseToken)
      if (latestCall && ['dispatched', 'accepted', 'uncertain'].includes(latestCall.state)) {
        await this.transition({ ...transitionBase, state: 'blocked', terminalReason: 'run_deadline_reconcile_required', content: 'Run time budget expired; in-flight or uncertain calls require reconciliation.' })
      } else {
        await this.transition({ ...transitionBase, state: 'failed', terminalReason: 'budget_exhausted', content: 'Run stopped because its wall-time budget was exhausted.' })
      }
      return true
    }

    const coordinator = snapshot.bindings.find(binding => binding.offerId === run.coordinator_offer_id)
    if (!coordinator?.callable) {
      await this.transition({ ...transitionBase, state: 'blocked', terminalReason: 'coordinator_unavailable', content: 'Run is blocked because its coordinator Agent is unavailable.' })
      return true
    }
    const workerOfferIds = snapshot.bindings.filter(binding => binding.callable && binding.offerId !== run.coordinator_offer_id).map(binding => binding.offerId)

    if (!latestCall || latestCall.runStep <= run.processed_call_step) {
      await this.scheduleCoordinator(run, lease.leaseToken, workerOfferIds, latestCall?.runStep ?? 0, snapshot.latestMemberInput ?? undefined)
      return true
    }
    if (['pending', 'dispatched', 'accepted'].includes(latestCall.state)) {
      await this.options.repository.defer(run.id, lease.leaseToken, this.pollIntervalMs)
      return true
    }
    if (latestCall.state === 'uncertain') {
      await this.transition({ ...transitionBase, state: 'blocked', terminalReason: 'dispatch_uncertain', processedCallStep: latestCall.runStep, content: 'Run is blocked because a call outcome is uncertain and will not be retried automatically.' })
      return true
    }
    if (latestCall.runRole === 'worker') {
      const observation = latestCall.state === 'completed'
        ? `Agent ${latestCall.offerId} completed:\n${latestCall.response ?? '(no public response)'}`
        : `Agent ${latestCall.offerId} ended in state ${latestCall.state}: ${latestCall.outcome ?? 'no outcome'}`
      await this.scheduleCoordinator(run, lease.leaseToken, workerOfferIds, latestCall.runStep, observation)
      return true
    }
    if (latestCall.state !== 'completed') {
      await this.transition({ ...transitionBase, state: 'blocked', terminalReason: 'coordinator_unavailable', processedCallStep: latestCall.runStep, content: `Coordinator call ended in state ${latestCall.state}; the coordinator was not replaced.` })
      return true
    }
    try {
      const decision = parseTeamRunDecision(latestCall.response ?? '', {
        contextVersion: run.context_version,
        allowedOfferIds: new Set(workerOfferIds),
      })
      if (decision.action === 'call_agent') {
        await this.schedule({
          runId: run.id, leaseToken: lease.leaseToken, offerId: decision.target_offer_id, role: 'worker',
          content: decision.instruction, processedCallStep: latestCall.runStep,
        })
      } else if (decision.action === 'request_input') {
        await this.transition({
          ...transitionBase, state: 'waiting_input', waitingQuestion: decision.question,
          processedCallStep: latestCall.runStep, content: `Coordinator requested participant input: ${decision.question}`,
        })
      } else {
        await this.transition({
          ...transitionBase, state: 'completed', terminalReason: 'coordinator_completed',
          processedCallStep: latestCall.runStep, content: decision.summary,
        })
      }
    } catch (error) {
      if (!(error instanceof TeamRunDecisionError)) throw error
      await this.transition({
        ...transitionBase, state: 'blocked', terminalReason: 'invalid_coordinator_decision',
        processedCallStep: latestCall.runStep, content: `Run blocked: ${error.message}.`,
      })
    }
    return true
  }

  private async scheduleCoordinator(run: TeamRun, leaseToken: number, allowedOfferIds: string[], processedCallStep: number, observation?: string): Promise<void> {
    if (run.calls_used >= run.budget.max_calls) {
      await this.transition({
        runId: run.id, leaseToken, state: 'failed', terminalReason: 'budget_exhausted',
        processedCallStep, content: 'Run stopped because its call budget was exhausted.',
      })
      return
    }
    try {
      await this.schedule({
        runId: run.id, leaseToken, offerId: run.coordinator_offer_id, role: 'coordinator', processedCallStep,
        content: coordinatorPrompt({
          contextVersion: run.context_version, allowedOfferIds,
          callsRemaining: Math.max(0, run.budget.max_calls - run.calls_used - 1), observation,
        }),
      })
    } catch (error) {
      if (!(error instanceof TeamRepositoryError) || error.code !== 'budget_exhausted') throw error
      await this.transition({
        runId: run.id, leaseToken, state: 'failed', terminalReason: 'budget_exhausted',
        processedCallStep, content: 'Run stopped because its frozen call or concurrency budget was exhausted.',
      })
    }
  }

  private scheduleLoop(delayMs: number): void {
    if (this.stopped || this.timer) return
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.runOnce().catch(error => console.error('[team-run-worker] iteration failed', { error })).finally(() => this.scheduleLoop(this.pollIntervalMs))
    }, delayMs)
    this.timer.unref?.()
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleLoop(0)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) { this.clearTimer(this.timer); this.timer = undefined }
    await this.activeRun
  }
}

export function createTeamRunWorker(pool: ConstructorParameters<typeof TeamRunRepository>[0], options: Omit<TeamRunWorkerOptions, 'repository'>): TeamRunWorker {
  return new TeamRunWorker({ ...options, repository: new TeamRunRepository(pool) })
}
