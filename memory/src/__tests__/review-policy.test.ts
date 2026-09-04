import { describe, expect, test } from 'vitest'
import {
  DEFAULT_ORGANIZATION_REVIEW_POLICY,
  DEFAULT_TEAM_REVIEW_POLICY,
  loadEffectiveReviewPolicySnapshot,
  resolveEffectivePolicy,
} from '../governance/review-policy.js'
import { MEMORY_MIGRATIONS } from '../schema.js'

describe('review policy monotonic resolution', () => {
  test('keeps the shorter candidate TTL and lower evidence cap as stricter bounds', () => {
    const parent = {
      ...DEFAULT_ORGANIZATION_REVIEW_POLICY,
      candidate_ttl_days: 7,
      max_shared_evidence: 4,
    }
    const child = {
      ...DEFAULT_TEAM_REVIEW_POLICY,
      candidate_ttl_days: 60,
      max_shared_evidence: 8,
    }
    const effective = resolveEffectivePolicy(parent, child)
    expect(effective.candidate_ttl_days).toBe(7)
    expect(effective.max_shared_evidence).toBe(4)
    expect(effective.minimum_approvals).toBe(2)
  })

  test('allows a child to tighten TTL and evidence without weakening retention', () => {
    const effective = resolveEffectivePolicy(
      DEFAULT_ORGANIZATION_REVIEW_POLICY,
      {
        ...DEFAULT_TEAM_REVIEW_POLICY,
        candidate_ttl_days: 3,
        max_shared_evidence: 2,
        retention_days_after_revoke: 30,
      },
    )
    expect(effective.candidate_ttl_days).toBe(3)
    expect(effective.max_shared_evidence).toBe(2)
    expect(effective.retention_days_after_revoke).toBe(90)
  })

  test('loads and versions the parent organization policy for a team', async () => {
    const targetVersionId = '11111111-1111-4111-8111-111111111111'
    const parentVersionId = '22222222-2222-4222-8222-222222222222'
    const queries: string[] = []
    const client = {
      async query(sql: string, values?: unknown[]) {
        queries.push(sql)
        if (sql.includes('FROM memory_owner_scopes') && sql.includes('installation_id = $1')) {
          return {
            rows: [{
              owner_scope_kind: 'team',
              parent_organization_id: '33333333-3333-4333-8333-333333333333',
            }],
          }
        }
        if (sql.includes('FROM memory_review_policy_versions') && values?.[0] === 'team-installation') {
          return {
            rows: [{
              active_version_id: targetVersionId,
              document: DEFAULT_TEAM_REVIEW_POLICY,
            }],
          }
        }
        if (sql.includes("owner_scope_kind = 'organization'")) {
          return { rows: [{ installation_id: 'organization-installation' }] }
        }
        if (sql.includes('FROM memory_review_policy_versions') && values?.[0] === 'organization-installation') {
          return {
            rows: [{
              active_version_id: parentVersionId,
              document: {
                ...DEFAULT_ORGANIZATION_REVIEW_POLICY,
                minimum_approvals: 4,
                candidate_ttl_days: 5,
                max_shared_evidence: 2,
              },
            }],
          }
        }
        throw new Error(`unexpected query: ${sql}`)
      },
    }

    const snapshot = await loadEffectiveReviewPolicySnapshot(
      client as never,
      'team-installation',
    )

    expect(snapshot.activeVersionId).toBe(targetVersionId)
    expect(snapshot.parentActiveVersionId).toBe(parentVersionId)
    expect(snapshot.policy.minimum_approvals).toBe(4)
    expect(snapshot.policy.candidate_ttl_days).toBe(5)
    expect(snapshot.policy.max_shared_evidence).toBe(2)
    expect(queries.some(sql => sql.includes("owner_scope_kind = 'organization'"))).toBe(true)
  })

  test('migration 23 fences both candidate and authority provenance to the parent policy', () => {
    const migration = MEMORY_MIGRATIONS.find(entry => entry.version === 23)
    expect(migration).toBeDefined()
    expect(migration!.statements.join('\n')).toContain('memory_promotion_candidate_versions')
    expect(migration!.statements.join('\n')).toContain('memory_authority_records')
    expect(migration!.statements.join('\n')).toContain('parent_review_policy_version_id')
  })
})
