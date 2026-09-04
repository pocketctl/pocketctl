import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { appendSkillAudit } from '../skills/audit-repository.js'

const validInput = () => ({
  installationId: randomUUID(), actorKind: 'personal' as const, actorId: randomUUID(),
  action: 'approve' as const, outcome: 'allowed' as const,
  skillId: randomUUID(), versionId: randomUUID(), revision: 1, code: 'ok' as const,
})

describe('Phase 5 skill audit', () => {
  test('rejects hostile fields before writing an audit row', async () => {
    const query = vi.fn()
    await expect(appendSkillAudit({ query } as never, {
      ...validInput(), body: 'do not retain this body',
    })).rejects.toThrow('skill_audit_invalid')
    expect(query).not.toHaveBeenCalled()
  })

  test('rejects free-form codes and incomplete actor identities before writing', async () => {
    const query = vi.fn()
    await expect(appendSkillAudit({ query } as never, {
      ...validInput(), code: 'request body: secret',
    } as never)).rejects.toThrow('skill_audit_invalid')
    await expect(appendSkillAudit({ query } as never, {
      ...validInput(), actorKind: 'personal', actorId: null,
    })).rejects.toThrow('skill_audit_invalid')
    expect(query).not.toHaveBeenCalled()
  })

  test.each(['allowed', 'denied'] as const)('writes a bounded %s audit event when its installation exists', async outcome => {
    const query = vi.fn().mockResolvedValue({ rows: [{ event_id: '11111111-1111-4111-8111-111111111111' }] })
    const result = await appendSkillAudit({ query } as never, { ...validInput(), outcome })
    expect(result).toBe('11111111-1111-4111-8111-111111111111')
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]!
    expect(sql).toContain('INSERT INTO memory_skill_audit_events')
    expect(sql).toContain('FROM memory_installations')
    expect(params).toHaveLength(10)
    expect(params).not.toContain('do not retain this body')
  })
})
