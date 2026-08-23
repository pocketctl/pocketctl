import { effectScope } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import { isMobileViewport, useResponsiveLayout } from '../useResponsiveLayout'

type ChangeListener = (event: MediaQueryListEvent) => void

function fakeMediaQuery(initial: boolean) {
  let matches = initial
  const listeners = new Set<ChangeListener>()
  const media = {
    get matches() { return matches },
    media: '(max-width: 768px)',
    addEventListener: vi.fn((_type: string, listener: ChangeListener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: ChangeListener) => listeners.delete(listener)),
  } as unknown as MediaQueryList

  return {
    media,
    setMatches(next: boolean) {
      matches = next
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
    },
  }
}

describe('responsive layout', () => {
  test('classifies the viewport using the mobile media query result', () => {
    expect(isMobileViewport(() => ({ matches: true }) as MediaQueryList)).toBe(true)
    expect(isMobileViewport(() => ({ matches: false }) as MediaQueryList)).toBe(false)
  })

  test('updates when the media query changes and removes its listener with the scope', () => {
    const query = fakeMediaQuery(false)
    const scope = effectScope()
    const state = scope.run(() => useResponsiveLayout(() => query.media))!

    expect(state.isMobile.value).toBe(false)
    query.setMatches(true)
    expect(state.isMobile.value).toBe(true)

    scope.stop()
    expect(query.media.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
