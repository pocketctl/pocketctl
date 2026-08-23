import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createInstallPromptController } from '../installPrompt'

class InstallEvent extends Event {
  prompt = vi.fn()
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>

  constructor(outcome: 'accepted' | 'dismissed') {
    super('beforeinstallprompt')
    this.userChoice = Promise.resolve({ outcome })
  }

  preventDefault() {}
}

describe('PWA install prompt', () => {
  test('captures beforeinstallprompt and invokes the saved browser prompt', async () => {
    const target = new EventTarget()
    const controller = createInstallPromptController(target, () => false)
    const event = new InstallEvent('accepted')

    target.dispatchEvent(event)
    expect(controller.canInstall.value).toBe(true)

    await controller.promptInstall()
    expect(event.prompt).toHaveBeenCalledOnce()
    expect(controller.installed.value).toBe(true)
    controller.dispose()
  })

  test('does not offer install in standalone mode or repeatedly after dismissal', async () => {
    const standaloneTarget = new EventTarget()
    const standalone = createInstallPromptController(standaloneTarget, () => true)
    standaloneTarget.dispatchEvent(new InstallEvent('accepted'))
    expect(standalone.canInstall.value).toBe(false)

    const target = new EventTarget()
    const controller = createInstallPromptController(target, () => false)
    target.dispatchEvent(new InstallEvent('dismissed'))
    await controller.promptInstall()
    expect(controller.canInstall.value).toBe(false)
    controller.dispose()
    standalone.dispose()
  })

  test('manifest starts and stays inside the /app/ scope', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf8'))
    expect(manifest.start_url).toBe('/app/sessions?source=pwa')
    expect(manifest.scope).toBe('/app/')
    expect(manifest.display).toBe('standalone')
  })
})
