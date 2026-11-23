// This journal only stores correlation IDs. Prompt text stays in the current
// view, and recovery always uses a read-only request.
interface PendingReceipt {
  session: string
  id: string
  at: number
}
const prefix = 'pocketctl-session-receipts:'
const maxAge = 24 * 60 * 60 * 1000
const maxEntries = 60

function read(scope: string): PendingReceipt[] {
  try {
    const rows: PendingReceipt[] = JSON.parse(sessionStorage.getItem(prefix + scope) || '[]')
    return rows.filter(row => typeof row.session === 'string' && typeof row.id === 'string'
      && row.at <= Date.now() && Date.now() - row.at < maxAge)
  } catch {
    return []
  }
}

function write(scope: string, entries: PendingReceipt[]) {
  try {
    if (entries.length) sessionStorage.setItem(prefix + scope, JSON.stringify(entries.slice(-maxEntries)))
    else sessionStorage.removeItem(prefix + scope)
  } catch { /* Recovery is best effort when browser storage is unavailable. */ }
}

export function rememberReceipt(scope: string, session: string, id: string) {
  write(scope, [...read(scope).filter(row => row.id !== id), { session, id, at: Date.now() }])
}

export function pendingReceiptIds(scope: string, session: string) {
  return read(scope).filter(row => row.session === session).map(row => row.id)
}

export function forgetReceipts(scope: string, ids: Set<string>) {
  write(scope, read(scope).filter(row => !ids.has(row.id)))
}

export function moveReceipts(scope: string, from: string, to: string) {
  write(scope, read(scope).map(row => row.session === from ? { ...row, session: to } : row))
}

export function clearReceiptJournals() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key)
    }
  } catch { /* Storage may be disabled. */ }
}
