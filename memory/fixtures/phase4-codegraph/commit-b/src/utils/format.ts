export function formatLabel(title: string, status: string): string {
  return `[${status}] ${title}`
}

export function parsePriority(raw: string): 1 | 2 {
  return raw === 'high' ? 2 : 1
}
