import { expect, test } from 'vitest'
import { streamingParagraphs } from './streamingParagraphs'
test('keeps complete paragraphs separate from the active tail',()=>{expect(streamingParagraphs('Hello\n\nWorld')).toEqual({blocks:['Hello'],tail:'World'})})
test('holds reference-dependent and nested content as exact source',()=>{for(const s of ['[a][b]\n\n[b]: /x','- a\n\n  continuation','```js\n\nx','a'.repeat(32001)]) expect(streamingParagraphs(s)).toEqual({blocks:[],tail:s})})
