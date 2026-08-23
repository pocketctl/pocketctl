import { describe, expect, test } from 'vitest'
import { BoundedExecutor, ExecutorOverloadedError } from '../ingress/bounded-executor.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const never = () => new Promise<never>(() => undefined)

describe('BoundedExecutor', () => {
  test('never starts more than maxConcurrent tasks', async () => {
    const gate = new BoundedExecutor({ maxConcurrent: 2, maxPending: 4 })
    let active = 0
    let peak = 0
    const release = deferred<void>()
    const jobs = Array.from({ length: 4 }, (_, i) => gate.run(`d${i % 2}`, async () => {
      peak = Math.max(peak, ++active)
      await release.promise
      active--
    }))

    await tick()
    expect(peak).toBe(2)
    release.resolve()
    await Promise.all(jobs)
  })

  test('rejects beyond the pending hard cap', async () => {
    const gate = new BoundedExecutor({ maxConcurrent: 1, maxPending: 1 })
    void gate.run('d1', never)
    void gate.run('d1', never)

    await expect(gate.run('d1', never)).rejects.toBeInstanceOf(ExecutorOverloadedError)
  })

  test('releases queued tasks in FIFO order', async () => {
    const gate = new BoundedExecutor({ maxConcurrent: 1, maxPending: 2 })
    const release = deferred<void>()
    const started: string[] = []
    const first = gate.run('first', async () => { started.push('first'); await release.promise })
    const second = gate.run('second', async () => { started.push('second') })
    const third = gate.run('third', async () => { started.push('third') })

    await tick()
    expect(started).toEqual(['first'])
    release.resolve()
    await Promise.all([first, second, third])
    expect(started).toEqual(['first', 'second', 'third'])
  })
})
