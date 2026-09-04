import { z } from 'zod'
import { CLAIM_TYPES, SCOPE_KINDS, StructuredContentSchema } from '../extraction/schema.js'
import { SkillCandidateDocumentSchema, SKILL_MAX_CANDIDATE_CHARS, SKILL_STATES } from '../skills/types.js'
import { WIKI_MAX_PAGES, WIKI_MAX_SECTIONS, WIKI_MAX_SOURCE_CHARS } from '../wiki/types.js'

export const GIT_SCHEMA_VERSION = 'memory-git.v1' as const
export const ASSET_KINDS = ['claim', 'rule', 'wiki', 'skill'] as const
export type AssetKind = typeof ASSET_KINDS[number]
export type Digest = string
export interface AssetKey { kind: AssetKind; id: string }
export interface RepositoryFile { path: string; mode: '100644'; bytes: Uint8Array }

export const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => BigInt(value) <= 9223372036854775807n)
const positiveRevision = RevisionSchema.refine(value => value !== '0')
const id = z.uuid().refine(value => value === value.toLowerCase())
const text = (max: number) => z.string().min(1).max(max)
const timestamp = z.iso.datetime()
const ownerKind = z.enum(['personal', 'team', 'organization'])
const jsonValue = z.json()
const jsonObject = z.record(z.string(), jsonValue)

export const EvidenceReferenceSchema = z.object({
  evidenceId: id, versionId: id, hash: DigestSchema, kind: z.enum(['event', 'artifact', 'episode']),
  ordinal: z.number().int().min(0).max(63), visibility: z.literal('shared'),
}).strict()
const evidence = z.array(EvidenceReferenceSchema).min(1).max(64)
  .refine(rows => new Set(rows.map(row => row.evidenceId)).size === rows.length)
const identity = {
  installationId: id, ownerScopeKind: ownerKind, ownerScopeId: id, evidence,
}
const common = {
  schemaVersion: z.literal(GIT_SCHEMA_VERSION), path: text(512), connectionId: id, exportId: id,
  baseVersionId: id, baseRevision: positiveRevision, sourceDigest: DigestSchema,
}
const times = { createdAt: timestamp, updatedAt: timestamp }
const evidencePrivate = z.object({
  evidenceId: id, episodeId: id, sourceEventId: id.nullable(), artifactId: id.nullable(),
  locator: jsonObject, excerpt: text(4000), occurredAt: timestamp, createdAt: timestamp,
  sourceEvidenceHash: DigestSchema.nullable(), contributorMembershipId: id.nullable(),
}).strict()
const claimImmutable = z.object({
  ...identity, claimType: z.enum(CLAIM_TYPES), versionNumber: z.number().int().positive(),
  state: z.enum(['active', 'superseded', 'expired', 'revoked']),
  authority: z.enum(['user_accepted', 'user_corrected', 'team_reviewed', 'team_published', 'organization_reviewed', 'organization_published']),
  confidence: z.string().regex(/^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/),
  freshnessAt: timestamp.nullable(), validFrom: timestamp.nullable(), validUntil: timestamp.nullable(),
}).strict()
const claimEditable = z.object({ statement: text(4000), structuredContent: StructuredContentSchema }).strict()
const claimServer = z.object({
  scopeKind: z.enum(SCOPE_KINDS), scopeKey: text(512), normalizedKey: text(4000),
  repositoryId: id.nullable(), repoSnapshotId: id.nullable(), branch: text(255).nullable(),
  sourceCandidateId: id.nullable(), supersededByClaimId: id.nullable(), ...times,
  sourcePromotionCandidateId: id.nullable(), conflictGroupId: id.nullable(), conflictVariant: z.number().int().nonnegative(),
  claimCreatedAt: timestamp,
  evidence: z.array(evidencePrivate).max(64),
}).strict()
export const ClaimAssetSchema = z.object({
  ...common, key: z.object({ kind: z.literal('claim'), id }).strict(),
  immutable: claimImmutable, editable: claimEditable, serverOnly: claimServer,
}).strict()
export const RuleAssetSchema = z.object({
  ...common, key: z.object({ kind: z.literal('rule'), id }).strict(),
  immutable: claimImmutable.extend({ claimType: z.enum(['repository_convention', 'test_invariant']) }),
  editable: claimEditable, serverOnly: claimServer,
}).strict()

