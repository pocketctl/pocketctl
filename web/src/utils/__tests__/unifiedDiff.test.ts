import { describe, expect, test, vi } from 'vitest'
import { parseUnifiedDiffWindow } from '../unifiedDiff'

describe('parseUnifiedDiffWindow', () => {
  test('parses file headers, multiple hunks, and old/new line numbers', () => {
    const diff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@ heading',
      ' same',
      '-old',
      '+new',
      '+next',
      '\\ No newline at end of file',
      '@@ -10 +11 @@',
      '-before',
      '+after',
    ].join('\n')

    expect(parseUnifiedDiffWindow(diff, 0, 50)).toEqual({
      rows: [
        { kind: 'metadata', text: '--- a/a.txt' },
        { kind: 'metadata', text: '+++ b/a.txt' },
        { kind: 'metadata', text: '@@ -1,2 +1,3 @@ heading' },
        { kind: 'context', oldLine: 1, newLine: 1, text: 'same' },
        { kind: 'deletion', oldLine: 2, text: 'old' },
        { kind: 'addition', newLine: 2, text: 'new' },
        { kind: 'addition', newLine: 3, text: 'next' },
        { kind: 'metadata', text: '\\ No newline at end of file' },
        { kind: 'metadata', text: '@@ -10 +11 @@' },
        { kind: 'deletion', oldLine: 10, text: 'before' },
        { kind: 'addition', newLine: 11, text: 'after' },
      ],
      next: 11,
      hasMore: false,
    })
  })

  test('treats create/delete headers using /dev/null as metadata', () => {
    const created = parseUnifiedDiffWindow('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n', 0, 20)
    const deleted = parseUnifiedDiffWindow('--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', 0, 20)

    expect(created.rows).toEqual([
      { kind: 'metadata', text: '--- /dev/null' },
      { kind: 'metadata', text: '+++ b/new.txt' },
      { kind: 'metadata', text: '@@ -0,0 +1 @@' },
      { kind: 'addition', newLine: 1, text: 'new' },
    ])
    expect(deleted.rows.at(-1)).toEqual({ kind: 'deletion', oldLine: 1, text: 'old' })
  })

  test('keeps malformed hunk headers as safe metadata without throwing', () => {
    expect(parseUnifiedDiffWindow('@@ malformed @@\n+not-numbered', 0, 20).rows).toEqual([
      { kind: 'metadata', text: '@@ malformed @@' },
      { kind: 'addition', text: 'not-numbered' },
    ])
  })

  test('returns at most the requested 200-row window and a continuation cursor', () => {
    const diff = ['@@ -1,450 +1,450 @@', ...Array.from({ length: 450 }, (_, index) => ` line-${index}`)].join('\n')

    const first = parseUnifiedDiffWindow(diff, 0, 200)
    const second = parseUnifiedDiffWindow(diff, first.next, 200)
    const third = parseUnifiedDiffWindow(diff, second.next, 200)

    expect(first.rows).toHaveLength(200)
    expect(first).toMatchObject({ next: 200, hasMore: true })
    expect(second.rows).toHaveLength(200)
    expect(second).toMatchObject({ next: 400, hasMore: true })
    expect(third.rows).toHaveLength(51)
    expect(third).toMatchObject({ next: 451, hasMore: false })
    expect(first.rows[1]).toEqual({ kind: 'context', oldLine: 1, newLine: 1, text: 'line-0' })
    expect(second.rows[0]).toEqual({ kind: 'context', oldLine: 200, newLine: 200, text: 'line-199' })
  })

  test('stops parsing after the first row beyond the requested window', () => {
    const diff = ['@@ -1,10000 +1,10000 @@', ...Array.from({ length: 10_000 }, (_, index) => ` line-${index}`)].join('\n')
    const exec = vi.spyOn(RegExp.prototype, 'exec')
    const split = vi.spyOn(String.prototype, 'split')

    const result = parseUnifiedDiffWindow(diff, 0, 200)
    const parsedLineCount = exec.mock.calls.length
    const eagerSplitCount = split.mock.calls.length
    exec.mockRestore()
    split.mockRestore()

    expect(result).toMatchObject({ next: 200, hasMore: true })
    expect(result.rows).toHaveLength(200)
    expect(parsedLineCount).toBe(201)
    expect(eagerSplitCount).toBe(0)
  })
})
