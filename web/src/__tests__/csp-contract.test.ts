import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

// M-8: the built SPA must contain no executable inline script and no inline
// event handlers, so every production CSP can ship script-src 'self'.

const webRoot = resolve(__dirname, '../..')
const distIndex = resolve(webRoot, 'dist/index.html')
const distBootstrap = resolve(webRoot, 'dist/bootstrap.js')

beforeAll(() => {
  execSync('npm run build', { cwd: webRoot, stdio: 'pipe', timeout: 240_000 })
}, 300_000)

describe('built artifact CSP contract (M-8)', () => {
  test('dist/index.html exists after the build', () => {
    expect(existsSync(distIndex)).toBe(true)
  })

  test('index.html contains no executable inline script', () => {
    const html = readFileSync(distIndex, 'utf8')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    expect(scripts.length).toBeGreaterThan(0)
    for (const match of scripts) {
      const attrs = match[1]
      const body = match[2]
      const hasSrc = /\bsrc\s*=/i.test(attrs)
      const isDataOnly = /\btype\s*=\s*["']?(application\/json|application\/ld\+json|importmap|speculationrules)/i.test(attrs)
      if (!hasSrc && !isDataOnly) {
        throw new Error(`src-less executable <script> found in dist/index.html: ${(body || '').slice(0, 80)}`)
      }
    }
  })

  test('index.html declares no inline event handlers', () => {
    const html = readFileSync(distIndex, 'utf8')
    const handlers = html.match(/\son[a-z]+\s*=\s*["'][^"']*["']/gi)
    expect(handlers).toBeNull()
  })

  test('bootstrap.js is a same-origin external script loaded before the bundle', () => {
    const html = readFileSync(distIndex, 'utf8')
    expect(existsSync(distBootstrap)).toBe(true)
    const bootstrapPos = html.search(/<script[^>]+src="[^"]*\/app\/bootstrap\.js"/)
    const bundlePos = html.search(/<script[^>]+type="module"/)
    expect(bootstrapPos).toBeGreaterThan(-1)
    expect(bundlePos).toBeGreaterThan(bootstrapPos)
  })

  test('bootstrap.js contains the theme pre-init and relay URL derivation, without eval or query parsing', () => {
    const js = readFileSync(distBootstrap, 'utf8')
    expect(js).toContain('pocketctl-theme')
    expect(js).toContain('__RELAY_WS__')
    expect(js).toContain('__APP_BASE__')
    expect(js).not.toMatch(/\beval\s*\(/)
    expect(js).not.toMatch(/new\s+Function\s*\(/)
    expect(js).not.toContain('document.write')
    expect(js).not.toContain('location.search')
    expect(js).not.toContain('URLSearchParams')
    expect(js).not.toMatch(/document\.createElement\(\s*['"]script/)
  })
})
