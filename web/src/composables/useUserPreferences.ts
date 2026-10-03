import { ref } from 'vue'
import { useAuth } from './useAuth'
import { getRelayOrigin } from './useEnv'
import { useLocale } from './useLocale'

export interface UserPreferences {
  locale: 'zh' | 'en'
  theme: 'system' | 'light' | 'dark'
  notifications: { browser: boolean; completed: boolean; errors: boolean; daemon: boolean; updates: boolean }
}
type PreferencePatch = Partial<Omit<UserPreferences, 'notifications'>> & {
  notifications?: Partial<UserPreferences['notifications']>
}
function defaults(): UserPreferences {
  const savedTheme = localStorage.getItem('pocketctl-theme')
  return {
    locale: useLocale().locale.value,
    theme: savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system',
    notifications: { browser: false, completed: true, errors: true, daemon: true, updates: false },
  }
}
const preferences = ref<UserPreferences>(defaults())
const revision = ref(1), error = ref(''), loaded = ref(false)
let configured = false
let owner: number | null = null, generation = 0
let queue: Promise<void> = Promise.resolve()

function switchOwner() {
  const id = useAuth().user?.value?.id ?? null
  if (id !== owner) {
    owner = id
    generation++
    loaded.value = false
    configured = false
    preferences.value = defaults()
    error.value = ''
    revision.value = 1
  }
  return { id, generation }
}
function apply(value: UserPreferences) {
  preferences.value = value
  useLocale().setLocale(value.locale)
  localStorage.setItem('pocketctl-theme', value.theme)
  document.documentElement.dataset.theme = value.theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value.theme
}
async function request(userID: number, method: 'GET' | 'PATCH', body?: unknown) {
  const auth = useAuth()
  const run = () => {
    if (auth.user?.value?.id !== userID) throw new Error('Account changed')
    return fetch(`${getRelayOrigin()}/api/user/preferences`, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.accessToken.value}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  }
  let result = await run()
  if (result.status === 401 && auth.user?.value?.id === userID && await auth.doRefreshToken()) result = await run()
  return { ok: result.ok, status: result.status, data: await result.json() }
}
async function fetchCurrent(id: number, current: number) {
  const result = await request(id, 'GET')
  if (current !== generation) return
  if (!result.ok) throw new Error(result.data.message || result.data.error)
  configured = result.data.configured !== false
  // Preserve the existing browser appearance until this account saves preferences.
  const value = configured ? result.data.preferences : {
    ...result.data.preferences, locale: preferences.value.locale, theme: preferences.value.theme,
  }
  apply(value)
  revision.value = result.data.revision
  loaded.value = true
  error.value = ''
}
export function useUserPreferences() {
  function schedule(run: () => Promise<void>) { queue = queue.then(run, run); return queue }
  function load() {
    const context = switchOwner()
    return schedule(async () => {
      if (!context.id || context.generation !== generation) return
      try { await fetchCurrent(context.id, context.generation) }
      catch (failure) { if (context.generation === generation) error.value = String(failure) }
    })
  }
  function save(patch: PreferencePatch): Promise<void> {
    const context = switchOwner()
    return schedule(async () => {
      if (!context.id || context.generation !== generation) return
      try {
        if (!loaded.value) await fetchCurrent(context.id, context.generation)
        if (!loaded.value || context.generation !== generation) return
        const initialPatch = configured ? patch : {
          locale: preferences.value.locale, theme: preferences.value.theme, ...patch,
        }
        let result = await request(context.id, 'PATCH', { expected_revision: revision.value, preferences: initialPatch })
        if (context.generation !== generation) return
        // On a cross-device conflict, merge only the user's edited fields.
        if (result.status === 409) result = await request(context.id, 'PATCH', {
          expected_revision: result.data.revision, preferences: patch,
        })
        if (context.generation !== generation) return
        if (!result.ok) throw new Error(result.data.message || result.data.error)
        apply(result.data.preferences)
        revision.value = result.data.revision
        configured = true
        error.value = ''
      } catch (failure) { if (context.generation === generation) error.value = String(failure) }
    })
  }
  return { preferences, error, loaded, load, save }
}
