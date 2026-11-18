import { expect, test } from 'vitest'
import { streamingParagraphs } from './streamingParagraphs'
test('keeps complete paragraphs separate from the active tail',()=>{expect(streamingParagraphs('Hello\n\nWorld')).toEqual({blocks:['Hello'],tail:'World'})})
test('holds reference-dependent and nested content as exact source',()=>{for(const s of ['[a][b]\n\n[b]: /x','- a\n\n  continuation','```js\n\nx','a'.repeat(32001)]) expect(streamingParagraphs(s)).toEqual({blocks:[],tail:s})})

test('keeps completed preview blocks stable when the 32k scan budget is crossed', () => {
  const prefix = 'Stable **paragraph**\n\n'
  const before = prefix + 'x'.repeat(32000 - prefix.length)
  const atLimit = streamingParagraphs(before)
  const after = streamingParagraphs(before + 'y\n\n[reference]: /later')
  expect(atLimit.blocks).toEqual(['Stable **paragraph**'])
  expect(after.blocks).toEqual(atLimit.blocks)
  expect(after.tail).toBe(atLimit.tail + 'y\n\n[reference]: /later')
})
test('retains a paragraph crossing the budget as exact plain tail', () => {
  const text = 'first\n\n' + 'x'.repeat(33000) + '\n\nlast'
  expect(streamingParagraphs(text)).toEqual({ blocks: ['first'], tail: text.slice(7) })
  const complex = '> quote\n\n' + 'x'.repeat(33000)
  expect(streamingParagraphs(complex)).toEqual({ blocks: [], tail: complex })
})

test('does not split Unicode when the scan budget lands inside a surrogate pair', () => {
  const text = 'first\n\n' + 'x'.repeat(31992) + '🧑‍💻 Chinese 中文 tail'
  expect(streamingParagraphs(text)).toEqual({ blocks: ['first'], tail: text.slice(7) })
})