const skillImmutable = z.object({
  ...identity, versionNumber: z.number().int().positive(), state: z.enum(SKILL_STATES),
  risk: z.enum(['low', 'high', 'unknown']), policyHash: DigestSchema, documentHash: DigestSchema,
  archiveContentHash: DigestSchema, replayRunId: id.nullable(),
  replayState: z.enum(['not_run', 'queued', 'running', 'passed', 'failed', 'cancelled', 'stale']),
  publicationState: z.enum(['active', 'disabled']), publicationRevision: RevisionSchema,
  publishedVersionId: id.nullable(),
}).strict()
const skillEditable = z.object({ document: SkillCandidateDocumentSchema
  .refine(document => JSON.stringify(document).length <= SKILL_MAX_CANDIDATE_CHARS) }).strict()
const skillServer = z.object({
  taskId: id, candidateId: id, archiveId: id, policySnapshot: jsonObject,
  authorKind: z.enum(['personal', 'membership']), authorId: id, authorizationEpoch: positiveRevision, ...times,
  skillCreatedAt: timestamp, previousPublishedVersionId: id.nullable(), publicationEventId: id.nullable(),
  publicationUpdatedAt: timestamp.nullable(),
  editableHeadVersionId: id, editableHeadRevision: positiveRevision, editableHeadState: z.enum(SKILL_STATES),
}).strict()
export const SkillAssetSchema = z.object({
  ...common, key: z.object({ kind: z.literal('skill'), id }).strict(),
  immutable: skillImmutable, editable: skillEditable, serverOnly: skillServer,
}).strict()

export const WikiSourceBindingSchema = z.object({
  bindingId: id, sourceKind: z.enum(['file', 'symbol', 'claim_version', 'evidence']),
  sourceToken: text(256), sourceSnapshotId: id.nullable(), commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  createdAt: timestamp,
}).strict()
const wikiSectionImmutable = z.object({
  sectionId: id, authority: z.enum(['generated', 'manual', 'locked']), generatedVersionId: id,
  manualVersionId: id.nullable(), lockVersion: RevisionSchema,
  position: z.number().int().nonnegative(),
  sourceBindings: z.array(WikiSourceBindingSchema).max(64),
}).strict().refine(section => section.authority === 'generated'
  ? section.sourceBindings.length > 0
  : section.manualVersionId !== null)
const wikiPageImmutable = z.object({
  pageId: id, pageKey: text(128), position: z.number().int().nonnegative(), sections: z.array(wikiSectionImmutable).min(1).max(WIKI_MAX_SECTIONS),
}).strict()
const wikiImmutable = z.object({
  ...identity, evidence: z.array(EvidenceReferenceSchema).max(64), state: z.enum(['active', 'superseded', 'purged']),
  generatedVersionId: id, generatedRevision: positiveRevision, pages: z.array(wikiPageImmutable).min(1).max(WIKI_MAX_PAGES),
}).strict()
export const WikiEditableSectionSchema = z.object({
  sectionId: id, sectionKey: text(128), heading: text(200), markdown: z.string().max(WIKI_MAX_SOURCE_CHARS),
  coverage: z.enum(['complete', 'partial', 'unsupported', 'degraded']),
}).strict()
export const WikiEditablePageSchema = z.object({
  pageId: id, title: text(200), sections: z.array(WikiEditableSectionSchema).min(1).max(WIKI_MAX_SECTIONS),
}).strict()
const wikiEditable = z.object({ pages: z.array(WikiEditablePageSchema).min(1).max(WIKI_MAX_PAGES) }).strict()
const wikiManualVersion = z.object({
  manualVersionId: id, sectionKey: text(128), markdown: z.string().max(WIKI_MAX_SOURCE_CHARS), contentHash: DigestSchema,
  actorScopeKind: ownerKind, actorScopeId: id, reasonCode: text(64).nullable(), previousVersionId: id.nullable(), createdAt: timestamp,
}).strict()
const wikiServer = z.object({
  repositoryId: id, sourceSnapshotId: id, graphVersionId: id, buildRunId: id.nullable(), contentHash: DigestSchema,
  ...times, manualVersions: z.array(wikiManualVersion).max(WIKI_MAX_SECTIONS),
  generation: RevisionSchema, wikiCreatedAt: timestamp, wikiUpdatedAt: timestamp,
  manualHeads: z.array(z.object({ sectionKey: text(128), currentVersionId: id, locked: z.boolean(),
    lockVersion: RevisionSchema, updatedAt: timestamp }).strict()).max(WIKI_MAX_SECTIONS),
}).strict()
export const WikiAssetSchema = z.object({
  ...common, key: z.object({ kind: z.literal('wiki'), id }).strict(),
  immutable: wikiImmutable, editable: wikiEditable, serverOnly: wikiServer,
}).strict().superRefine((asset, context) => {
  const pages = asset.editable.pages
  const sections = pages.flatMap(page => page.sections)
  const unique = (values: string[]) => new Set(values).size === values.length
  if (sections.length > WIKI_MAX_SECTIONS || sections.reduce((sum, section) => sum + section.markdown.length, 0) > WIKI_MAX_SOURCE_CHARS
    || !unique(pages.map(page => page.pageId)) || !unique(sections.map(section => section.sectionId))
    || !unique(sections.map(section => section.sectionKey))
    || !unique(asset.immutable.pages.map(page => page.pageKey))) {
    context.addIssue({ code: 'custom', message: 'wiki_structure_invalid' })
  }
  if (pages.length !== asset.immutable.pages.length) context.addIssue({ code: 'custom', message: 'wiki_structure_invalid' })
  pages.forEach((page, index) => {
    const origin = asset.immutable.pages[index]
    if (!origin || page.pageId !== origin.pageId || page.sections.length !== origin.sections.length
      || page.sections.some((section, i) => section.sectionId !== origin.sections[i]?.sectionId)) {
      context.addIssue({ code: 'custom', message: 'wiki_structure_invalid' })
    }
  })
})

