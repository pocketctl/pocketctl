import { createHash } from 'crypto'
import { z } from 'zod'
import { CLAIM_TYPES } from '../extraction/schema.js'

/**
 * Versioned policy documents (plan section 6). The API accepts and stores
 * ONLY this validated structure — never arbitrary prompt text. System-owned
 * floors are immutable code; lower layers may narrow but never widen.
 */

/** Immutable, code-owned security floors — never editable below system. */
export const SYSTEM_FLOOR = Object.freeze({
  evidence_min_items: 1,
  evidence_min_distinct_turns: 1,
  max_total_tokens_ceiling: 2000,
  max_items_ceiling: 10,
})

const label = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)

const boundedId = z.string().min(1).max(64)

export const ExtractionPolicyV1 = z.strictObject({
  schema_version: z.literal(1),
  mode: z.enum(['off', 'shadow', 'enabled']),
  focus: z.strictObject({
    claim_types: z.array(z.enum(CLAIM_TYPES as unknown as [string, ...string[]])).max(16),
    include_topics: z.array(label).max(32),
    exclude_topics: z.array(label).max(32),
  }),
  value_filter: z.strictObject({
    min_utility: z.number().min(0).max(1),
    min_repeatability: z.number().min(0).max(1),
    max_friction: z.number().min(0).max(1),
  }),
  evidence: z.strictObject({
    min_items: z.number().int().min(SYSTEM_FLOOR.evidence_min_items).max(12),
    require_terminal_outcome: z.boolean(),
    require_distinct_turns: z.number().int().min(SYSTEM_FLOOR.evidence_min_distinct_turns).max(20),
  }),
  versions: z.strictObject({
    prompt: boundedId,
    extractor: boundedId,
    content_policy: boundedId,
    model_profile: boundedId,
  }),
})
export type ExtractionPolicyDocument = z.infer<typeof ExtractionPolicyV1>

export const ContextPolicyV1 = z.strictObject({
  schema_version: z.literal(1),
  max_total_tokens: z.number().int().min(1).max(SYSTEM_FLOOR.max_total_tokens_ceiling),
  stable_tokens: z.number().int().min(0),
  dynamic_tokens: z.number().int().min(0),
  max_items: z.number().int().min(1).max(SYSTEM_FLOOR.max_items_ceiling),
  allowed_claim_types: z.array(z.enum(CLAIM_TYPES as unknown as [string, ...string[]])).min(1),
  persona_claim_types: z.tuple([z.literal('work_method')]),
  freshness_days: z.record(z.string(), z.number().int().min(1).max(3650)),
  loadout_reserve_tokens: z.number().int().min(0),
  unknown_repository_behavior: z.enum(['persona_only', 'empty']),
  degraded_behavior: z.enum(['metadata_lexical', 'metadata_only', 'empty']),
  render_template_version: boundedId,
  tokenizer_profile: boundedId,
})
export type ContextPolicyDocument = z.infer<typeof ContextPolicyV1>

export const RankingPolicyV1 = z.strictObject({
  schema_version: z.literal(1),
  admission: z.strictObject({
    minimum_vector_similarity: z.number().min(0).max(1),
  }),
  weights: z.strictObject({
    relevance: z.number().min(0).max(1),
    authority: z.number().min(0).max(1),
    freshness: z.number().min(0).max(1),
    scope: z.number().min(0).max(1),
    loadout: z.number().min(0).max(0.4),
  }),
  tie_break: z.tuple([z.literal('version_id')]),
})
export type RankingPolicyDocument = z.infer<typeof RankingPolicyV1>

export type PolicyKind = 'extraction' | 'context' | 'ranking'
export type PolicyLayer = 'system' | 'organization' | 'team' | 'repository' | 'user'
export type AnyPolicyDocument = ExtractionPolicyDocument | ContextPolicyDocument | RankingPolicyDocument

/** Code-owned system policy V1 documents, installed idempotently. */
export const SYSTEM_EXTRACTION_POLICY_V1: ExtractionPolicyDocument = {
  schema_version: 1,
  mode: 'enabled',
  focus: {
    claim_types: [...CLAIM_TYPES] as ExtractionPolicyDocument['focus']['claim_types'],
    include_topics: [],
    exclude_topics: [],
  },
  value_filter: { min_utility: 0, min_repeatability: 0, max_friction: 1 },
  evidence: { min_items: 1, require_terminal_outcome: false, require_distinct_turns: 1 },
  versions: {
    prompt: 'extraction-prompt-v3',
    extractor: 'extraction-v3',
    content_policy: 'extraction-content-v1',
    model_profile: 'default',
  },
}

export const SYSTEM_CONTEXT_POLICY_V1: ContextPolicyDocument = {
  schema_version: 1,
  max_total_tokens: 1000,
  stable_tokens: 300,
  dynamic_tokens: 700,
  max_items: 8,
  allowed_claim_types: [...CLAIM_TYPES] as ContextPolicyDocument['allowed_claim_types'],
  persona_claim_types: ['work_method'],
  freshness_days: {},
  loadout_reserve_tokens: 150,
  unknown_repository_behavior: 'persona_only',
  degraded_behavior: 'metadata_lexical',
  render_template_version: 'context-envelope-v1',
  tokenizer_profile: 'conservative-v1',
}

