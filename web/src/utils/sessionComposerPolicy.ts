export type SessionComposerConnectivity = 'offline' | 'connecting' | 'syncing' | 'ready'

export interface SessionComposerState {
  visible: boolean
  editable: boolean
  sendEnabled: boolean
}

// Agent-specific control rules decide whether a session is writable while
// connected. This policy only overlays transport readiness so a reconnect does
// not turn a writable session into an ended one.
export function resolveSessionComposerState(
  writableWhenConnected: boolean,
  connectivity: SessionComposerConnectivity,
): SessionComposerState {
  if (!writableWhenConnected) return { visible: false, editable: false, sendEnabled: false }
  if (connectivity === 'ready') return { visible: true, editable: true, sendEnabled: true }
  if (connectivity === 'syncing') return { visible: true, editable: false, sendEnabled: false }
  return { visible: true, editable: true, sendEnabled: false }
}
