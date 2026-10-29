import type { StepAdvanceResult } from './step-scheduler.js'
import { StepWakeupLeaseLost, type StepWakeupClaim, type StepWakeupRepository } from './step-wakeup-repository.js'

interface StepWorkerOptions {
  repository: Pick<StepWakeupRepository, 'claim' | 'retry'>
  scheduler: { process(claim: StepWakeupClaim): Promise<StepAdvanceResult> }
  teamIds(): string[]
  onCall?(callId: string): void
  onError?(code: string): void
  pollMs?: number
}

/** Claims only explicitly enabled Teams. The scheduler commits ordinary Call
 * intents; the existing dispatcher remains the sole native execution path. */
export class TeamStepWorker {
  private timer?: ReturnType<typeof setTimeout>
  private active?: Promise<boolean>
  private stopped = true
  private readonly pollMs: number
  constructor(private readonly options: StepWorkerOptions) {
    this.pollMs = Math.max(25, options.pollMs ?? 500)
  }

  async runOnce(): Promise<boolean> {
    if (this.active) return this.active
    const active = this.processOne()
    this.active = active
    try { return await active } finally { if (this.active === active) this.active = undefined }
  }

  private async processOne(): Promise<boolean> {
    const teams = this.options.teamIds()
    if (!teams.length) return false
    const claim = await this.options.repository.claim(teams)
    if (!claim) return false
    let result: StepAdvanceResult
    try { result = await this.options.scheduler.process(claim) }
    catch (error) {
      if (error instanceof StepWakeupLeaseLost) return true
      const code = (error as { code?: string } | null)?.code
      const retryCode = code === 'budget_exhausted' ? 'budget_exhausted'
        : ['creator_required', 'participant_required', 'team_access_denied', 'team_feature_disabled'].includes(code ?? '') ? 'authorization_changed'
        : ['reviewer_required', 'capability_not_supported', 'agent_unavailable', 'artifact_unavailable', 'acceptance_required', 'evidence_required', 'input_limit_exceeded'].includes(code ?? '') ? 'dependency_unavailable'
        : 'retry_pending'
      // Do not acknowledge failed work or fabricate terminal state. A new
      // generation bypasses this backoff; lease fencing protects replacements.
      await this.options.repository.retry(claim, retryCode, retryCode === 'retry_pending' ? 1000 : 30_000)
      this.options.onError?.(retryCode)
      return true
    }
    if (result.call_id) {
      try { this.options.onCall?.(result.call_id) }
      catch { this.options.onError?.('dispatch_notification_failed') }
      // A lost process or notification is recovered by the dispatcher's DB
      // polling. Never repeat a successful reservation to recover notification.
    }
    return true
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runOnce().catch(() => this.options.onError?.('worker_unavailable'))
        .finally(() => this.schedule(this.pollMs))
    }, delay)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    await this.active?.catch(() => {})
  }
}
