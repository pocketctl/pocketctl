import { Worker } from 'node:worker_threads'
import type { ParseInputFile, ParsedGraph } from './typescript-parser.js'
import { JobTerminalError } from '../jobs/types.js'

export interface IsolatedParseInput {
  files: readonly ParseInputFile[]
  parserVersion?: string
  collectPaths?: ReadonlySet<string>
}

export class CodeGraphParseError extends JobTerminalError {
  constructor(readonly code: 'aborted' | 'timeout' | 'memory_limit' | 'failed') {
    super(`codegraph_parse_${code}`)
    this.name = `CodeGraphParse${({ aborted: 'Aborted', timeout: 'Timeout', memory_limit: 'MemoryLimit', failed: 'Failed' } as const)[code]}Error`
  }
}

// Repository source remains data: only the trusted parser module is imported.
// Keep the worker's environment and diagnostics out of the shared runtime.
const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const parser = workerData.loader
    ? await (await import(workerData.loader)).tsImport(workerData.moduleUrl, workerData.moduleUrl)
    : await import(workerData.moduleUrl);
  const graph = parser.parseCodeSnapshot(workerData.input);
  parentPort.postMessage({ ok: true, graph });
})().catch(() => parentPort.postMessage({ ok: false }));
`

/** CPU-heavy parsing must not suspend job leases, projection transactions or metrics. */
export function parseCodeSnapshotIsolated(input: IsolatedParseInput, options: {
  signal?: AbortSignal
  timeoutMs?: number
  heapLimitMb?: number
  /** Trusted test fixture only; never derived from a repository path or request. */
  parserModuleUrl?: URL
} = {}): Promise<ParsedGraph> {
  if (options.signal?.aborted) return Promise.reject(new CodeGraphParseError('aborted'))
  const source = new URL(import.meta.url).pathname.endsWith('.ts')
  const moduleUrl = options.parserModuleUrl ?? new URL(`./typescript-parser.${source ? 'ts' : 'js'}`, import.meta.url)
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(bootstrap, {
        eval: true,
        execArgv: [],
        env: Object.fromEntries(['LANG', 'LC_ALL', 'LC_COLLATE', 'TZ']
          .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: options.heapLimitMb ?? 768, maxYoungGenerationSizeMb: 64 },
        workerData: {
          moduleUrl: moduleUrl.href,
          // Source-mode tests use the installed TS loader; deployed JS has no loader dependency.
          loader: moduleUrl.pathname.endsWith('.ts') ? import.meta.resolve('tsx/esm/api') : undefined,
          input,
        },
      })
    } catch {
      reject(new CodeGraphParseError('failed'))
      return
    }
    worker.stdout?.resume()
    worker.stderr?.resume()
    let settled = false
    async function finish(error?: CodeGraphParseError, graph?: ParsedGraph) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
      // Await termination before settling, including timeout, abort and successful parsing.
      await worker.terminate().catch(() => undefined)
      worker.removeAllListeners()
      if (error) reject(error)
      else resolve(graph!)
    }
    const aborted = () => { void finish(new CodeGraphParseError('aborted')) }
    const timer = setTimeout(() => { void finish(new CodeGraphParseError('timeout')) }, options.timeoutMs ?? 300_000)
    timer.unref()
    worker.on('message', (message: { ok?: boolean; graph?: ParsedGraph }) => {
      void finish(message?.ok && message.graph ? undefined : new CodeGraphParseError('failed'), message?.graph)
    })
    worker.on('error', (error: Error & { code?: string }) => {
      void finish(new CodeGraphParseError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory_limit' : 'failed'))
    })
    worker.on('exit', () => { void finish(new CodeGraphParseError('failed')) })
    options.signal?.addEventListener('abort', aborted, { once: true })
    if (options.signal?.aborted) aborted()
  })
}
