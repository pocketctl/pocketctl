export function classifyCacheRequest(requestUrl, appOrigin, requestMode) {
  const url = new URL(requestUrl)
  if (url.origin !== appOrigin) return 'network-only'
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return 'network-only'
  if (requestMode === 'navigate') return 'network-first'
  if (url.pathname.startsWith('/app/assets/')) return 'cache-first'
  if (
    url.pathname === '/app/manifest.webmanifest'
    || url.pathname.startsWith('/app/icons/')
    || url.pathname === '/app/logo-github-org.svg'
  ) return 'stale-while-revalidate'
  return 'network-only'
}