/** The nested key discriminator avoids a second, independently forgeable kind. */
export const PortableAssetSchema = z.union([ClaimAssetSchema, RuleAssetSchema, WikiAssetSchema, SkillAssetSchema])
export type PortableAsset = z.infer<typeof PortableAssetSchema>
export type ClaimAsset = z.infer<typeof ClaimAssetSchema>
export type RuleAsset = z.infer<typeof RuleAssetSchema>
export type WikiAsset = z.infer<typeof WikiAssetSchema>
export type SkillAsset = z.infer<typeof SkillAssetSchema>
export interface AssetSnapshot { asset: PortableAsset; contentHash: Digest; deleted: boolean }
export interface FieldConflict { field: string; reason: 'both_modified' | 'delete_edit' | 'rename_collision' | 'locked' }
export type MergeResult = { kind: 'noop' | 'export' | 'proposal'; asset: AssetSnapshot }
  | { kind: 'conflict'; conflicts: FieldConflict[] }
export interface ExportBundle {
  exportId: string; connectionId: string; generation: string; baseCommit: string
  installationId: string; repositoryId: string; tombstoneGeneration: string
  purpose: 'local_preview' | 'external_export'; publishable: boolean
  assets: AssetSnapshot[]; files: RepositoryFile[]; attestation: Uint8Array
}

/** Every mapped field inherits its category recursively. Source tokens inside a
 * Skill document are additionally bound to the baseline by the codec. Each
 * schema lists all accepted fields, including nullable and server-only values.
 * Nothing omitted on the wire is ever filled with a domain default. */
function fields(shape: z.ZodRawShape, authority: 'immutable' | 'editable' | 'server-only') {
  return Object.fromEntries(Object.keys(shape).map(key => [key, authority]))
}
function mapping(immutable: z.ZodRawShape, editable: z.ZodRawShape, serverOnly: z.ZodRawShape) {
  return { immutable: fields(immutable, 'immutable'), editable: fields(editable, 'editable'), serverOnly: fields(serverOnly, 'server-only') }
}
export const FIELD_MAPPING = {
  claim: mapping(claimImmutable.shape, claimEditable.shape, claimServer.shape),
  rule: mapping(claimImmutable.shape, claimEditable.shape, claimServer.shape),
  wiki: mapping(wikiImmutable.shape, wikiEditable.shape, wikiServer.shape),
  skill: mapping(skillImmutable.shape, skillEditable.shape, skillServer.shape),
} as const

