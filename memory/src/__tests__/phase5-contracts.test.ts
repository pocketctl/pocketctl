import { describe, expect, test } from 'vitest'
import { SkillCandidateDocumentSchema, skillDocumentHash, type SkillCandidateDocument } from '../skills/types.js'
import { buildSkillArchive, type SkillArchiveInput } from '../skills/archive.js'
import { assessSkillRisk, evaluateAutoPublication } from '../skills/risk-policy.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hash = 'a'.repeat(64)
function document(): SkillCandidateDocument {
  return {
    schema_version: 'skill-candidate.v1', title: '定位测试约定',
    trigger: '需要了解仓库测试结构', preconditions: ['具有仓库读取权限'],
    steps: [{ instruction: '查找测试文件', tool: 'search', permissions: ['repository:read'], operation: 'read' }],
    validation: ['返回的每个文件必须有证据引用'], failure_handling: ['无结果时说明未找到'],
    rollback: ['停止本次只读调查，无外部修改'], source_tokens: ['source-1'],
  }
}
function input(): SkillArchiveInput {
  return {
    installationId: id(1), repositoryId: id(2), repoSnapshotId: id(3), taskId: id(4),
    generation: 1, candidateKey: 'test-conventions', policyVersion: 'skill-policy.v1',
    document: document(),
    sources: [{
      token: 'source-1', installationId: id(1), repositoryId: id(2), repoSnapshotId: id(3),
      episodeId: id(5), sessionId: 'session-1', state: 'ready', outcome: 'completed',
      sourceDigest: hash, evidenceHandle: 'event:1', excerptHash: 'b'.repeat(16),
      evidenceEligible: true, valueVerified: true,
    }],
  }
}
function facts() {
  const hash = skillDocumentHash(document())
  return {
    contentHash: hash, conflictingClaims: false,
    successes: [
      { episodeId: id(5), sessionId: 's1', contentHash: hash, verified: true },
      { episodeId: id(6), sessionId: 's2', contentHash: hash, verified: true },
    ],
    deterministicValidation: { contentHash: hash, passed: true },
    replays: [
      { kind: 'historical_session' as const, contentHash: hash, passed: true },
      { kind: 'golden_task' as const, contentHash: hash, passed: true },
    ],
    rollbackVerified: true,
  }
}

