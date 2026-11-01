import { getEventListeners } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'
import { parseCodeSnapshotIsolated } from '../codegraph/isolated-parser.js'
import { parseCodeSnapshot } from '../codegraph/typescript-parser.js'

const fixture = new URL('../../fixtures/isolated-parser/worker-fixture.mjs', import.meta.url)
afterEach(() => vi.unstubAllEnvs())

test('real isolated parser preserves deterministic full and incremental graph bytes', async () => {
  const files = [
    { path: 'a.ts', content: 'export function add(a:number,b:number){return a+b}' },
    { path: 'b.ts', content: "import {add} from './a'; export const answer=add(1,2)" },
    { path: '中文.ts', content: 'export const 中文 = 1; export const Ω = 2' },
  ]
  for (const collectPaths of [undefined, new Set(['b.ts'])]) {
    const input = { files, collectPaths }
    expect(await parseCodeSnapshotIsolated(input)).toEqual(parseCodeSnapshot(input))
  }
})

test('CPU-heavy parsing leaves heartbeat timers responsive and does not inherit credentials', async () => {
  vi.stubEnv('CODEGRAPH_TEST_ENV_ONLY', 'parent-only')
  let ticks = 0
  const heartbeat = setInterval(() => ticks++, 10)
  try {
    const result = await parseCodeSnapshotIsolated({ files: [{ path: 'busy', content: '' }] }, { parserModuleUrl: fixture })
    expect(ticks).toBeGreaterThan(3)
    expect(result).toHaveProperty('sawParentEnv', false)
  } finally { clearInterval(heartbeat) }
})

test('a non-yielding parser is terminated at its deadline', async () => {
  const started = Date.now()
  await expect(parseCodeSnapshotIsolated({ files: [{ path: 'hang', content: '' }] }, {
    parserModuleUrl: fixture, timeoutMs: 100,
  })).rejects.toMatchObject({ code: 'timeout', name: 'CodeGraphParseTimeoutError' })
  expect(Date.now() - started).toBeLessThan(2000)
})

test('shutdown abort terminates parsing and releases the abort listener', async () => {
  const controller = new AbortController()
  const result = parseCodeSnapshotIsolated({ files: [{ path: 'hang', content: '' }] }, {
    parserModuleUrl: fixture, signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 50)
  await expect(result).rejects.toMatchObject({ code: 'aborted' })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

test('an already aborted job never starts a parser', async () => {
  const signal = AbortSignal.abort()
  await expect(parseCodeSnapshotIsolated({ files: [] }, {
    signal, parserModuleUrl: new URL('file:///missing-parser.mjs'),
  })).rejects.toMatchObject({ code: 'aborted' })
})

test('parser exceptions do not expose repository text or diagnostics', async () => {
  await expect(parseCodeSnapshotIsolated({ files: [{ path: 'throw', content: '' }] }, {
    parserModuleUrl: fixture,
  })).rejects.toMatchObject({ code: 'failed', message: 'codegraph_parse_failed' })
})

test('a parser heap exhaustion fails the job without killing the runtime', async () => {
  await expect(parseCodeSnapshotIsolated({ files: [{ path: 'memory', content: '' }] }, {
    parserModuleUrl: fixture, heapLimitMb: 16, timeoutMs: 4000,
  })).rejects.toMatchObject({ code: 'memory_limit', name: 'CodeGraphParseMemoryLimitError' })
  await expect(parseCodeSnapshotIsolated({ files: [{ path: 'busy', content: '' }] }, {
    parserModuleUrl: fixture,
  })).resolves.toHaveProperty('contentHash', 'fixture')
})
