export const STATIC_DOCUMENT_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function removeStaticDocumentChildFrames(source: string): string {
  const withoutFrameTags = source.replace(/<\s*\/?\s*(?:iframe|frame)\b[^>]*>/gi, '')
  const template = document.createElement('template')
  template.innerHTML = withoutFrameTags
  for (const element of template.content.querySelectorAll('iframe,frame')) element.remove()
  return template.innerHTML
}

export function buildStaticDocumentSrcdoc(source: string): string {
  const staticSource = removeStaticDocumentChildFrames(source)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_DOCUMENT_CSP}"><meta name="referrer" content="no-referrer"></head><body>${staticSource}</body></html>`
}
