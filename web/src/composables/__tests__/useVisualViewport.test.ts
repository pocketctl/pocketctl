import { effectScope } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import { useVisualViewport } from '../useVisualViewport'

function createViewport(height = 700) {
  const listeners = new Set<EventListener>()
  return {
    viewport: {
      height,
      addEventListener: vi.fn((_type: string, listener: EventListener) => listeners.add(listener)),
      removeEventListener: vi.fn((_type: string, listener: EventListener) => listeners.delete(listener)),
    } as unknown as VisualViewport,
    resize(nextHeight: number) {
      Object.assign(this.viewport, { height: nextHeight })
      for (const listener of listeners) listener(new Event('resize'))
    },
  }
}

describe('useVisualViewport', () => {
  test('updates the viewport height and CSS variable on resize', () => {
    const fake = createViewport()
    const root = document.createElement('div')
    const scope = effectScope()
    const state = scope.run(() => useVisualViewport(fake.viewport, root))!

    expect(state.height.value).toBe(700)
    expect(root.style.getPropertyValue('--visual-viewport-height')).toBe('700px')

    fake.resize(420)

    expect(state.height.value).toBe(420)
    expect(root.style.getPropertyValue('--visual-viewport-height')).toBe('420px')
    scope.stop()
  })

  test('removes viewport listeners when its scope is disposed', () => {
    const fake = createViewport()
    const scope = effectScope()

    scope.run(() => useVisualViewport(fake.viewport, document.documentElement))
    scope.stop()

    expect(fake.viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(fake.viewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
