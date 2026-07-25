/**
 * useEnv — environment-aware URL helpers.
 *
 * Auto-detects the deployment host from the browser's `location` so the same
 * build artefact works both locally (`localhost`) and in production (`pocketctl.me`).
 */

/** HTTP origin of the current deployment, e.g. `http://localhost` or `https://www.pocketctl.me`. */
export function getAppBase(): string {
  return (window as any).__APP_BASE__ || `${location.protocol}//${location.host}`
}

/** WebSocket URL for the relay, e.g. `ws://localhost/ws` or `wss://www.pocketctl.me/ws`. */
export function getRelayWs(): string {
  return localStorage.getItem('pocketctl_relay_url')
    || (window as any).__RELAY_WS__
    || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
}

/** HTTP origin of the relay, or empty string when running locally (so calls use relative paths). */
export function getRelayOrigin(): string {
  const ws = getRelayWs()
  try {
    const url = new URL(ws)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return ''
    return url.origin.replace(/^ws/, 'http')
  } catch {
    return ''
  }
}

/** Full URL to the daemon install script, e.g. `https://www.pocketctl.me/install-daemon.sh`. */
export function getInstallURL(): string {
  return getAppBase() + '/install.sh'
}

/** CLI snippet shown in empty states: curl … | bash */
export function getInstallCommand(): string {
  return `curl -fsSL ${getInstallURL()} | bash`
}

/** Mobile shell is on by default and can be disabled for an emergency rollback. */
export function isPwaMobileShellEnabled(value = import.meta.env.VITE_PWA_MOBILE_SHELL): boolean {
  return value !== 'false'
}

/** Service worker is opt-in so mobile Web remains the safe rollback path. */
export function isPwaServiceWorkerEnabled(value = import.meta.env.VITE_PWA_SERVICE_WORKER): boolean {
  return value === 'true'
}
