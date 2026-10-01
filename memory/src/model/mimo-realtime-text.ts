import {
  createOpenAICompatibleTextGenerator,
  type OpenAICompatibleTextOptions,
} from './openai-compatible-text.js'
import type { TextGenerator } from '../ports/text-generator.js'

export type MimoRealtimeTextOptions = Omit<OpenAICompatibleTextOptions,
  'apiKeyHeader' | 'maxOutputTokensParameter' | 'thinking' | 'stream' | 'maxAttempts'>

/** One non-streaming MiMo Chat Completions request per budget reservation. */
export function createMimoRealtimeTextGenerator(options: MimoRealtimeTextOptions): TextGenerator {
  return createOpenAICompatibleTextGenerator({
    ...options,
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    apiKeyHeader: 'api-key',
    maxOutputTokensParameter: 'max_completion_tokens',
    thinking: 'disabled',
    stream: false,
    maxAttempts: 1,
  })
}
