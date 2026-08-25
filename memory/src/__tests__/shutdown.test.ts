import { describe, expect, test } from 'vitest'
import { createShutdownSignal } from '../shutdown.js'

describe('shutdown signal', () => {
  test('fires the abort and detaches handlers so a second signal terminates', async () => {
    const baselineInt = process.listenerCount('SIGINT')
    const baselineTerm = process.listenerCount('SIGTERM')
    const { signal, wait } = createShutdownSignal()

    expect(signal.aborted).toBe(false)
    process.emit('SIGTERM', 'SIGTERM')
    await wait
    expect(signal.aborted).toBe(true)

    // Both handlers detached: a subsequent SIGINT/SIGTERM reaches Node's
    // default action instead of being swallowed by this listener.
    expect(process.listenerCount('SIGINT')).toBe(baselineInt)
    expect(process.listenerCount('SIGTERM')).toBe(baselineTerm)
  })

  test('only fires once', async () => {
    const { signal, wait } = createShutdownSignal()
    process.emit('SIGINT', 'SIGINT')
    process.emit('SIGTERM', 'SIGTERM')
    await wait
    expect(signal.aborted).toBe(true)
  })
})