/** Existing domain row columns, including fields projected from joins. Child
 * source/evidence rows have their own mapping; duplicate FK columns inherit the
 * parent immutable identity. Row materialization/eligibility belongs to the
 * authorized Ledger reader, not this pure codec. */
export const DOMAIN_FIELD_MAPPING = {
  knowledge_claims: {
    claim_id: 'key.id', installation_id: 'immutable.installationId', claim_type: 'immutable.claimType',
    scope_kind: 'serverOnly.scopeKind', scope_key: 'serverOnly.scopeKey', normalized_key: 'serverOnly.normalizedKey',
    state: 'immutable.state', current_version_id: 'baseVersionId', superseded_by_claim_id: 'serverOnly.supersededByClaimId',
    revision: 'baseRevision', created_at: 'serverOnly.claimCreatedAt', updated_at: 'serverOnly.updatedAt',
    owner_scope_kind: 'immutable.ownerScopeKind', owner_scope_id: 'immutable.ownerScopeId',
    conflict_group_id: 'serverOnly.conflictGroupId', conflict_variant: 'serverOnly.conflictVariant',
  },
  knowledge_versions: {
    version_id: 'baseVersionId', installation_id: 'immutable.installationId', claim_id: 'key.id',
    version_number: 'immutable.versionNumber', statement: 'editable.statement', structured_content: 'editable.structuredContent',
    authority: 'immutable.authority', confidence: 'immutable.confidence', repository_id: 'serverOnly.repositoryId',
    repo_snapshot_id: 'serverOnly.repoSnapshotId', branch: 'serverOnly.branch', valid_from: 'immutable.validFrom',
    valid_until: 'immutable.validUntil', freshness_at: 'immutable.freshnessAt', source_candidate_id: 'serverOnly.sourceCandidateId',
    created_at: 'serverOnly.createdAt',
    source_promotion_candidate_id: 'serverOnly.sourcePromotionCandidateId',
  },
  knowledge_evidence: {
    evidence_id: 'immutable.evidence[].evidenceId', installation_id: 'immutable.installationId', version_id: 'immutable.evidence[].versionId',
    evidence_kind: 'immutable.evidence[].kind', excerpt_hash: 'immutable.evidence[].hash', ordinal: 'immutable.evidence[].ordinal',
    visibility: 'immutable.evidence[].visibility', episode_id: 'serverOnly.evidence[].episodeId',
    source_event_id: 'serverOnly.evidence[].sourceEventId', artifact_id: 'serverOnly.evidence[].artifactId',
    locator: 'serverOnly.evidence[].locator', excerpt: 'serverOnly.evidence[].excerpt',
    occurred_at: 'serverOnly.evidence[].occurredAt', created_at: 'serverOnly.evidence[].createdAt',
    source_evidence_hash: 'serverOnly.evidence[].sourceEvidenceHash', contributor_membership_id: 'serverOnly.evidence[].contributorMembershipId',
  },
  memory_skills: {
    skill_id: 'key.id', installation_id: 'immutable.installationId', task_id: 'serverOnly.taskId', created_at: 'serverOnly.skillCreatedAt',
  },
  memory_skill_versions: {
    version_id: 'baseVersionId', installation_id: 'immutable.installationId', skill_id: 'key.id', version_number: 'immutable.versionNumber',
    candidate_id: 'serverOnly.candidateId', archive_id: 'serverOnly.archiveId', document: 'editable.document',
    document_hash: 'immutable.documentHash', source_digest: 'sourceDigest', archive_content_hash: 'immutable.archiveContentHash',
    policy_snapshot: 'serverOnly.policySnapshot', policy_hash: 'immutable.policyHash', risk: 'immutable.risk',
    author_kind: 'serverOnly.authorKind', author_id: 'serverOnly.authorId', authorization_epoch: 'serverOnly.authorizationEpoch',
    created_at: 'serverOnly.createdAt',
  },
  memory_skill_heads: {
    installation_id: 'immutable.installationId', skill_id: 'key.id', current_version_id: 'serverOnly.editableHeadVersionId', revision: 'serverOnly.editableHeadRevision',
    state: 'serverOnly.editableHeadState', updated_at: 'serverOnly.updatedAt',
  },
  memory_skill_publication_heads: {
    installation_id: 'immutable.installationId', skill_id: 'key.id', current_version_id: 'immutable.publishedVersionId',
    previous_version_id: 'serverOnly.previousPublishedVersionId', revision: 'immutable.publicationRevision', state: 'immutable.publicationState',
    publication_event_id: 'serverOnly.publicationEventId', updated_at: 'serverOnly.publicationUpdatedAt',
  },
  memory_wikis: {
    wiki_id: 'key.id', installation_id: 'immutable.installationId', repository_id: 'serverOnly.repositoryId', generation: 'serverOnly.generation',
    created_at: 'serverOnly.wikiCreatedAt', updated_at: 'serverOnly.wikiUpdatedAt', state: 'immutable.state',
  },
  memory_wiki_versions: {
    wiki_version_id: 'immutable.generatedVersionId', installation_id: 'immutable.installationId', wiki_id: 'key.id',
    revision: 'immutable.generatedRevision', source_snapshot_id: 'serverOnly.sourceSnapshotId', graph_version_id: 'serverOnly.graphVersionId',
    build_run_id: 'serverOnly.buildRunId', state: 'immutable.state', content_hash: 'serverOnly.contentHash', created_at: 'serverOnly.createdAt',
  },
  memory_wiki_heads: {
    installation_id: 'immutable.installationId', repository_id: 'serverOnly.repositoryId', wiki_id: 'key.id', active_version_id: 'baseVersionId',
    revision: 'baseRevision', updated_at: 'serverOnly.updatedAt',
  },
  memory_wiki_pages: {
    wiki_version_id: 'immutable.generatedVersionId', installation_id: 'immutable.installationId', page_id: 'immutable.pages[].pageId',
    page_key: 'immutable.pages[].pageKey', title: 'editable.pages[].title', position: 'immutable.pages[].position',
  },
  memory_wiki_sections: {
    wiki_version_id: 'immutable.generatedVersionId', installation_id: 'immutable.installationId', section_id: 'immutable.pages[].sections[].sectionId',
    page_id: 'immutable.pages[].pageId', section_key: 'editable.pages[].sections[].sectionKey', heading: 'editable.pages[].sections[].heading',
    markdown: 'editable.pages[].sections[].markdown', authority: 'immutable.pages[].sections[].authority',
    coverage: 'editable.pages[].sections[].coverage', position: 'immutable.pages[].sections[].position',
  },
  memory_wiki_source_bindings: {
    wiki_version_id: 'immutable.generatedVersionId', installation_id: 'immutable.installationId', section_id: 'immutable.pages[].sections[].sectionId',
    binding_id: 'immutable.pages[].sections[].sourceBindings[].bindingId', source_kind: 'immutable.pages[].sections[].sourceBindings[].sourceKind',
    source_token: 'immutable.pages[].sections[].sourceBindings[].sourceToken', source_snapshot_id: 'immutable.pages[].sections[].sourceBindings[].sourceSnapshotId',
    commit_sha: 'immutable.pages[].sections[].sourceBindings[].commitSha', created_at: 'immutable.pages[].sections[].sourceBindings[].createdAt',
  },
  memory_wiki_manual_section_versions: {
    manual_version_id: 'serverOnly.manualVersions[].manualVersionId', installation_id: 'immutable.installationId', wiki_id: 'key.id',
    section_key: 'serverOnly.manualVersions[].sectionKey', markdown: 'serverOnly.manualVersions[].markdown', content_hash: 'serverOnly.manualVersions[].contentHash',
    actor_scope_kind: 'serverOnly.manualVersions[].actorScopeKind', actor_scope_id: 'serverOnly.manualVersions[].actorScopeId',
    reason_code: 'serverOnly.manualVersions[].reasonCode', previous_version_id: 'serverOnly.manualVersions[].previousVersionId',
    created_at: 'serverOnly.manualVersions[].createdAt',
  },
  memory_wiki_manual_section_heads: {
    installation_id: 'immutable.installationId', wiki_id: 'key.id', section_key: 'serverOnly.manualHeads[].sectionKey',
    current_version_id: 'serverOnly.manualHeads[].currentVersionId', locked: 'serverOnly.manualHeads[].locked',
    lock_version: 'serverOnly.manualHeads[].lockVersion', updated_at: 'serverOnly.manualHeads[].updatedAt',
  },
} as const
