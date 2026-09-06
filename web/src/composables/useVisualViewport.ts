import { onScopeDispose, ref } from 'vue'

type ViewportRoot = Pick<HTMLElement, 'style'>

function browserVisualViewport(): VisualViewport | null {
  return typeof window === 'undefined' ? null : window.visualViewport
}

export function useVisualViewport(
  viewport: VisualViewport | null = browserVisualViewport(),
  root: ViewportRoot = document.documentElement,
) {
  const height = ref(viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight))
  const pageTop = ref(viewport?.pageTop ?? (typeof window === 'undefined' ? 0 : window.scrollY))

  const update = () => {
    height.value = viewport?.height ?? window.innerHeight
    pageTop.value = viewport?.pageTop ?? window.scrollY
    root.style.setProperty('--visual-viewport-height', `${Math.round(height.value)}px`)
    root.style.setProperty('--visual-viewport-bottom', `${Math.round(pageTop.value + height.value)}px`)
  }

  update()
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)

  onScopeDispose(() => {
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
  })

  return { height, pageTop }
}
