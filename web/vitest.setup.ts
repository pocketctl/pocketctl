// Global test setup for vitest.
//
// happy-dom's localStorage is unreliable across module-load timing: modules
// that read localStorage at import time (e.g. composables/useLocale.ts calls
// detectLocale() at module top level, and useRelativeTime/diffRender/DiffCard
// pull it in transitively) fail with "localStorage.getItem is not a function".
// Install a minimal in-memory localStorage once, globally, so every test gets
// a working one. Tests that need specific values call setItem; tests that want
// vi.fn spying can still override via Object.defineProperty (configurable:true).

const store = new Map<string, string>()

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  },
})