describe('Phase 5 candidate and archive contracts', () => {
  test('accepts bounded content but rejects model-supplied authority and missing validation', () => {
    expect(SkillCandidateDocumentSchema.safeParse(document()).success).toBe(true)
    for (const field of ['publisher', 'risk', 'owner', 'state', 'replay_passed', 'success_count']) {
      expect(SkillCandidateDocumentSchema.safeParse({ ...document(), [field]: 'approved' }).success).toBe(false)
    }
    expect(SkillCandidateDocumentSchema.safeParse({ ...document(), validation: [] }).success).toBe(false)
    expect(SkillCandidateDocumentSchema.safeParse({ ...document(), source_tokens: ['x', 'x'] }).success).toBe(false)
    expect(SkillCandidateDocumentSchema.safeParse({ ...document(), title: '   ' }).success).toBe(false)
    expect(() => buildSkillArchive({ ...input(), generation: 0 })).toThrow()
  })

  test('archive copies and freezes all content and hashes canonical inputs', () => {
    const source = input()
    const archive = buildSkillArchive(source)
    source.document.title = 'changed'
    source.sources[0]!.sessionId = 'changed'
    expect(archive.document.title).toBe('定位测试约定')
    expect(archive.sources[0]!.sessionId).toBe('session-1')
    expect(Object.isFrozen(archive.document.steps[0])).toBe(true)
    expect(Object.isFrozen(archive.sources[0])).toBe(true)
    expect(archive.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(buildSkillArchive(input())).toEqual(archive)
    const reordered = { ...input(), document: Object.fromEntries(Object.entries(document()).reverse()) as SkillCandidateDocument }
    expect(buildSkillArchive(reordered).contentHash).toBe(archive.contentHash)
    expect(buildSkillArchive({ ...input(), policyVersion: 'skill-policy.v2' }).inputDigest).not.toBe(archive.inputDigest)
    expect(buildSkillArchive({ ...input(), generation: 2 }).contentHash).not.toBe(archive.contentHash)
  })

  test.each([
    ['installationId', id(9)], ['repositoryId', id(9)], ['repoSnapshotId', id(9)],
    ['state', 'open'], ['outcome', 'failed'], ['evidenceEligible', false], ['valueVerified', false],
    ['sourceDigest', ''], ['evidenceHandle', ''], ['excerptHash', ''],
  ])('rejects unverified or mismatched source %s', (field, value) => {
    const source = input()
    Object.assign(source.sources[0]!, { [field]: value })
    expect(() => buildSkillArchive(source)).toThrow()
  })

  test('rejects missing/duplicate/unused source tokens and aggregate content overflow', () => {
    expect(() => buildSkillArchive({ ...input(), sources: [] })).toThrow()
    const source = input()
    source.sources.push({ ...source.sources[0]! })
    expect(() => buildSkillArchive(source)).toThrow()
    source.sources[1]!.token = 'unused'
    expect(() => buildSkillArchive(source)).toThrow()
    const huge = input()
    huge.document.steps = Array.from({ length: 32 }, () => ({ ...document().steps[0]!, instruction: 'x'.repeat(4000) }))
    expect(() => buildSkillArchive(huge)).toThrow(/size/)
  })

  test('rejects secret-bearing archives without echoing the content', () => {
    const source = input()
    source.document.steps[0]!.instruction = 'password=fixture-password-only'
    expect(() => buildSkillArchive(source)).toThrow(/^skill_secret_detected$/)
  })

  test('two tokens cannot inflate evidence by pointing at the same handle', () => {
    const source = input()
    source.document.source_tokens.push('source-2')
    source.sources.push({ ...source.sources[0]!, token: 'source-2' })
    expect(() => buildSkillArchive(source)).toThrow(/skill_source_evidence_duplicate/)
  })
})

describe('Phase 5 deterministic publication assessment (no publication side effects)', () => {
  test('read-only candidate can be eligible only with all version-bound facts', () => {
    const decision = evaluateAutoPublication(document(), facts())
    expect(decision.eligible).toBe(true)
    expect(decision.reasons).toEqual([])
    expect(assessSkillRisk(document()).risk).toBe('low')
    const edited = document(); edited.title = '新方法'
    expect(evaluateAutoPublication(edited, facts()).reasons).toContain('content_version_mismatch')
  })

  test.each(['deployment', 'deletion', 'production_write', 'permission_change', 'data_migration'] as const)(
    '%s can never qualify for automatic publication', operation => {
      const doc = document()
      doc.steps[0]!.operation = operation
      expect(assessSkillRisk(doc).risk).toBe('high')
      expect(evaluateAutoPublication(doc, facts()).eligible).toBe(false)
    },
  )

  test.each(['部署到生产', '删除数据库', '生产写入', '修改权限', '执行数据迁移', 'rm -rf ./data', 'DROP TABLE users', 'chmod 777 ./data'])(
    'scans every field including rollback: %s', command => {
      const doc = document()
      doc.rollback = [command]
      expect(assessSkillRisk(doc).risk).toBe('high')
      expect(evaluateAutoPublication(doc, facts()).eligible).toBe(false)
    },
  )

  test('unknown tools and elevated permissions cannot self-declare low risk', () => {
    const doc = document()
    doc.steps[0]!.tool = 'shell'
    expect(assessSkillRisk(doc).risk).toBe('unknown')
    expect(evaluateAutoPublication(doc, facts()).eligible).toBe(false)
    doc.steps[0]!.tool = 'search'
    doc.steps[0]!.permissions = ['production:write']
    expect(assessSkillRisk(doc).risk).toBe('high')
  })

  test('does not count repeated turns or an unverified success as independent success', () => {
    const f = facts()
    f.successes[1]!.sessionId = 's1'
    expect(evaluateAutoPublication(document(), f).reasons).toContain('independent_successes_missing')
    f.successes[1]!.sessionId = 's2'
    f.successes[1]!.episodeId = f.successes[0]!.episodeId
    expect(evaluateAutoPublication(document(), f).eligible).toBe(false)
    f.successes[1]!.episodeId = id(6)
    f.successes[1]!.verified = false
    expect(evaluateAutoPublication(document(), f).eligible).toBe(false)
  })

  test('requires both replay kinds, deterministic validation, rollback and no conflicts', () => {
    for (const mutate of [
      (f: ReturnType<typeof facts>) => { f.replays.pop() },
      (f: ReturnType<typeof facts>) => { f.replays[0]!.passed = false },
      (f: ReturnType<typeof facts>) => { f.replays[1]!.contentHash = 'c'.repeat(64) },
      (f: ReturnType<typeof facts>) => { f.deterministicValidation.passed = false },
      (f: ReturnType<typeof facts>) => { f.deterministicValidation.contentHash = 'c'.repeat(64) },
      (f: ReturnType<typeof facts>) => { f.conflictingClaims = true },
      (f: ReturnType<typeof facts>) => { f.rollbackVerified = false },
      (f: ReturnType<typeof facts>) => { f.successes[0]!.contentHash = 'c'.repeat(64) },
    ]) {
      const f = facts(); mutate(f)
      expect(evaluateAutoPublication(document(), f).eligible).toBe(false)
    }
    const doc = document()
    doc.failure_handling = ['api_key=fixture-secret-value']
    expect(evaluateAutoPublication(doc, facts()).reasons).toContain('secret_detected')
  })
})
