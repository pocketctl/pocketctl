import { readonly, ref } from 'vue'

export interface SessionHeaderState {
  title: string
  host: string
  status: string
  statusLabel: string
}

const emptyHeader = (): SessionHeaderState => ({ title: '', host: '', status: '', statusLabel: '' })

// The mobile shell is above route views. A small shared state keeps its session
// identity in sync without creating a second session store in App.
const sessionHeader = ref<SessionHeaderState>(emptyHeader())

export function useSessionHeader() {
  function setSessionHeader(next: Partial<SessionHeaderState>) {
    sessionHeader.value = { ...emptyHeader(), ...next }
  }

  function clearSessionHeader() {
    sessionHeader.value = emptyHeader()
  }

  return { sessionHeader: readonly(sessionHeader), setSessionHeader, clearSessionHeader }
}
