export type UnifiedDiffLineKind = 'context' | 'addition' | 'deletion' | 'metadata'

export interface UnifiedDiffRow {
  kind: UnifiedDiffLineKind
  oldLine?: number
  newLine?: number
  text: string
}

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/

function* linesUntilStopped(content: string): Generator<string> {
  let offset = 0
  while (offset < content.length) {
    const newline = content.indexOf('\n', offset)
    if (newline < 0) {
      yield content.slice(offset)
      return
    }
    yield content.slice(offset, newline)
    offset = newline + 1
  }
}

export function parseUnifiedDiffWindow(
  diff: string,
  start: number,
  limit: number,
): { rows: UnifiedDiffRow[]; next: number; hasMore: boolean } {
  const safeStart = Math.max(0, Math.floor(start) || 0)
  const safeLimit = Math.max(0, Math.floor(limit) || 0)
  const rows: UnifiedDiffRow[] = []
  let rendered = 0
  let oldLine: number | undefined
  let newLine: number | undefined
  let hasMore = false

  for (const line of linesUntilStopped(diff)) {
    let row: UnifiedDiffRow
    const match = hunkHeader.exec(line)
    if (match) {
      oldLine = Number(match[1])
      newLine = Number(match[2])
      row = { kind: 'metadata', text: line }
    } else if (line.startsWith('@@') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\')) {
      row = { kind: 'metadata', text: line }
    } else if (line.startsWith('+')) {
      row = { kind: 'addition', ...(newLine === undefined ? {} : { newLine }), text: line.slice(1) }
      if (newLine !== undefined) newLine += 1
    } else if (line.startsWith('-')) {
      row = { kind: 'deletion', ...(oldLine === undefined ? {} : { oldLine }), text: line.slice(1) }
      if (oldLine !== undefined) oldLine += 1
    } else if (line.startsWith(' ')) {
      row = {
        kind: 'context',
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
        text: line.slice(1),
      }
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
    } else {
      row = { kind: 'metadata', text: line }
    }

    if (rendered >= safeStart) {
      if (rows.length < safeLimit) rows.push(row)
      else {
        hasMore = true
        break
      }
    }
    rendered += 1
  }

  const next = safeStart + rows.length
  return { rows, next, hasMore }
}
