/**
 * Diff rendering helpers — turn Edit/MultiEdit/Write tool inputs into
 * structured line-level diff data for DiffCard.vue.
 *
 * Data source: the tool_call's `input` field, already transparently passed
 * through from Claude Code's transcript.jsonl (see adapter/claude_jsonl.go).
 * The protocol layer never parses these — we do it here.
 *
 * Uses jsdiff's diffLines for line-level LCS so a single-line change inside a
 * large old_string only flags the changed line, not the whole block.
 */

import { diffLines, type Change } from 'diff'

/** Tools whose input we can render as a line-level diff. */
export const DIFF_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

export function isDiffTool(tool: string | undefined | null): boolean {
  return !!tool && DIFF_TOOLS.has(tool)
}

export type DiffLineType = 'add' | 'del' | 'ctx'

export interface DiffLine {
  type: DiffLineType
  text: string
  /** 1-based line number in the old (pre-change) file. undefined for pure additions. */
  oldLine?: number
  /** 1-based line number in the new (post change) file. undefined for pure deletions. */
  newLine?: number
}

export interface DiffBlock {
  /** For MultiEdit: 1-based edit index. For Edit/Write: undefined. */
  index?: number
  lines: DiffLine[]
  additions: number
  deletions: number
}

/** Hard cap to keep rendering fast on pathological inputs. */
const MAX_DIFF_LINES = 4000

/**
 * Split a part's value (which may contain multiple \n-separated lines) into
 * individual DiffLine entries with the right type, advancing old/new counters.
 */
function pushPart(
  part: Change,
  lines: DiffLine[],
  counters: { old: number; new: number },
): void {
  // diffLines keeps trailing newlines inside value; trim the final one so we
  // don't emit a phantom empty line.
  const raw = part.value.replace(/\n$/, '')
  if (raw === '') return
  for (const text of raw.split('\n')) {
    if (part.added) {
      counters.new += 1
      lines.push({ type: 'add', text, newLine: counters.new })
    } else if (part.removed) {
      counters.old += 1
      lines.push({ type: 'del', text, oldLine: counters.old })
    } else {
      counters.old += 1
      counters.new += 1
      lines.push({ type: 'ctx', text, oldLine: counters.old, newLine: counters.new })
    }
  }
}

/** Compute a single diff block from an old/new pair. */
function diffPair(oldStr: string, newStr: string, index?: number): DiffBlock {
  const lines: DiffLine[] = []
  const counters = { old: 0, new: 0 }
  let additions = 0
  let deletions = 0

  for (const part of diffLines(oldStr, newStr)) {
    pushPart(part, lines, counters)
    if (part.added) additions += part.count ?? 0
    else if (part.removed) deletions += part.count ?? 0
    if (lines.length > MAX_DIFF_LINES) break
  }

  return { index, lines, additions, deletions }
}

/** Treat content with no old version as a pure addition (all green). */
function addedBlock(content: string, index?: number): DiffBlock {
  const lines: DiffLine[] = []
  const counters = { new: 0 }
  for (const text of content.replace(/\n$/, '').split('\n')) {
    counters.new += 1
    lines.push({ type: 'add', text, newLine: counters.new })
    if (lines.length > MAX_DIFF_LINES) break
  }
  return { index, lines, additions: lines.length, deletions: 0 }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Build one or more diff blocks from a tool_call input.
 *
 * - Edit: single block from old_string → new_string
 * - Write: single all-addition block from content (new file)
 * - MultiEdit: one block per entry in edits[]
 * - Anything else / malformed input: returns []
 */
export function buildDiffBlocks(input: any, tool: string): DiffBlock[] {
  if (!input || typeof input !== 'object') return []

  if (tool === 'Edit') {
    const oldStr = asString(input.old_string)
    const newStr = asString(input.new_string)
    if (!oldStr && !newStr) return []
    return [diffPair(oldStr, newStr)]
  }

  if (tool === 'Write') {
    const content = asString(input.content)
    if (!content) return []
    return [addedBlock(content)]
  }

  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const blocks: DiffBlock[] = []
    edits.forEach((e: any, i: number) => {
      if (!e || typeof e !== 'object') return
      const oldStr = asString(e.old_string)
      const newStr = asString(e.new_string)
      if (!oldStr && !newStr) return
      blocks.push(diffPair(oldStr, newStr, i + 1))
    })
    return blocks
  }

  return []
}

/** Total additions/deletions across all blocks (for header summary). */
export function sumChanges(blocks: DiffBlock[]): { additions: number; deletions: number } {
  return blocks.reduce(
    (acc, b) => ({ additions: acc.additions + b.additions, deletions: acc.deletions + b.deletions }),
    { additions: 0, deletions: 0 },
  )
}

/**
 * Best-effort file path extraction from input (for the card header).
 * Mirrors toolDisplay.formatToolInput's Edit/Write handling.
 */
export function diffFilePath(input: any): string {
  if (!input || typeof input !== 'object') return ''
  return input.file_path || input.path || ''
}
