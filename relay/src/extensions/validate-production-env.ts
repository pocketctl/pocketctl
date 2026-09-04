import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolveExtensionRateLimitConfig } from '../runtime-config.js'
import { resolveGrantKeyMaterial } from './capability-grant.js'
import { resolveExtensionConfig } from './config.js'

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse the unquoted KEY=value format emitted by the deployment helper. */
export function parseSystemdEnvironmentFile(contents: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    const name = separator === -1 ? '' : line.slice(0, separator)
    if (!ENV_NAME.test(name)) {
      throw new Error(`invalid EnvironmentFile entry at line ${index + 1}`)
    }
    if (Object.hasOwn(env, name)) {
      throw new Error(`duplicate EnvironmentFile entry: ${name}`)
    }
    env[name] = line.slice(separator + 1)
  }
  return env
}

/**
 * Execute the same extension config, rate-limit, and RSA pair validation used
 * by Relay startup. This is intentionally side-effect free and returns no
 * secret material, so deploy can fail before database or service mutation.
 */
export function validateExtensionProductionEnvironment(
  env: Record<string, string | undefined>,
): void {
  const config = resolveExtensionConfig(env)
  resolveExtensionRateLimitConfig(env)
  resolveGrantKeyMaterial(env, {
    strictProduction: env.NODE_ENV === 'production' && config.mode === 'enabled',
  })
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) {
    throw new Error('usage: validate-production-env <EnvironmentFile>')
  }
  const env = parseSystemdEnvironmentFile(await readFile(path, 'utf8'))
  validateExtensionProductionEnvironment(env)
  console.log('Relay extension production environment is valid')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error('[extension-env-validation] failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : 'unknown validation error',
    })
    process.exitCode = 1
  })
}
