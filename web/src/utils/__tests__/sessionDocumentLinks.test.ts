import { describe, expect, test } from 'vitest'
import { localDocumentPath, rewriteSessionDocumentLinks } from '../sessionDocumentLinks'
import { parseMarkdownSegments } from '../markdownRenderer'

describe('session document links', () => {
  test('recognizes local generated documents without treating web URLs as files', () => {
    expect(localDocumentPath('/Volumes/DevDisc/repo/report.html')).toBe('/Volumes/DevDisc/repo/report.html')
    expect(localDocumentPath('docs/my%20report.md#L12')).toBe('docs/my report.md')
    expect(localDocumentPath('file:///home/test/report.html')).toBe('/home/test/report.html')
    for (const value of ['https://example.com/report.html', '//example.com/report.html', 'file://remote/report.html', '#report.html', 'javascript:report.html', '/tmp/a.txt', '/tmp/%00.html']) expect(localDocumentPath(value)).toBeNull()
  })
  test('rewrites the reported absolute link while preserving external links and safe attributes', () => {
    const segments = parseMarkdownSegments('[Report](/Volumes/DevDisc/repo/report.html) [External](https://example.com/report.html)')
    const sanitized = segments[0]!.html.replace('<a ', '<a rel="noopener noreferrer" target="_blank" ')
    const output = rewriteSessionDocumentLinks(sanitized, path => '/app/session/s/documents/open#path=' + encodeURIComponent(path))
    const template = document.createElement('template'); template.innerHTML = output
    const links = template.content.querySelectorAll('a')
    expect(links[0]!.getAttribute('href')).toBe('/app/session/s/documents/open#path=%2FVolumes%2FDevDisc%2Frepo%2Freport.html')
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(links[1]!.getAttribute('href')).toBe('https://example.com/report.html')
  })
})
