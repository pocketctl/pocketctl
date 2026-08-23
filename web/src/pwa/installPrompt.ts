import { computed, ref } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function browserStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
}

export function createInstallPromptController(
  target: EventTarget,
  isStandalone: () => boolean = browserStandalone,
) {
  const promptEvent = ref<BeforeInstallPromptEvent | null>(null)
  const installed = ref(isStandalone())
  const dismissed = ref(false)

  const onBeforeInstallPrompt = (rawEvent: Event) => {
    rawEvent.preventDefault()
    if (installed.value || dismissed.value || isStandalone()) return
    promptEvent.value = rawEvent as BeforeInstallPromptEvent
  }
  const onInstalled = () => {
    installed.value = true
    promptEvent.value = null
  }

  target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  target.addEventListener('appinstalled', onInstalled)

  const canInstall = computed(() =>
    !installed.value && !dismissed.value && !isStandalone() && promptEvent.value !== null)

  async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = promptEvent.value
    if (!event || !canInstall.value) return 'unavailable'
    await event.prompt()
    const { outcome } = await event.userChoice
    promptEvent.value = null
    if (outcome === 'accepted') installed.value = true
    else dismissed.value = true
    return outcome
  }

  function dispose() {
    target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    target.removeEventListener('appinstalled', onInstalled)
  }

  return { canInstall, installed, dismissed, promptInstall, dispose }
}

const sharedController = typeof window === 'undefined'
  ? null
  : createInstallPromptController(window)

export function useInstallPrompt() {
  if (!sharedController) {
    const unavailable = ref(false)
    return {
      canInstall: computed(() => false),
      installed: unavailable,
      dismissed: unavailable,
      promptInstall: async () => 'unavailable' as const,
    }
  }
  return sharedController
}
