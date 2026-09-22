import { createHash } from 'node:crypto'
import type { MimoBatchTextSettings, TextAdapterSettings } from '../config.js'
import type { TextGenerator } from '../ports/text-generator.js'

export interface ExtractionTextRoute {
  provider: string
  origin: string
  model: string
  pricing_configured: boolean
  fingerprint: string
  fallback?: {
    provider: string
    origin: string
    model: string
  }
}

/** Shared disclosure/consent identity for the API and worker enforcement. */
export function createExtractionTextRoute(
  preferred: MimoBatchTextSettings | undefined,
  fallback: TextAdapterSettings | undefined,
): ExtractionTextRoute | undefined {
  if (!preferred && !fallback) return undefined
  if (!preferred && fallback) {
    return {
      provider: fallback.provider,
      origin: fallback.baseUrl,
      model: fallback.model,
      pricing_configured: fallback.pricingConfigured,
      fingerprint: createHash('sha256')
        .update(`${fallback.provider}\n${fallback.baseUrl}\n${fallback.model}`)
        .digest('hex'),
    }
  }
  const primary = preferred!
  const identity = [
    `${primary.provider}\n${primary.baseUrl}\n${primary.model}`,
    fallback
      ? `fallback:${fallback.provider}\n${fallback.baseUrl}\n${fallback.model}`
      : 'fallback:none',
  ].join('\n')
  return {
    provider: primary.provider,
    origin: primary.baseUrl,
    model: primary.model,
    pricing_configured: false,
    fingerprint: createHash('sha256').update(identity).digest('hex'),
    ...(fallback ? {
      fallback: {
        provider: fallback.provider,
        origin: fallback.baseUrl,
        model: fallback.model,
      },
    } : {}),
  }
}

/** Fall back only when the preferred provider itself timed out. */
export function withTimeoutFallback(primary: TextGenerator, fallback: TextGenerator): TextGenerator {
  return {
    async generateJson<T>(input: Parameters<TextGenerator['generateJson']>[0]) {
      const result = await primary.generateJson<T>(input)
      if (!result.ok && result.code === 'http_error' && result.detail === 'timeout'
        && !input.signal.aborted) {
        return fallback.generateJson<T>(input)
      }
      return result
    },
  }
}
