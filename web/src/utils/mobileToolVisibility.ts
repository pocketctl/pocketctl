export const MOBILE_TOOL_VISIBILITY_KEY = 'pocketctl.mobile.showToolCalls'

export function readMobileToolVisibility(): boolean {
  try { return localStorage.getItem(MOBILE_TOOL_VISIBILITY_KEY) === 'true' } catch { return false }
}
export function saveMobileToolVisibility(value: boolean): void {
  try { localStorage.setItem(MOBILE_TOOL_VISIBILITY_KEY, String(value)) } catch { /* In-memory preference remains usable. */ }
}
export function showsMobileMessage(message: { type?: string; tool?: string }, showTools: boolean): boolean {
  return showTools || message.type !== 'tool_call' || message.tool === 'AskUserQuestion'
}
