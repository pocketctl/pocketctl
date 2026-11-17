// Conservative preview: containers and reference links wait for final parsing.
// The full source is never modified or truncated.
export function streamingParagraphs(text: string): { blocks: string[]; tail: string } {
  // Freeze the safe prefix at the scan budget instead of replacing already
  // rendered paragraphs with a single plain node when output crosses 32k.
  // Only complete paragraphs in this prefix are parsed; everything else stays
  // exact plain text until the terminal full Markdown render.
  const prefix = text.slice(0, 32000)
  if (/[\[\]`~]|^(?:[ \t]|>|[-+*=]|\d+[.)])/m.test(prefix)) return { blocks: [], tail: text }
  const parts = prefix.split(/\n\s*\n/)
  return { blocks: parts.slice(0, -1), tail: (parts.at(-1) || '') + text.slice(prefix.length) }
}
