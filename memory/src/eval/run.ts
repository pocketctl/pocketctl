import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { loadMemoryConfig } from '../config.js'
import { createMemoryPool } from '../db.js'
import { createEvalRunner } from './runner.js'
import { GoldenDatasetSchema, type GoldenDataset } from './schema.js'
import { createOpenAICompatibleEmbeddingProvider } from '../model/openai-compatible-embedding.js'

/** CLI: npm run eval -- --dataset <path> --output <report.json> */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const datasetIndex = args.indexOf('--dataset')
  const outputIndex = args.indexOf('--output')
  const datasetPath = datasetIndex >= 0 ? args[datasetIndex + 1] : undefined
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined
  if (!datasetPath || !outputPath) {
    throw new Error('usage: npm run eval -- --dataset <path> --output <report.json>')
  }
  const raw = await readFile(datasetPath, 'utf8')
  const cases = raw.trim().split('\n').map(line => JSON.parse(line))
  const parsed = GoldenDatasetSchema.safeParse({
    schema_version: 1,
    dataset_version: process.env.MEMORY_GOLDEN_SET_VERSION ?? 'unversioned',
    created_at: new Date().toISOString(),
    cases,
  } as GoldenDataset)
  if (!parsed.success) {
    throw new Error(`invalid golden dataset: ${parsed.error.issues.length} issues`)
  }
  const config = loadMemoryConfig()
  const pool = createMemoryPool(config)
  try {
    const runner = createEvalRunner({
      pool,
      recallEmbeddingTimeoutMs: config.recallEmbeddingTimeoutMs,
      cursorSigningKey: config.hmacKey,
      ...(config.embeddingModel ? {
        embeddingConsentFingerprint: createHash('sha256')
          .update(`${config.embeddingModel.provider}\n${config.embeddingModel.baseUrl}\n${config.embeddingModel.model}`)
          .digest('hex'),
        embed: Object.assign(createOpenAICompatibleEmbeddingProvider({
          baseUrl: config.embeddingModel.baseUrl,
          model: config.embeddingModel.model,
          apiKey: config.embeddingModel.apiKey,
          dimensions: config.embeddingModel.dimensions,
          timeoutMs: config.recallEmbeddingTimeoutMs,
        }), {
          provider: config.embeddingModel.provider,
          model: config.embeddingModel.model,
        }),
      } : {}),
    })
    const report = await runner.run(parsed.data)
    await writeFile(outputPath, JSON.stringify(report, null, 2))
    console.log(`golden set evaluated: ${report.totalCases} cases, top5=${report.top5HitRate.toFixed(3)}`)
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('eval failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
