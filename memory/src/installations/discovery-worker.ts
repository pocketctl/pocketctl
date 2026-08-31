import type { InstallationsClient } from '../relay/installations.js'
import type { InstallationRegistry } from './repository.js'
import type { ProviderInstallationItem, ProviderInstallationItemV2 } from '../relay/contracts.js'
import { RelayRequestError } from '../relay/errors.js'

export interface DiscoveryWorkerOptions {
  installations: InstallationsClient
  registry: InstallationRegistry
  signal: AbortSignal
  intervalMs?: number
  maxBackoffMs?: number
  /** Safety cap for a malformed or cycling pagination chain. */
  maxPages?: number
  onError?(error: unknown): void
  setTimer?(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
}

const DEFAULT_INTERVAL_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000

/**
 * Generation-based installation discovery. The worker aggregates every
 * inventory page into one complete generation before touching the registry —
 * a failure on any page aborts the whole pass and keeps the previous
 * generation intact.
 */
export function createDiscoveryWorker(options: DiscoveryWorkerOptions) {
  const intervalMs = Math.max(1_000, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  const maxBackoffMs = Math.max(intervalMs, options.maxBackoffMs ?? MAX_BACKOFF_MS)
  const maxPages = options.maxPages ?? 10_000
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running: Promise<void> | undefined

  async function discoverOnce(): Promise<number> {
    // ADR-0005: the v2 inventory mirrors v1 and adds owner-scope metadata;
    // a Relay without v2 answers feature_disabled and we fall back to v1
    // items (personal backfill shape) so discovery never regresses.
    let useV2 = typeof options.installations.listInstallationsV2 === 'function'
    let firstV2Page: Awaited<ReturnType<InstallationsClient['listInstallationsV2']>> | undefined
    if (useV2) {
      try {
        firstV2Page = await options.installations.listInstallationsV2()
      } catch (error) {
        // Backward compatibility is limited to a Relay that genuinely lacks
        // the v2 route/flag. Network, auth, or malformed-response failures
        // abort the generation so shared installations are not falsely marked
        // missing by a v1-only fallback snapshot.
        if (error instanceof RelayRequestError
          && (error.code === 'feature_disabled' || error.status === 404)) {
          useV2 = false
        } else {
          throw error
        }
      }
    }
    const items: Array<ProviderInstallationItem | ProviderInstallationItemV2> = []
    let cursor: string | undefined
    let lastCursor: string | null = null
    let complete = false
    for (let page = 0; page < maxPages; page++) {
      const result = useV2
        ? ((page === 0 && firstV2Page
            ? firstV2Page
            : await options.installations.listInstallationsV2(cursor)) as unknown as {
            installations: ProviderInstallationItemV2[]
            next_cursor: string | null
            has_more: boolean
          })
        : await options.installations.listInstallations(cursor)
      items.push(...result.installations)
      lastCursor = result.next_cursor
      if (!result.has_more) {
        complete = true
        break
      }
      if (!result.next_cursor) throw new Error('installation discovery pagination incomplete')
      cursor = result.next_cursor
      if (options.signal.aborted) throw new Error('discovery aborted')
    }
    if (!complete) throw new Error('installation discovery pagination incomplete')
    const generation = await options.registry.currentGeneration() + 1
    await options.registry.applyDiscovery({ generation, items, installationCursor: lastCursor ?? undefined })
    return items.length
  }

  function schedule(delayMs: number): void {
    if (stopped) return
    timer = setTimer(() => {
      timer = undefined
      void runOnce(delayMs)
    }, delayMs)
    timer.unref?.()
  }

  async function runOnce(previousDelayMs: number): Promise<void> {
    if (running) return running
    const pass = (async () => {
      let delayMs = intervalMs
      try {
        await discoverOnce()
      } catch (error) {
        options.onError?.(error)
        // Exponential backoff floored at intervalMs (the first pass starts
        // at delay 0, so without the floor a failure would retry in a tight
        // loop) and capped at maxBackoffMs; success resets it.
        delayMs = Math.min(Math.max(previousDelayMs * 2, intervalMs), maxBackoffMs)
      }
      schedule(delayMs)
    })()
    running = pass
    try {
      await pass
    } finally {
      if (running === pass) running = undefined
    }
  }

  return {
    start(): void {
      if (stopped || options.signal.aborted) return
      schedule(0)
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
    },
    discoverOnce,
  }
}

export type DiscoveryWorker = ReturnType<typeof createDiscoveryWorker>
