import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const focusableSelector = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'

export function usePanelFocus() {
  const panel = ref<HTMLElement | null>(null)
  let previousFocus: HTMLElement | null = null

  function trapFocus(event: KeyboardEvent): void {
    const nodes = Array.from(panel.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
    const first = nodes[0]
    const last = nodes.at(-1)
    if (!first) { event.preventDefault(); panel.value?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
      event.preventDefault(); last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  onMounted(async () => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    ;(panel.value?.querySelector<HTMLElement>(focusableSelector) ?? panel.value)?.focus()
  })
  onBeforeUnmount(() => previousFocus?.focus())

  return { panel, trapFocus }
}
