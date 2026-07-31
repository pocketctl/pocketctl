export type ConnectionKind = 'daemon' | 'client'

export type AdmissionResult =
  | { admitted: true; release(): void }
  | { admitted: false; retryAfterMs: number }

export interface ConnectionAdmissionOptions {
  daemonGlobalMax: number
  clientGlobalMax: number
  daemonPerAddressMax: number
  clientPerAddressMax: number
  jitter: () => number
}

/** Bounds only authentication/registration work, not established sockets. */
export class ConnectionAdmission {
  private readonly active = new Map<ConnectionKind, number>()
  private readonly byAddress = new Map<string, number>()

  constructor(private readonly options: ConnectionAdmissionOptions) {}

  tryAcquire(kind: ConnectionKind, remoteAddress: string): AdmissionResult {
    const addressKey = `${kind}\u0000${remoteAddress}`
    const kindActive = this.active.get(kind) ?? 0
    const addressActive = this.byAddress.get(addressKey) ?? 0
    const globalMax = kind === 'daemon' ? this.options.daemonGlobalMax : this.options.clientGlobalMax
    const perAddressMax = kind === 'daemon' ? this.options.daemonPerAddressMax : this.options.clientPerAddressMax
    if (kindActive >= globalMax || addressActive >= perAddressMax) {
      return { admitted: false, retryAfterMs: Math.max(0, this.options.jitter()) }
    }

    this.active.set(kind, kindActive + 1)
    this.byAddress.set(addressKey, addressActive + 1)
    let released = false
    return {
      admitted: true,
      release: () => {
        if (released) return
        released = true
        const nextKind = (this.active.get(kind) ?? 1) - 1
        if (nextKind === 0) this.active.delete(kind); else this.active.set(kind, nextKind)
        const nextAddress = (this.byAddress.get(addressKey) ?? 1) - 1
        if (nextAddress === 0) this.byAddress.delete(addressKey); else this.byAddress.set(addressKey, nextAddress)
      },
    }
  }
}
