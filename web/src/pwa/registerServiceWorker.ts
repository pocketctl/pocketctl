import { ref } from 'vue'
import { isPwaServiceWorkerEnabled } from '../composables/useEnv'

interface RegistrationOptions {
  enabled: boolean
  container: ServiceWorkerContainer
  pageUrl: URL
  cacheStorage?: CacheStorage
  reload?: () => void
}

export const pwaUpdateAvailable = ref(false)
let activeWaitingWorker: ServiceWorker | null = null
let updateConfirmed = false

export function isSecurePwaContext(url: URL): boolean {
  return url.protocol === 'https:'
    || url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]'
}

async function removePocketCtlWorkerData(
  container: ServiceWorkerContainer,
  cacheStorage?: CacheStorage,
) {
  const registrations = await container.getRegistrations()
  await Promise.all(registrations
    .filter(registration => registration.scope.includes('/app/'))
    .map(registration => registration.unregister()))

  if (!cacheStorage) return
  const keys = await cacheStorage.keys()
  await Promise.all(keys
    .filter(key => key.startsWith('pocketctl-'))
    .map(key => cacheStorage.delete(key)))
}

export async function registerPwaServiceWorker(options: RegistrationOptions) {
  const { enabled, container, pageUrl, cacheStorage, reload = () => location.reload() } = options
  if (!enabled || !isSecurePwaContext(pageUrl)) {
    if (!enabled) await removePocketCtlWorkerData(container, cacheStorage)
    return { updateAvailable: pwaUpdateAvailable, confirmUpdate: () => undefined }
  }

  const registration = await container.register('/app/sw.js', {
    scope: '/app/',
    type: 'module',
  })

  const markWaiting = (worker: ServiceWorker | null) => {
    if (!worker) return
    activeWaitingWorker = worker
    pwaUpdateAvailable.value = true
  }
  markWaiting(registration.waiting)

  registration.addEventListener?.('updatefound', () => {
    const installing = registration.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && container.controller) markWaiting(registration.waiting)
    })
  })
  container.addEventListener('controllerchange', () => {
    if (updateConfirmed) reload()
  })

  return {
    updateAvailable: pwaUpdateAvailable,
    confirmUpdate() {
      if (!activeWaitingWorker) return
      updateConfirmed = true
      activeWaitingWorker.postMessage({ type: 'SKIP_WAITING' })
    },
  }
}

export async function initializePwaServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  try {
    await registerPwaServiceWorker({
      enabled: isPwaServiceWorkerEnabled(),
      container: navigator.serviceWorker,
      pageUrl: new URL(location.href),
      cacheStorage: typeof caches === 'undefined' ? undefined : caches,
    })
  } catch (error) {
    console.warn('PWA service worker setup failed; continuing as mobile web.', error)
  }
}

export function confirmPwaUpdate() {
  if (!activeWaitingWorker) return
  updateConfirmed = true
  activeWaitingWorker.postMessage({ type: 'SKIP_WAITING' })
}
