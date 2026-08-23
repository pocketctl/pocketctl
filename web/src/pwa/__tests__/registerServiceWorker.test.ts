import { describe, expect, test, vi } from 'vitest'
import { isSecurePwaContext, registerPwaServiceWorker } from '../registerServiceWorker'
// @ts-expect-error public worker policy is plain JavaScript shared with sw.js
import { classifyCacheRequest } from '../../../public/sw-policy.js'

describe('PWA service worker registration', () => {
  test('only permits HTTPS and loopback development origins', () => {
    expect(isSecurePwaContext(new URL('https://pocketctl.example/app/'))).toBe(true)
    expect(isSecurePwaContext(new URL('http://localhost:3000/app/'))).toBe(true)
    expect(isSecurePwaContext(new URL('http://127.0.0.1:3000/app/'))).toBe(true)
    expect(isSecurePwaContext(new URL('http://pocketctl.example/app/'))).toBe(false)
  })

  test('registers with /app/ scope and only activates a waiting update after confirmation', async () => {
    const postMessage = vi.fn()
    const waiting = { postMessage }
    const registration = { waiting }
    const container = new EventTarget() as ServiceWorkerContainer
    Object.assign(container, {
      controller: {},
      register: vi.fn(async () => registration),
      getRegistrations: vi.fn(async () => [registration]),
    })

    const controller = await registerPwaServiceWorker({
      enabled: true,
      container,
      pageUrl: new URL('https://pocketctl.example/app/sessions'),
    })

    expect(container.register).toHaveBeenCalledWith('/app/sw.js', {
      scope: '/app/',
      type: 'module',
    })
    expect(controller.updateAvailable.value).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()

    controller.confirmUpdate()
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })
})

describe('PWA cache policy', () => {
  test('never caches API, WebSocket, or cross-origin requests', () => {
    const origin = 'https://pocketctl.example'
    expect(classifyCacheRequest(`${origin}/api/sessions`, origin, 'cors')).toBe('network-only')
    expect(classifyCacheRequest(`${origin}/ws`, origin, 'websocket')).toBe('network-only')
    expect(classifyCacheRequest('https://other.example/app/assets/a.js', origin, 'cors')).toBe('network-only')
  })

  test('only caches the public application shell', () => {
    const origin = 'https://pocketctl.example'
    expect(classifyCacheRequest(`${origin}/app/assets/a.123.js`, origin, 'cors')).toBe('cache-first')
    expect(classifyCacheRequest(`${origin}/app/manifest.webmanifest`, origin, 'cors')).toBe('stale-while-revalidate')
    expect(classifyCacheRequest(`${origin}/app/session/123`, origin, 'navigate')).toBe('network-first')
  })
})
