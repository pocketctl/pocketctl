import { onScopeDispose, ref } from 'vue'

export const MOBILE_MEDIA_QUERY = '(max-width: 768px)'

type MediaMatcher = (query: string) => MediaQueryList

function defaultMatcher(query: string): MediaQueryList {
  return window.matchMedia(query)
}

export function isMobileViewport(matchMedia: MediaMatcher = defaultMatcher): boolean {
  if (typeof window === 'undefined' && matchMedia === defaultMatcher) return false
  return matchMedia(MOBILE_MEDIA_QUERY).matches
}

export function useResponsiveLayout(matchMedia: MediaMatcher = defaultMatcher) {
  const media = matchMedia(MOBILE_MEDIA_QUERY)
  const isMobile = ref(media.matches)
  const update = (event: MediaQueryListEvent) => {
    isMobile.value = event.matches
  }

  media.addEventListener('change', update)
  onScopeDispose(() => media.removeEventListener('change', update))

  return { isMobile }
}
