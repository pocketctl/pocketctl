import { afterEach, expect, test, vi } from 'vitest'
import '../pt-execution-mark.js'

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('holds PT without scheduling frames, cancels the wake offscreen and resumes on return', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let visibility!: (entries: { isIntersecting: boolean }[]) => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof visibility) { visibility = callback }
    observe() {}
    disconnect() {}
  })
  const preference = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', () => preference)
  // Drive display frames independently of the single sleep timer.
  let nextFrame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { nextFrame = cb; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { nextFrame = undefined })
  const mark = document.createElement('pt-execution-mark')
  document.body.append(mark)
  visibility([{ isIntersecting: true }])
  const firstDot = mark.querySelector('circle')!
  const writes = vi.spyOn(firstDot, 'setAttribute')
  function frameAfter(ms: number) {
    vi.advanceTimersByTime(ms)
    const frame = nextFrame!
    nextFrame = undefined
    frame(performance.now())
  }

  frameAfter(2750)
  expect(mark.querySelectorAll('circle')).toHaveLength(23)
  expect(mark.querySelector('[stroke]')).toBeNull()
  expect(Number(firstDot.getAttribute('cx'))).toBeCloseTo(4.56, 8)
  expect(nextFrame).toBeUndefined()
  expect(vi.getTimerCount()).toBe(1)
  writes.mockClear()
  vi.advanceTimersByTime(1000)
  expect(writes).not.toHaveBeenCalled()
  visibility([{ isIntersecting: false }])
  expect(vi.getTimerCount()).toBe(0)
  visibility([{ isIntersecting: true }])
  expect(writes).not.toHaveBeenCalled()
  frameAfter(700)
  expect(Number(firstDot.getAttribute('cx'))).not.toBeCloseTo(4.56, 8)

  frameAfter(4300) // Next cycle, inside the hold again.
  expect(vi.getTimerCount()).toBe(1)
  preference.matches = true
  preference.dispatchEvent(new Event('change'))
  expect(vi.getTimerCount()).toBe(0)
  expect(nextFrame).toBeUndefined()
  preference.matches = false
  preference.dispatchEvent(new Event('change'))
  expect(vi.getTimerCount()).toBe(1)
  mark.remove()
  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(6000)
  expect(nextFrame).toBeUndefined()
})