export const SYSTEM_RANKING_POLICY_V1: RankingPolicyDocument = {
  schema_version: 1,
  // Context injection is precision-first. Metadata is already used for
  // applicability, so a candidate needs lexical evidence or a strong vector
  // match before non-relevance ranking signals may promote it.
  admission: { minimum_vector_similarity: 0.7 },
  weights: { relevance: 0.5, authority: 0.2, freshness: 0.2, scope: 0.1, loadout: 0.1 },
  tie_break: ['version_id'],
}

export function systemPolicyFor(kind: PolicyKind): AnyPolicyDocument {
  if (kind === 'extraction') return SYSTEM_EXTRACTION_POLICY_V1
  if (kind === 'context') return SYSTEM_CONTEXT_POLICY_V1
  return SYSTEM_RANKING_POLICY_V1
}

/** Canonical content hash: stable JSON with sorted keys. */
export function canonicalPolicyHash(document: unknown): Buffer {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return value
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(document)))
    .digest()
}

const MODE_ORDER = { off: 0, shadow: 1, enabled: 2 } as const

/**
 * Monotonic layer merge (ADR-P2-07): a lower layer may only narrow. Modes
 * may only turn down, budgets only shrink, thresholds only rise, friction
 * caps only fall, type lists only lose entries, and the system floors are
 * re-clamped last so no layer can weaken them.
 */
export function mergeExtractionPolicies(
  upper: ExtractionPolicyDocument,
  lower: ExtractionPolicyDocument | null,
): ExtractionPolicyDocument {
  if (!lower) return upper
  return {
    schema_version: 1,
    mode: MODE_ORDER[lower.mode] < MODE_ORDER[upper.mode] ? lower.mode : upper.mode,
    focus: {
      claim_types: lower.focus.claim_types.filter(t => upper.focus.claim_types.includes(t)),
      include_topics: [...new Set([...upper.focus.include_topics, ...lower.focus.include_topics])].slice(0, 32),
      exclude_topics: [...new Set([...upper.focus.exclude_topics, ...lower.focus.exclude_topics])].slice(0, 32),
    },
    value_filter: {
      min_utility: Math.max(upper.value_filter.min_utility, lower.value_filter.min_utility),
      min_repeatability: Math.max(upper.value_filter.min_repeatability, lower.value_filter.min_repeatability),
      max_friction: Math.min(upper.value_filter.max_friction, lower.value_filter.max_friction),
    },
    evidence: {
      min_items: Math.max(upper.evidence.min_items, lower.evidence.min_items),
      require_terminal_outcome: upper.evidence.require_terminal_outcome || lower.evidence.require_terminal_outcome,
      require_distinct_turns: Math.max(upper.evidence.require_distinct_turns, lower.evidence.require_distinct_turns),
    },
    versions: lower.versions,
  }
}

export function mergeContextPolicies(
  upper: ContextPolicyDocument,
  lower: ContextPolicyDocument | null,
): ContextPolicyDocument {
  if (!lower) return upper
  const total = Math.min(upper.max_total_tokens, lower.max_total_tokens)
  const stable = Math.min(upper.stable_tokens, lower.stable_tokens)
  const dynamic = Math.min(upper.dynamic_tokens, lower.dynamic_tokens)
  return {
    schema_version: 1,
    max_total_tokens: total,
    // Section budgets may never exceed the narrowed total.
    stable_tokens: Math.min(stable, total),
    dynamic_tokens: Math.min(dynamic, Math.max(0, total - Math.min(stable, total))),
    max_items: Math.min(upper.max_items, lower.max_items),
    allowed_claim_types: lower.allowed_claim_types.filter(t => upper.allowed_claim_types.includes(t)),
    persona_claim_types: ['work_method'],
    freshness_days: lower.freshness_days,
    loadout_reserve_tokens: Math.min(upper.loadout_reserve_tokens, lower.loadout_reserve_tokens),
    unknown_repository_behavior: lower.unknown_repository_behavior,
    degraded_behavior: lower.degraded_behavior,
    render_template_version: upper.render_template_version,
    tokenizer_profile: upper.tokenizer_profile,
  }
}

export function validatePolicyDocument(kind: PolicyKind, document: unknown):
  { ok: true; document: AnyPolicyDocument } | { ok: false; issues: string[] } {
  const schema = kind === 'extraction' ? ExtractionPolicyV1
    : kind === 'context' ? ContextPolicyV1 : RankingPolicyV1
  const parsed = schema.safeParse(document)
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map(issue => `${issue.path.join('.')}:${issue.code}`) }
  }
  if (kind === 'context') {
    const doc = parsed.data as ContextPolicyDocument
    if (doc.stable_tokens + doc.dynamic_tokens > doc.max_total_tokens) {
      return { ok: false, issues: ['stable+dynamic exceeds max_total_tokens'] }
    }
    if (doc.loadout_reserve_tokens > doc.max_total_tokens) {
      return { ok: false, issues: ['loadout_reserve_tokens exceeds max_total_tokens'] }
    }
  }
  return { ok: true, document: parsed.data }
}

/** Structural JSON diff over validated fields only. */
export function diffPolicyDocuments(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  const entries: Array<{ path: string; before: unknown; after: unknown }> = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const path = prefix ? `${prefix}.${key}` : key
    const a = before[key]
    const b = after[key]
    if (a !== undefined && b !== undefined
      && typeof a === 'object' && a !== null && !Array.isArray(a)
      && typeof b === 'object' && b !== null && !Array.isArray(b)) {
      entries.push(...diffPolicyDocuments(a as Record<string, unknown>, b as Record<string, unknown>, path))
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      entries.push({ path, before: a ?? null, after: b ?? null })
    }
  }
  return entries
}
