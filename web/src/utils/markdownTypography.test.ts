import { expect, test } from 'vitest'
import { parseMarkdownSegments } from './markdownRenderer'
test('keeps a shorter fence inside four-backtick code', () => {
 const s=parseMarkdownSegments('````md\n```js\nx\n```\n````')
 expect(s).toHaveLength(1); expect(s[0].content).toBe('```js\nx\n```')
})
test('handles tilde code fences',()=>{expect(parseMarkdownSegments('~~~js\nx\n~~~')[0].type).toBe('code')})
test('retains reference definitions across code blocks',()=>{expect(parseMarkdownSegments('[docs][d]\n\n```js\nx\n```\n\n[d]: https://example.com').map(x=>x.html).join('')).toContain('href="https://example.com"')})
test('bounds syntax highlighting work',()=>{expect(parseMarkdownSegments('```js\n'+ 'const x = 1;\n'.repeat(2000)+'```')[0].html).not.toContain('hljs-')})
test('renders task markers as disabled checkboxes',()=>{const html=parseMarkdownSegments('- [x] done\n- [ ] todo').map(x=>x.html).join(''); expect(html).toContain('type="checkbox"');expect(html).toContain('disabled')})
