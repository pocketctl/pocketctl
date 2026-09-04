import { z } from 'zod'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { redactSecrets } from '../episodes/content-policy.js'
import {
  SkillCandidateDocumentSchema, SKILL_MAX_CANDIDATE_CHARS, SKILL_MAX_INPUT_CHARS, SKILL_MAX_SOURCES,
  skillDocumentHash,
} from './types.js'
import type { ResolvedSkillInput } from './source-resolver.js'

const nonempty = z.string().min(1).max(256).refine(value => value.trim().length > 0)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
/** Only the source resolver may construct these facts from the live ledger. */
const SourceSchema = z.object({
  token: nonempty,
  installationId: z.uuid(), repositoryId: z.uuid(), repoSnapshotId: z.uuid(),
  episodeId: z.uuid(), sessionId: nonempty,
  state: z.literal('ready'), outcome: z.literal('completed'),
  sourceDigest: hash, evidenceHandle: nonempty,
  // Episode manifests use a redacted 16-hex excerpt hash; Claim hashes are SHA256.
  excerptHash: z.string().regex(/^(?:[0-9a-f]{16}|[0-9a-f]{64})$/),
  evidenceEligible: z.literal(true), valueVerified: z.literal(true),
}).strict()

const ArchiveInputSchema = z.object({
  installationId: z.uuid(), repositoryId: z.uuid(), repoSnapshotId: z.uuid(), taskId: z.uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  candidateKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  policyVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  document: SkillCandidateDocumentSchema,
  sources: z.array(SourceSchema).min(1).max(SKILL_MAX_SOURCES),
}).strict()

export type SkillArchiveInput = z.infer<typeof ArchiveInputSchema>
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') return redactSecrets(value) !== value
  return value !== null && typeof value === 'object' && Object.values(value).some(containsSecret)
}

/**
 * Pure archive constructor; it does not establish DB authorization or persist
 * content. Task 4's resolver must validate the live source manifest first.
 */
export function buildSkillArchive(raw: SkillArchiveInput) {
  const parsed = ArchiveInputSchema.safeParse(raw)
  if (!parsed.success) throw new Error('skill_archive_invalid')
  const input = parsed.data // Zod deep-copies; caller mutation cannot alter us.
  if (canonicalJsonString(input.document).length > SKILL_MAX_CANDIDATE_CHARS
    || canonicalJsonString(input).length > SKILL_MAX_INPUT_CHARS) throw new Error('skill_archive_size_exceeded')
  if (containsSecret(input)) throw new Error('skill_secret_detected')
  const sourceTokens = new Set(input.sources.map(source => source.token))
  if (new Set(input.sources.map(source => source.evidenceHandle)).size !== input.sources.length) {
    throw new Error('skill_source_evidence_duplicate')
  }
  if (sourceTokens.size !== input.sources.length || sourceTokens.size !== input.document.source_tokens.length
    || input.document.source_tokens.some(token => !sourceTokens.has(token))) throw new Error('skill_source_token_invalid')
  const firstEpisode = input.sources[0]!.episodeId
  const firstSession = input.sources[0]!.sessionId
  const firstDigest = input.sources[0]!.sourceDigest
  for (const source of input.sources) {
    if (source.installationId !== input.installationId || source.repositoryId !== input.repositoryId
      || source.repoSnapshotId !== input.repoSnapshotId || source.episodeId !== firstEpisode
      || source.sessionId !== firstSession || source.sourceDigest !== firstDigest) {
      throw new Error('skill_source_scope_mismatch')
    }
  }
  const payload = { schema_version: 'skill-archive.v1' as const, ...input }
  return freeze({
    ...payload,
    // Includes policy, sources, generation and candidate; no unbound summary.
    inputDigest: canonicalPayloadHash(input).toString('hex'),
    contentHash: canonicalPayloadHash(payload).toString('hex'),
    documentHash: skillDocumentHash(input.document),
  })
}

/** Runtime form built only from source-resolver facts immediately before commit. */
export function buildResolvedSkillArchive(input: {
  source: ResolvedSkillInput; taskId: string; generation: number; candidateKey: string
  policyVersion: string; document: import('./types.js').SkillCandidateDocument
}) {
  const document=SkillCandidateDocumentSchema.parse(input.document)
  const sources=input.source.sources.map(item=>({token:item.token,evidenceHandle:item.handle,
    excerptHash:item.excerptHash,evidenceKind:item.kind,eventId:item.eventId,artifactId:item.artifactId,evidenceId:item.evidenceId}))
  if(input.generation<1||!Number.isSafeInteger(input.generation)||new Set(sources.map(s=>s.token)).size!==sources.length
    ||new Set(sources.map(s=>s.evidenceHandle)).size!==sources.length
    ||document.source_tokens.some(token=>!sources.some(source=>source.token===token))
    ||document.source_tokens.length!==sources.length)throw new Error('skill_archive_invalid')
  if(canonicalJsonString(document).length>SKILL_MAX_CANDIDATE_CHARS||canonicalJsonString({document,sources}).length>SKILL_MAX_INPUT_CHARS)
    throw new Error('skill_archive_size_exceeded')
  if(containsSecret({document,sources}))throw new Error('skill_secret_detected')
  const payload={schema_version:'skill-archive.v1' as const,installationId:input.source.installationId,
    repositoryId:input.source.repositoryId,repoSnapshotId:input.source.repoSnapshotId,
    sourceKind:input.source.kind,episodeId:input.source.episodeId,claimVersionId:input.source.versionId,
    sourceDigest:input.source.sourceDigest,taskId:input.taskId,generation:input.generation,
    candidateKey:input.candidateKey,policyVersion:input.policyVersion,document,sources}
  return freeze({...payload,inputDigest:input.source.inputDigest,contentHash:canonicalPayloadHash(payload).toString('hex'),
    documentHash:skillDocumentHash(document)})
}
