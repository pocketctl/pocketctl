export const STATIC_SNAPSHOT_CONTENT_SECURITY_POLICY = [
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

export const STATIC_SNAPSHOT_WRAPPER_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self' data:",
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function removeStaticDocumentChildFrames(source: string): string {
  return source.replace(/<\s*\/?\s*(?:iframe|frame)\b[^>]*>/gi, '')
}

export function buildStaticHTMLSnapshot(source: string): string {
  const staticSource = removeStaticDocumentChildFrames(source)
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${STATIC_SNAPSHOT_CONTENT_SECURITY_POLICY}"></head><body>${staticSource}</body></html>`
  const srcdoc = escapeAttribute(inner)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${STATIC_SNAPSHOT_WRAPPER_POLICY}">
<meta name="referrer" content="no-referrer">
<title>Static document snapshot</title>
<style>html,body,iframe{box-sizing:border-box;width:100%;height:100%;margin:0;border:0}body{background:#fff}</style>
</head>
<body><iframe sandbox="" referrerpolicy="no-referrer" srcdoc="${srcdoc}"></iframe></body>
</html>`
}
