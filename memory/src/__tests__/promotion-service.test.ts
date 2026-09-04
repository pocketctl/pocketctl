import { describe, expect, test, vi } from 'vitest'

import { createPromotionService, PromotionError } from '../governance/promotion-service.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import { sanitizeSharedEvidenceExcerpt } from '../episodes/content-policy.js'

const PERSONAL = 'bbbbbbbb-0000-4000-8000-000000000001'
const TEAM = 'bbbbbbbb-0000-4000-8000-000000000002'

function grant(overrides: Partial<ValidatedV2Grant> = {}): ValidatedV2Grant {
  return {
    primaryInstallationId: TEAM,
    configVersion: '1',
    scopeBindings: [
      {
        installation_id: PERSONAL,
        owner_scope_kind: 'personal',
        owner_scope_id: PERSONAL,
        membership_id: null,
        membership_revision: '0',
        authorization_epoch: '1',
        permissions: ['read', 'contribute', 'review', 'publish', 'policy_admin', 'scope_admin'],
      },
      {
        installation_id: TEAM,
        owner_scope_kind: 'team',
        owner_scope_id: 'bbbbbbbb-0000-4000-8000-000000000011',
        membership_id: 'bbbbbbbb-0000-4000-8000-000000000021',
        membership_revision: '2',
        authorization_epoch: '3',
        permissions: ['read', 'contribute'],
      },
    ],
    ...overrides,
  }
}

describe('promotion service input gates', () => {
  function serviceWithoutDatabase() {
    const connect = vi.fn()
    const pool = { connect } as never as import('pg').Pool
    return { service: createPromotionService(pool), connect }
  }

  test('rejects a missing source binding before touching the database', async () => {
    const { service, connect } = serviceWithoutDatabase()
    await expect(service.propose({
      grant: grant(),
      sourceInstallationId: 'cccccccc-0000-4000-8000-000000000099',
      sourceClaimId: 'cccccccc-0000-4000-8000-000000000098',
      evidenceIds: ['cccccccc-0000-4000-8000-000000000097'],
      idempotencyDigest: 'digest-1',
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(connect).not.toHaveBeenCalled()
  })

  test('rejects a target binding without contribute permission', async () => {
    const { service, connect } = serviceWithoutDatabase()
    await expect(service.propose({
      grant: grant({
        scopeBindings: grant().scopeBindings.map(binding =>
          binding.installation_id === TEAM
            ? { ...binding, permissions: ['read'] }
            : binding),
      }),
      sourceInstallationId: PERSONAL,
      sourceClaimId: 'cccccccc-0000-4000-8000-000000000098',
      evidenceIds: ['cccccccc-0000-4000-8000-000000000097'],
      idempotencyDigest: 'digest-2',
    })).rejects.toMatchObject({ code: 'forbidden_direction' })
    expect(connect).not.toHaveBeenCalled()
  })

  test('enforces the 1..8 unique evidence selection bound', async () => {
    const { service, connect } = serviceWithoutDatabase()
    const evidenceId = 'cccccccc-0000-4000-8000-000000000097'
    for (const evidenceIds of [[], [evidenceId, evidenceId], Array.from({ length: 9 }, () => evidenceId)]) {
      await expect(service.propose({
        grant: grant(),
        sourceInstallationId: PERSONAL,
        sourceClaimId: 'cccccccc-0000-4000-8000-000000000098',
        evidenceIds,
        idempotencyDigest: 'digest-3',
      })).rejects.toMatchObject({ code: 'evidence_out_of_bounds' })
    }
    expect(connect).not.toHaveBeenCalled()
  })

  test('PromotionError carries bounded codes only', () => {
    const error = new PromotionError('invalid_edge', 'edge detail')
    expect(error.code).toBe('invalid_edge')
    expect(error.name).toBe('PromotionError')
  })
})

describe('shared evidence re-redaction', () => {
  test('strips secrets, minimizes paths, and caps length', () => {
    const secret = sanitizeSharedEvidenceExcerpt('token=abc123defGHI456jkl and path /Users/me/secret/file.txt')
    expect(secret).not.toBeNull()
    expect(secret!.text).toContain('[redacted]')
    expect(secret!.text).not.toContain('abc123defGHI456jkl')
    expect(secret!.text).not.toContain('/Users/me')
    expect(secret!.excerptHash).toMatch(/^[0-9a-f]{64}$/)

    expect(sanitizeSharedEvidenceExcerpt('   ')).toBeNull()
    const long = sanitizeSharedEvidenceExcerpt('x'.repeat(9000))
    expect(long!.text.length).toBeLessThanOrEqual(4000)
  })
})
