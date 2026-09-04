import type { AssetKind, AssetSnapshot, PortableAsset, RepositoryFile } from '../git-sync/types.js'

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const fixtureHash = 'a'.repeat(64)
export function phase6Snapshot(kind: AssetKind = 'claim'): AssetSnapshot {
  const id = fixtureId(1)
  const common = {
    schemaVersion: 'memory-git.v1', key: { kind, id },
    path: `.pocketctl/knowledge/${kind === 'wiki' ? `wiki/${id}/metadata` : `${kind}s/${id}`}.yaml`,
    connectionId: fixtureId(2), exportId: fixtureId(3), baseVersionId: fixtureId(4),
    baseRevision: '9007199254740993', sourceDigest: fixtureHash,
  }
  const identity = { installationId: fixtureId(5), ownerScopeKind: 'team', ownerScopeId: fixtureId(6),
    evidence: [{ evidenceId: fixtureId(7), versionId: fixtureId(4), hash: fixtureHash,
      kind: 'episode', ordinal: 0, visibility: 'shared' }] }
  let asset: unknown
  if (kind === 'claim' || kind === 'rule') asset = { ...common,
    immutable: { ...identity, claimType: kind === 'rule' ? 'test_invariant' : 'architecture_decision',
      versionNumber: 2, state: 'active', authority: 'user_accepted', confidence: '0.9500',
      freshnessAt: null, validFrom: null, validUntil: null },
    editable: { statement: '保留 Evidence 与精确版本。', structuredContent: { value: null, flags: ['a'], retries: 2, enabled: true } },
    serverOnly: { scopeKind: 'repository', scopeKey: '/private/repository', normalizedKey: 'normalized',
      repositoryId: fixtureId(8), repoSnapshotId: fixtureId(9), branch: 'private-branch',
      sourceCandidateId: null, supersededByClaimId: null, createdAt: '2026-09-02T00:00:00.000Z',
      sourcePromotionCandidateId: null, conflictGroupId: null, conflictVariant: 0, claimCreatedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-09-02T01:00:00.000Z', evidence: [{ evidenceId: fixtureId(7),
        episodeId: fixtureId(10), sourceEventId: null, artifactId: null, locator: { privatePath: '/private/file' },
        sourceEvidenceHash: null, contributorMembershipId: null,
        excerpt: 'private excerpt', occurredAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z' }] } }
  else if (kind === 'skill') asset = { ...common,
    immutable: { ...identity, versionNumber: 2, state: 'reviewed', risk: 'low', policyHash: fixtureHash,
      documentHash: fixtureHash, archiveContentHash: fixtureHash, replayRunId: null,
      replayState: 'not_run', publicationState: 'disabled', publicationRevision: '0', publishedVersionId: null },
    editable: { document: { schema_version: 'skill-candidate.v1', title: '合成检查', trigger: '检查前',
      preconditions: ['本地合成输入'], steps: [{ instruction: '读取状态', tool: 'read', permissions: ['read'], operation: 'read' }],
      validation: ['状态正确'], failure_handling: ['停止'], rollback: ['无更改'], source_tokens: ['source:1'] } },
    serverOnly: { taskId: fixtureId(10), candidateId: fixtureId(11), archiveId: fixtureId(12),
      policySnapshot: { scope: 'team' }, authorKind: 'membership', authorId: fixtureId(13),
      skillCreatedAt: '2026-08-01T00:00:00.000Z', previousPublishedVersionId: null, publicationEventId: null, publicationUpdatedAt: null,
      editableHeadVersionId: fixtureId(4), editableHeadRevision: '9007199254740993', editableHeadState: 'reviewed',
      authorizationEpoch: '3', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T01:00:00.000Z' } }
  else asset = { ...common,
    immutable: { ...identity, state: 'active', generatedVersionId: fixtureId(4), generatedRevision: '7', pages: [
      { pageId: fixtureId(20), pageKey: 'overview', position: 0, sections: [
        { sectionId: fixtureId(21), authority: 'manual', generatedVersionId: fixtureId(4), position: 0,
          manualVersionId: fixtureId(22), lockVersion: '2', sourceBindings: [{ bindingId: fixtureId(23),
            sourceKind: 'evidence', sourceToken: 'evidence:1', sourceSnapshotId: null, commitSha: null, createdAt: '2026-09-02T00:00:00.000Z' }] },
        { sectionId: fixtureId(24), authority: 'locked', generatedVersionId: fixtureId(4), position: 1,
          manualVersionId: fixtureId(25), lockVersion: '9007199254740993', sourceBindings: [{ bindingId: fixtureId(26),
            sourceKind: 'claim_version', sourceToken: 'claim:1', sourceSnapshotId: null, commitSha: null, createdAt: '2026-09-02T00:00:00.000Z' }] },
      ] },
    ] },
    editable: { pages: [{ pageId: fixtureId(20), title: '概览', sections: [
      { sectionId: fixtureId(21), sectionKey: 'overview', heading: '标题', markdown: '\n正文 [来源](evidence:1)\n\n', coverage: 'complete' },
      { sectionId: fixtureId(24), sectionKey: 'details', heading: '细节', markdown: '  保留空格\r\n原始换行\r\n', coverage: 'partial' },
    ] }] },
    serverOnly: { repositoryId: fixtureId(8), sourceSnapshotId: fixtureId(9), graphVersionId: fixtureId(27),
      generation: '1', wikiCreatedAt: '2026-08-01T00:00:00.000Z', wikiUpdatedAt: '2026-09-02T00:00:00.000Z',
      manualHeads: [{ sectionKey: 'overview', currentVersionId: fixtureId(22), locked: false, lockVersion: '2', updatedAt: '2026-09-02T00:00:00.000Z' },
        { sectionKey: 'details', currentVersionId: fixtureId(25), locked: true, lockVersion: '9007199254740993', updatedAt: '2026-09-02T00:00:00.000Z' }],
      buildRunId: null, contentHash: fixtureHash, createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T01:00:00.000Z',
      manualVersions: [{ manualVersionId: fixtureId(22), sectionKey: 'overview', markdown: '\n正文 [来源](evidence:1)\n\n',
        contentHash: fixtureHash, actorScopeKind: 'team', actorScopeId: fixtureId(6), reasonCode: null,
        previousVersionId: null, createdAt: '2026-09-02T00:00:00.000Z' }] } }
  return { asset: asset as PortableAsset, contentHash: fixtureHash, deleted: false }
}

/** Test-only mutation of wire metadata; deliberately bypasses the strict parser. */
export function changeMetadata(files: RepositoryFile[], edit: (value: any) => void): RepositoryFile[] {
  return files.map(file => {
    if (!file.path.endsWith('.yaml')) return file
    const value = JSON.parse(Buffer.from(file.bytes).toString('utf8'))
    edit(value)
    return { ...file, bytes: Buffer.from(JSON.stringify(value)) }
  })
}
