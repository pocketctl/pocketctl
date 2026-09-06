import { effectScope } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import { useVisualViewport } from '../useVisualViewport'

function createViewport(height = 700, pageTop = 0) {
  const listeners = new Map<string, Set<EventListener>>()
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener(new Event(type))
  }
  return {
    viewport: {
      height,
      pageTop,
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const typeListeners = listeners.get(type) ?? new Set<EventListener>()
        typeListeners.add(listener)
        listeners.set(type, typeListeners)
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => listeners.get(type)?.delete(listener)),
    } as unknown as VisualViewport,
    resize(nextHeight: number) {
      Object.assign(this.viewport, { height: nextHeight })
      emit('resize')
    },
    scroll(nextPageTop: number) {
      Object.assign(this.viewport, { pageTop: nextPageTop })
      emit('scroll')
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

  test('tracks the visual viewport bottom when the browser pans for the keyboard', () => {
    const fake = createViewport(420, 180)
    const root = document.createElement('div')
    const scope = effectScope()
    const state = scope.run(() => useVisualViewport(fake.viewport, root))!

    expect(state.pageTop.value).toBe(180)
    expect(root.style.getPropertyValue('--visual-viewport-bottom')).toBe('600px')

    fake.scroll(260)

    expect(state.pageTop.value).toBe(260)
    expect(root.style.getPropertyValue('--visual-viewport-bottom')).toBe('680px')
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
