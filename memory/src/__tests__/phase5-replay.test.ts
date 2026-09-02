import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, test } from 'vitest'
import { ReplayCaseSchema, ReplayInputError, replayCaseHash, replayTextHash, runRecordedReplayCase, SKILL_REPLAY_RUNNER_VERSION, type ReplayCase } from '../skills/replay-runner.js'
import type { SkillCandidateDocument } from '../skills/types.js'

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/phase5-skills.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { document: SkillCandidateDocument; cases: ReplayCase[] }
const [historical, golden] = fixture.cases
const bindings = {
  installationId: historical!.installation_id, repositoryId: historical!.repository_id,
  repoSnapshotId: historical!.repo_snapshot_id, versionId: historical!.version_id, policyHash: historical!.policy_hash,
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const run = (replayCase: ReplayCase, document = fixture.document, signal = new AbortController().signal) => runRecordedReplayCase({ replayCase, document, ...bindings }, signal)

describe('Phase 5 recorded Skill Replay runner', () => {
  test('uses fixture-only recorded data: both kinds bind exactly and the intended failure stays visible', async () => {
    expect(ReplayCaseSchema.parse(historical)).toEqual(historical)
    expect(ReplayCaseSchema.parse(golden)).toEqual(golden)
    expect(replayCaseHash(clone(historical!))).toBe(replayCaseHash(historical!))
    expect(replayTextHash(fixture.document.steps[0]!.instruction)).toBe(historical!.steps[0]!.instruction_hash)
    const passing = await run(historical!)
    const failing = await run(golden!)
    expect(passing).toMatchObject({ state: 'passed', errorCode: 'ok', runnerVersion: SKILL_REPLAY_RUNNER_VERSION, documentHash: historical!.document_hash })
    expect(failing).toMatchObject({ state: 'failed', errorCode: 'assertion_failed' })
    expect(failing.assertions.find(assertion => assertion.assertionId === 'golden-intentional-failure')).toMatchObject({ passed: false, code: 'assertion_failed' })
  })

  test('fails closed on missing slots, assertions, validation coverage and recorded content changes', async () => {
    const noSlot = clone(historical!); noSlot.steps.pop()
    await expect(run(noSlot)).resolves.toMatchObject({ state: 'failed', errorCode: 'step_mismatch', assertions: [] })
    const noAssertion = clone(historical!); noAssertion.assertions = noAssertion.assertions.filter(assertion => assertion.step_index !== 1)
    await expect(run(noAssertion)).resolves.toMatchObject({ state: 'failed', errorCode: 'validation_missing', assertions: [] })
    const wrongValidation = clone(historical!); wrongValidation.assertions[1]!.validation_hash = replayTextHash('other validation')
    await expect(run(wrongValidation)).resolves.toMatchObject({ state: 'failed', errorCode: 'validation_missing', assertions: [] })
    const extraWrongValidation = clone(historical!)
    extraWrongValidation.assertions.push({ ...extraWrongValidation.assertions[0]!, assertion_id: 'extra-wrong-validation', validation_hash: extraWrongValidation.assertions[1]!.validation_hash })
    await expect(run(extraWrongValidation)).resolves.toMatchObject({ state: 'failed', errorCode: 'validation_missing', assertions: [] })
    const changedResponse = clone(historical!); changedResponse.steps[1]!.response = { status: 'different' }
    await expect(run(changedResponse)).resolves.toMatchObject({ state: 'failed', errorCode: 'assertion_failed' })
  })

  test('rejects invalid, secret-bearing, hostile, abort and real-provenance inputs without exposing data', async () => {
    const hostile = clone(historical!); hostile.assertions[0]!.path = ['__proto__']
    await expect(run(hostile)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const secret = clone(historical!); secret.steps[0]!.response = { api_key: 'fixture-secret-value' }
    await expect(run(secret)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const recorded = clone(historical!); recorded.provenance = 'recorded'
    await expect(run(recorded)).resolves.toMatchObject({ state: 'passed', provenance: 'recorded' })
    const real = { ...clone(historical!), provenance: 'real' } as unknown as ReplayCase
    await expect(run(real as ReplayCase)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const document = clone(fixture.document); document.title = 'mutated document'
    await expect(run(historical!, document)).rejects.toMatchObject({ code: 'replay_binding_invalid' })
    for (const binding of ['installationId', 'repositoryId', 'repoSnapshotId', 'versionId', 'policyHash'] as const) {
      await expect(runRecordedReplayCase({ replayCase: historical!, document: fixture.document, ...bindings, [binding]: binding === 'policyHash' ? 'b'.repeat(64) : '00000000-0000-4000-8000-000000000099' }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'replay_binding_invalid' })
    }
    const controller = new AbortController(); controller.abort()
    await expect(run(historical!, fixture.document, controller.signal)).rejects.toEqual(expect.objectContaining({ code: 'replay_aborted' }))
    await expect(run(hostile)).rejects.toBeInstanceOf(ReplayInputError)
  })

  test('rejects non-JSON response objects, cycles and depth before canonical hashing', async () => {
    const dated = clone(historical!); dated.steps[0]!.response = new Date() as unknown as Record<string, unknown>
    await expect(run(dated)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const mapped = clone(historical!); mapped.steps[0]!.response = new Map() as unknown as Record<string, unknown>
    await expect(run(mapped)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const cyclic = clone(historical!); const cycle: Record<string, unknown> = {}; cycle.self = cycle; cyclic.steps[0]!.response = cycle
    await expect(run(cyclic)).rejects.toMatchObject({ code: 'replay_case_invalid' })
    const deep = clone(historical!); let value: Record<string, unknown> = {}; deep.steps[0]!.response = value
    for (let index = 0; index < 33; index += 1) { const next: Record<string, unknown> = {}; value.next = next; value = next }
    await expect(run(deep)).rejects.toMatchObject({ code: 'replay_case_invalid' })
  })
})
