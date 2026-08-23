export interface DeadlineTimers {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export class RegistrationDeadline {
  private active = true
  private readonly handle: unknown

  constructor(timeoutMs: number, private readonly timers: DeadlineTimers, private readonly onExpire: () => void) {
    this.handle = timers.setTimeout(() => {
      if (!this.active) return
      this.active = false
      this.onExpire()
    }, timeoutMs)
  }

  complete(): boolean {
    if (!this.active) return false
    this.active = false
    this.timers.clearTimeout(this.handle)
    return true
  }

  isActive(): boolean { return this.active }
}
