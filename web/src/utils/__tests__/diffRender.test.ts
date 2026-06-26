import { describe, test, expect } from 'vitest'
import {
  isDiffTool,
  buildDiffBlocks,
  sumChanges,
  diffFilePath,
} from '../diffRender.js'

describe('isDiffTool', () => {
  test('recognizes Edit/MultiEdit/Write', () => {
    expect(isDiffTool('Edit')).toBe(true)
    expect(isDiffTool('MultiEdit')).toBe(true)
    expect(isDiffTool('Write')).toBe(true)
  })

  test('rejects other tools and falsy values', () => {
    expect(isDiffTool('Read')).toBe(false)
    expect(isDiffTool('Bash')).toBe(false)
    expect(isDiffTool('')).toBe(false)
    expect(isDiffTool(undefined)).toBe(false)
    expect(isDiffTool(null)).toBe(false)
  })
})

describe('buildDiffBlocks — Edit', () => {
  test('single line change flags only the changed line', () => {
    // old and new differ in exactly one line out of three.
    const blocks = buildDiffBlocks(
      { old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      'Edit',
    )
    expect(blocks).toHaveLength(1)
    const lines = blocks[0].lines
    // Expected: ctx(a), del(b), add(B), ctx(c)
    expect(lines.map((l) => l.type)).toEqual(['ctx', 'del', 'add', 'ctx'])
    expect(blocks[0].additions).toBe(1)
    expect(blocks[0].deletions).toBe(1)
  })

  test('dual line numbers advance correctly', () => {
    const blocks = buildDiffBlocks(
      { old_string: 'x\ny', new_string: 'x\nz' },
      'Edit',
    )
    const lines = blocks[0].lines
    // ctx x: old 1, new 1
    expect(lines[0].type).toBe('ctx')
    expect(lines[0].oldLine).toBe(1)
    expect(lines[0].newLine).toBe(1)
    // del y: old 2, new undefined
    expect(lines[1].type).toBe('del')
    expect(lines[1].oldLine).toBe(2)
    expect(lines[1].newLine).toBeUndefined()
    // add z: old undefined, new 2
    expect(lines[2].type).toBe('add')
    expect(lines[2].oldLine).toBeUndefined()
    expect(lines[2].newLine).toBe(2)
  })

  test('identical old/new produces only context lines (no add/del)', () => {
    const blocks = buildDiffBlocks(
      { old_string: 'same\nsame', new_string: 'same\nsame' },
      'Edit',
    )
    expect(blocks[0].additions).toBe(0)
    expect(blocks[0].deletions).toBe(0)
    expect(blocks[0].lines.every((l) => l.type === 'ctx')).toBe(true)
  })

  test('empty old_string → pure addition', () => {
    const blocks = buildDiffBlocks(
      { old_string: '', new_string: 'new\nfile' },
      'Edit',
    )
    expect(blocks[0].lines.every((l) => l.type === 'add')).toBe(true)
    expect(blocks[0].additions).toBe(2)
    expect(blocks[0].deletions).toBe(0)
  })

  test('both empty → no blocks', () => {
    expect(buildDiffBlocks({ old_string: '', new_string: '' }, 'Edit')).toEqual([])
  })
})

describe('buildDiffBlocks — Write', () => {
  test('all lines are additions (green)', () => {
    const blocks = buildDiffBlocks(
      { file_path: 'src/new.ts', content: 'export const a = 1\nexport const b = 2' },
      'Write',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].lines).toHaveLength(2)
    expect(blocks[0].lines.every((l) => l.type === 'add')).toBe(true)
    expect(blocks[0].additions).toBe(2)
    expect(blocks[0].deletions).toBe(0)
    // new-only file: oldLine is undefined for all lines
    expect(blocks[0].lines.every((l) => l.oldLine === undefined)).toBe(true)
  })

  test('empty content → no blocks', () => {
    expect(buildDiffBlocks({ content: '' }, 'Write')).toEqual([])
  })
})

describe('buildDiffBlocks — MultiEdit', () => {
  test('one block per edit, with 1-based index', () => {
    const blocks = buildDiffBlocks(
      {
        edits: [
          { old_string: 'a', new_string: 'A' },
          { old_string: 'b', new_string: 'B' },
        ],
      },
      'MultiEdit',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0].index).toBe(1)
    expect(blocks[1].index).toBe(2)
    expect(blocks[0].additions).toBe(1)
    expect(blocks[0].deletions).toBe(1)
  })

  test('skips malformed edit entries', () => {
    const blocks = buildDiffBlocks(
      { edits: [{ old_string: 'a', new_string: 'A' }, null, { foo: 1 }, { old_string: '', new_string: '' }] },
      'MultiEdit',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].index).toBe(1)
  })
})

describe('buildDiffBlocks — guard clauses', () => {
  test('non-diff tool returns []', () => {
    expect(buildDiffBlocks({ command: 'ls' }, 'Bash')).toEqual([])
  })

  test('null/undefined/non-object input returns []', () => {
    expect(buildDiffBlocks(null, 'Edit')).toEqual([])
    expect(buildDiffBlocks(undefined, 'Edit')).toEqual([])
    expect(buildDiffBlocks('notanobject', 'Edit')).toEqual([])
  })
})

describe('sumChanges', () => {
  test('sums additions and deletions across blocks', () => {
    // jsdiff treats 'c' vs 'c\nd' conservatively (no shared context), so the
    // second edit yields +2 (c, d); first edit yields +1 -1 (A replaces a).
    const blocks = buildDiffBlocks(
      { edits: [{ old_string: 'a\nb', new_string: 'A\nb' }, { old_string: 'c', new_string: 'c\nd' }] },
      'MultiEdit',
    )
    const s = sumChanges(blocks)
    expect(s.additions).toBe(3) // A + (c, d)
    expect(s.deletions).toBe(2) // a + c (jsdiff drops the shared 'c' line)
  })

  test('empty array → zeros', () => {
    expect(sumChanges([])).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('diffFilePath', () => {
  test('reads file_path', () => {
    expect(diffFilePath({ file_path: 'src/x.ts' })).toBe('src/x.ts')
  })

  test('falls back to path', () => {
    expect(diffFilePath({ path: '/abs/y.go' })).toBe('/abs/y.go')
  })

  test('missing → empty string', () => {
    expect(diffFilePath({})).toBe('')
    expect(diffFilePath(null)).toBe('')
  })
})
