import type { InjectionKey } from 'vue'

export const sessionDocumentLinkKey: InjectionKey<(path: string) => string> = Symbol('session-document-link')

export function localDocumentPath(href: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  let path = href
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      if (url.hostname && url.hostname !== 'localhost') return null
      path = url.pathname
    } catch { return null }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null
  path = path.split(/[?#]/, 1)[0] || ''
  try { path = decodeURIComponent(path) } catch { return null }
  if (path.length > 4096 || /[\x00-\x1f]/.test(path) || !/\.(?:html?|md|markdown)$/i.test(path)) return null
  return path
}

// Operate only on already-sanitized prose, never code blocks. Using attributes
// rather than click interception also preserves open-in-new-tab/copy-link.
export function rewriteSessionDocumentLinks(html: string, resolve: (path: string) => string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    const path = localDocumentPath(anchor.getAttribute('href') || '')
    if (path) anchor.setAttribute('href', resolve(path))
  }
  return template.innerHTML
}
