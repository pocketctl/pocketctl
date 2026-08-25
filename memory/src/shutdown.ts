/**
 * Process lifecycle helpers. Background loops observe one AbortSignal wired
 * to SIGINT/SIGTERM; the process keeps running until the signal fires and all
 * loops have drained, so in-flight database transactions can commit.
 */
export function createShutdownSignal(): { signal: AbortSignal; wait: Promise<void> } {
  const controller = new AbortController()
  let resolve!: () => void
  const wait = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  let fired = false
  const fire = () => {
    if (fired) return
    fired = true
    // Detach both handlers: a second signal must fall through to the default
    // action (hard terminate) instead of being swallowed by this listener.
    process.removeListener('SIGINT', fire)
    process.removeListener('SIGTERM', fire)
    controller.abort()
    resolve()
  }
  process.once('SIGINT', fire)
  process.once('SIGTERM', fire)
  return { signal: controller.signal, wait }
}
