import { ref, nextTick } from 'vue'
import { useAuth } from './useAuth'

/**
 * Shared inline rename logic for session list items.
 * Matches design spec (web-session.js openRenameEditor):
 * - startRename: show input at title position, prefill + select old title
 * - commitRename (Enter/blur): save if changed, restore title element
 * - cancelRename (Escape): discard, restore title element
 * - `done` flag prevents Enter + blur double-fire (per design spec)
 */
export function useSessionRename() {
  const { renameSession } = useAuth()
  const renamingId = ref('')
  const renameInput = ref('')
  const oldTitle = ref('')
  let done = false

  function startRename(sessionId: string, title: string) {
    // Prefill with current title (fallback to session_id prefix if empty)
    oldTitle.value = (title && title.trim()) || ''
    renameInput.value = oldTitle.value
    renamingId.value = sessionId
    done = false
    nextTick(() => {
      const el = document.querySelector('.ss-rename-input') as HTMLInputElement
      if (el) { el.focus(); el.select() }
    })
  }

  async function commitRename(s: any) {
    if (done) return
    done = true
    const newTitle = (renameInput.value && renameInput.value.trim()) || oldTitle.value
    const id = renamingId.value
    console.log('[rename] commitRename', { id, newTitle, oldTitle: oldTitle.value, s: !!s, changed: newTitle !== oldTitle.value })
    renamingId.value = ''
    if (id && s && newTitle && newTitle !== oldTitle.value) {
      s.title = newTitle // optimistic update
      try {
        const err = await renameSession(id, newTitle)
        if (err) { s.title = oldTitle.value; console.error('[rename] failed:', err) }
      } catch (e) { s.title = oldTitle.value; console.error('[rename] error:', e) }
    }
  }

  function cancelRename() {
    if (done) return
    done = true
    renamingId.value = ''
  }

  return { renamingId, renameInput, startRename, commitRename, cancelRename }
}
