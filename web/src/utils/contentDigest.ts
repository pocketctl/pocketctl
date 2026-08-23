export async function contentDigest(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest).slice(0, 16), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
