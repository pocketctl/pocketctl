import {describe, expect, test} from 'vitest'
import {frozenTaskRequirementsText} from '../team/task-requirements-snapshot.js'

describe('immutable execution requirements text', () => {
  const document = () => ({goal: 'Goal', scope: '', acceptance: 'Reviewed', repository: null})
  test('legacy tasks add no requirement authority', () => {
    expect(frozenTaskRequirementsText({})).toBe('')
    expect(frozenTaskRequirementsText({requirements: null, requirements_revision: 0})).toBe('')
  })
  test('freezes a detached version and advisory missing fields without blocking execution', () => {
    const row = {requirements: document(), requirements_revision: '2', requirements_override: null}
    const first = frozenTaskRequirementsText(row)
    row.requirements.goal = 'Edited later'
    row.requirements_revision = '3'
    expect(first).toContain('"revision":2')
    expect(first).toContain('"goal":"Goal"')
    expect(first).toContain('"missing":["scope","repository"]')
    expect(first).not.toContain('Edited later')
    expect(frozenTaskRequirementsText(row)).toContain('Edited later')
  })
  test('records current human override and rejects stale or malformed authority', () => {
    const row = {requirements: document(), requirements_revision: 2,
      requirements_override: {actor_user_id: 7, reason: 'Investigation', requirements_revision: 2}}
    expect(frozenTaskRequirementsText(row)).toContain('"actor_user_id":7')
    expect(() => frozenTaskRequirementsText({...row, requirements_revision: 3})).toThrow()
    expect(() => frozenTaskRequirementsText({...row, requirements_override: {...row.requirements_override, actor_user_id: 0}})).toThrow()
  })
  test('rejects corrupt version or repository instead of silently dropping saved requirements', () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => frozenTaskRequirementsText({requirements: document(), requirements_revision: revision})).toThrow()
    }
    expect(() => frozenTaskRequirementsText({requirements: {...document(), repository: {kind: 'git', url: 'file:///secret'}}, requirements_revision: 1})).toThrow()
  })
})
