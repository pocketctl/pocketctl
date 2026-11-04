// Conservative preview: containers and reference links wait for final parsing.
// The full source is never modified or truncated.
export function streamingParagraphs(text: string): { blocks: string[]; tail: string } {
  if (text.length > 32000 || /[\[\]`~]|^(?:[ \t]|>|[-+*=]|\d+[.)])/m.test(text)) return { blocks: [], tail: text }
  const parts = text.split(/\n\s*\n/)
  return { blocks: parts.slice(0, -1), tail: parts.at(-1) || '' }
}
