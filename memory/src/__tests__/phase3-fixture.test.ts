import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { describe, expect, test } from 'vitest'

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/phase3-governance.json')

describe('phase3 governance fixture', () => {
  test('is deterministic across reads and satisfies the §13.1 denominators', () => {
    const first = readFileSync(fixturePath, 'utf8')
    const parsed = JSON.parse(first) as {
      teams: unknown[]
      users: { email: string }[]
      installations: { personal: string[]; team: string[]; organization: string[] }
      claims: { personal_active: number; team_proposals: number; team_active: number; organization_proposals: number; organization_active: number }
      scenarios: string[]
      expectations: { external_provider_calls: number; real_user_content: boolean }
    }
    const second = readFileSync(fixturePath, 'utf8')
    expect(createHash('sha256').update(second).digest('hex'))
      .toBe(createHash('sha256').update(first).digest('hex'))

    expect(parsed.teams.length).toBe(2)
    expect(parsed.users.length).toBeGreaterThanOrEqual(5)
    expect(parsed.installations.personal.length).toBe(3)
    expect(parsed.installations.team.length).toBe(2)
    expect(parsed.installations.organization.length).toBe(1)
    expect(parsed.claims.personal_active).toBeGreaterThanOrEqual(12)
    expect(parsed.claims.team_proposals).toBeGreaterThanOrEqual(8)
    expect(parsed.claims.team_active).toBeGreaterThanOrEqual(4)
    expect(parsed.claims.organization_proposals).toBeGreaterThanOrEqual(3)
    expect(parsed.claims.organization_active).toBeGreaterThanOrEqual(2)
    for (const scenario of ['exact_duplicate', 'semantic_conflict', 'explicit_parallel',
      'supersede', 'expired_proposal', 'withdrawn_proposal', 'revoked_membership',
      'role_change', 'suspended_team', 'dissolved_team_transfer', 'account_deletion', 'replay']) {
      expect(parsed.scenarios).toContain(scenario)
    }
    expect(parsed.expectations.external_provider_calls).toBe(0)
    expect(parsed.expectations.real_user_content).toBe(false)
    // Fixture data is synthetic: no real user content.
    expect(parsed.users.every(user => user.email.endsWith('@fixture.test'))).toBe(true)
  })
})
