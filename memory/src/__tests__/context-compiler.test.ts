import { describe, expect, test, vi } from 'vitest'
import { createContextCompiler, type CompileRequest } from '../context/compiler.js'
import type { ContextRetrieval } from '../context/retrieval.js'
import type { ScopeResolver } from '../context/scope-resolver.js'
import type { LoadoutRepository } from '../context/loadout-repository.js'
import type { ContextSettingsRepository } from '../context/settings-repository.js'
import type { PackRepository } from '../context/pack-repository.js'
import type { GenerationRunRepository } from '../generation/repository.js'
import type { PolicyResolver, EffectivePolicy } from '../policies/resolver.js'
import {
  SYSTEM_CONTEXT_POLICY_V1,
  SYSTEM_RANKING_POLICY_V1,
  canonicalPolicyHash,
  type ContextPolicyDocument,
} from '../policies/schemas.js'

const INSTALLATION = 'cdcdcdcd-cdcd-4ccd-8ccd-cdcdcdcdcdcd'

function fakeDeps(overrides: {
  mode?: 'off' | 'shadow' | 'enabled'
  candidates?: Array<{ versionId: string; claimId: string; claimType: string; statement: string; scopeKind: string; authority: string; fusedScore: number; repositoryId: string | null; branch: string | null; reasonCodes: string[]; finalOrdinal: number; freshnessAt?: Date | null }>
  persona?: Array<{ claimId: string; versionId: string }>
  retrievalOutcome?: 'completed' | 'empty' | 'degraded' | 'retrieval_failed'
  repositoryKnown?: boolean
  contextPolicy?: ContextPolicyDocument
  settingsRevision?: number
  loadoutRevision?: number
} = {}) {
  const persisted: Array<Record<string, unknown>> = []
  const completed: Array<Record<string, unknown>> = []
  const deps = {
    pool: {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('knowledge_evidence')) return { rows: [{ evidence_id: 'e-1' }] }
        if (sql.includes('knowledge_versions')) return { rows: [{ statement: 'version statement here' }] }
        return { rows: [] }
      }),
    } as never,
    retrieval: {
      retrieve: vi.fn(async () => ({
        outcome: overrides.retrievalOutcome ?? 'completed',
        degradedComponents: [],
        candidates: overrides.candidates ?? [],
        trajectoryId: 'traj-1',
      })),
    } as unknown as ContextRetrieval,
    scope: {
      resolve: vi.fn(async () => ({
        installationId: INSTALLATION,
        repositoryId: overrides.repositoryKnown === false ? null : '11111111-1111-4111-8111-111111111111',
        repositoryKnown: overrides.repositoryKnown !== false,
        personaOnly: overrides.repositoryKnown === false,
        sessionKnown: true,
      })),
      personaVersions: vi.fn(async () => overrides.persona ?? []),
    } as unknown as ScopeResolver,
    loadouts: {
      resolve: vi.fn(async () => ({ revision: overrides.loadoutRevision ?? 1, items: [] })),
    } as unknown as LoadoutRepository,
    settings: {
      resolve: vi.fn(async () => ({
        mode: overrides.mode ?? 'enabled',
        maxTokens: null,
        revisions: [overrides.settingsRevision ?? 4],
      })),
    } as unknown as ContextSettingsRepository,
    packs: {
      persist: vi.fn(async (input: Record<string, unknown>) => {
        persisted.push(input)
        return `pack-${persisted.length}`
      }),
      get: vi.fn(async () => ({
        state: 'ready', mode: 'enabled', stable_text: '', dynamic_text: '',
        stable_tokens: 10, dynamic_tokens: 20, item_count: 2,
        error_code: null, degraded_components: [],
      })),
    } as unknown as PackRepository,
    generation: {
      reserve: vi.fn(async () => ({ runId: 'run-1', owner: true })),
      complete: vi.fn(async (input: Record<string, unknown>) => {
        completed.push(input)
      }),
      attachPolicies: vi.fn(async () => undefined),
    } as unknown as GenerationRunRepository,
    policyResolver: {
      resolve: vi.fn(async (input: { kind: string }): Promise<EffectivePolicy> => {
        const document = input.kind === 'ranking'
          ? SYSTEM_RANKING_POLICY_V1
          : overrides.contextPolicy ?? SYSTEM_CONTEXT_POLICY_V1
        return {
          document,
          policyVersionIds: [input.kind === 'ranking' ? 'pv-ranking-1' : 'pv-context-1'],
          effectivePolicyHash: canonicalPolicyHash(document),
          policyRevision: input.kind === 'ranking' ? 3 : 7,
        }
      }),
    } as unknown as PolicyResolver,
  }
  return { deps, persisted, completed }
}

const REQUEST: CompileRequest = {
  installationId: INSTALLATION,
  sessionId: 'ses-1',
  clientRequestId: 'cr-1',
  agent: 'codex',
  adapterCapability: 'native_hidden_v1',
  query: 'how does web auth work',
  requestKey: { keyId: 'k', hmacKey: Buffer.alloc(32, 1) },
}

describe('context compiler (deterministic synchronous path)', () => {
  test('mode off short-circuits before any run reservation', async () => {
    const { deps } = fakeDeps({ mode: 'off' })
    const compiler = createContextCompiler(deps)
    const outcome = await compiler.compile(REQUEST)
    expect(outcome).toEqual({ kind: 'off' })
    expect(deps.generation.reserve).not.toHaveBeenCalled()
    expect(deps.packs.persist).not.toHaveBeenCalled()
  })

  test('an unsupported adapter compiles shadow-only regardless of settings', async () => {
    const { deps, persisted } = fakeDeps({
      mode: 'enabled',
      candidates: [{
        versionId: 'v-2', claimId: 'c-2', claimType: 'test_invariant',
        statement: 'shadow adapter still compiles', scopeKind: 'task',
        authority: 'user_accepted', fusedScore: 0.5, repositoryId: null,
        branch: null, reasonCodes: ['ranked'], finalOrdinal: 0,
      }],
    })
    const compiler = createContextCompiler(deps)
    const outcome = await compiler.compile({ ...REQUEST, adapterCapability: 'shadow_only' })
    expect(outcome).toMatchObject({ kind: 'shadow' })
    expect(persisted[0]).toMatchObject({ mode: 'shadow', state: 'shadow' })
  })

  test('persona items land in the stable L3 section; query items stay dynamic L2', async () => {
    const { deps, persisted } = fakeDeps({
      mode: 'enabled',
      persona: [{ claimId: 'c-persona', versionId: 'v-persona' }],
      candidates: [{
        versionId: 'v-2', claimId: 'c-2', claimType: 'architecture_decision',
        statement: 'web auth via grants', scopeKind: 'task', authority: 'user_accepted',
        fusedScore: 0.7, repositoryId: null, branch: null,
        reasonCodes: ['ranked'], finalOrdinal: 0,
      }],
    })
    const compiler = createContextCompiler(deps)
    const outcome = await compiler.compile(REQUEST)
    expect(outcome).toMatchObject({ kind: 'ready', itemCount: 2 })
    const items = persisted[0].items as Array<{ layer: string; section: string; claimType: string }>
    expect(items.find(item => item.claimType === 'work_method'))
      .toMatchObject({ layer: 'L3', section: 'stable' })
    expect(items.find(item => item.claimType === 'architecture_decision'))
      .toMatchObject({ layer: 'L2', section: 'dynamic' })
  })

  test('an unknown repository hint can only compile installation Persona', async () => {
    const { deps, persisted } = fakeDeps({
      repositoryKnown: false,
      persona: [{ claimId: 'c-persona', versionId: 'v-persona' }],
      candidates: [{
        versionId: 'v-other-repo', claimId: 'c-other-repo', claimType: 'architecture_decision',
        statement: 'must never cross repository scope', scopeKind: 'repository',
        authority: 'user_accepted', fusedScore: 1, repositoryId: 'other-repo',
        branch: null, reasonCodes: ['ranked'], finalOrdinal: 0,
      }],
    })
    const compiler = createContextCompiler(deps)
    const outcome = await compiler.compile({
      ...REQUEST,
      repositoryId: '22222222-2222-4222-8222-222222222222',
    })

    expect(outcome).toMatchObject({ kind: 'ready', itemCount: 1 })
    expect(deps.retrieval.retrieve).not.toHaveBeenCalled()
    expect(deps.settings.resolve).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: null }))
    expect(deps.loadouts.resolve).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: null }))
    expect(persisted[0]).toMatchObject({ repositoryId: null })
    expect((persisted[0].items as Array<{ claimType: string }>)).toEqual([
      expect.objectContaining({ claimType: 'work_method' }),
    ])
  })

  test('retrieval failure fails the run without a pack', async () => {
    const { deps, completed } = fakeDeps({ retrievalOutcome: 'retrieval_failed' })
    const compiler = createContextCompiler(deps)
    const outcome = await compiler.compile(REQUEST)
    expect(outcome).toEqual({ kind: 'retrieval_failed' })
    expect(completed[0]).toMatchObject({ state: 'failed', errorCode: 'retrieval_failed' })
    expect(deps.packs.persist).not.toHaveBeenCalled()
  })

  test('an empty minimized query skips retrieval and still compiles Persona', async () => {
    const { deps, persisted } = fakeDeps({
      persona: [{ claimId: 'c-persona', versionId: 'v-persona' }],
      retrievalOutcome: 'retrieval_failed',
    })
    const outcome = await createContextCompiler(deps).compile({ ...REQUEST, query: '   ' })
    expect(outcome).toMatchObject({ kind: 'ready', itemCount: 1 })
    expect(deps.retrieval.retrieve).not.toHaveBeenCalled()
    expect((persisted[0].items as Array<{ claimType: string }>)[0].claimType).toBe('work_method')
  })

  test('unknown repository policy can suppress Persona completely', async () => {
    const { deps } = fakeDeps({
      repositoryKnown: false,
      persona: [{ claimId: 'c-persona', versionId: 'v-persona' }],
      contextPolicy: { ...SYSTEM_CONTEXT_POLICY_V1, unknown_repository_behavior: 'empty' },
    })
    const outcome = await createContextCompiler(deps).compile(REQUEST)
    expect(outcome).toMatchObject({ kind: 'empty' })
    expect(deps.scope.personaVersions).not.toHaveBeenCalled()
  })

  test('run identity changes with settings, loadout, agent and adapter capability', async () => {
    const first = fakeDeps({ settingsRevision: 4, loadoutRevision: 1 })
    const second = fakeDeps({ settingsRevision: 5, loadoutRevision: 2 })
    await createContextCompiler(first.deps).compile(REQUEST)
    await createContextCompiler(second.deps).compile({
      ...REQUEST, agent: 'opencode', adapterCapability: 'shadow_only',
    })
    const firstReserve = vi.mocked(first.deps.generation.reserve).mock.calls[0][0]
    const secondReserve = vi.mocked(second.deps.generation.reserve).mock.calls[0][0]
    expect(secondReserve.inputDigest).not.toEqual(firstReserve.inputDigest)
  })

  test('passes ranking policy identity to retrieval and persists actual policy revision', async () => {
    const { deps, persisted } = fakeDeps({
      candidates: [{
        versionId: 'v-2', claimId: 'c-2', claimType: 'test_invariant',
        statement: 'ranked candidate', scopeKind: 'task', authority: 'user_accepted',
        fusedScore: 0.5, repositoryId: null, branch: null,
        reasonCodes: ['ranked'], finalOrdinal: 0,
      }],
    })
    await createContextCompiler(deps).compile(REQUEST)
    expect(deps.retrieval.retrieve).toHaveBeenCalledWith(expect.objectContaining({
      rankingPolicyVersionId: 'pv-ranking-1',
      rankingPolicy: SYSTEM_RANKING_POLICY_V1,
    }))
    expect(persisted[0]).toMatchObject({ policyRevision: 7 })
  })

  test('drops candidates outside the claim-type freshness window', async () => {
    const { deps, persisted } = fakeDeps({
      persona: [{ claimId: 'c-persona', versionId: 'v-persona' }],
      contextPolicy: {
        ...SYSTEM_CONTEXT_POLICY_V1,
        freshness_days: { architecture_decision: 7 },
      },
      candidates: [{
        versionId: 'v-stale', claimId: 'c-stale', claimType: 'architecture_decision',
        statement: 'obsolete design', scopeKind: 'repository', authority: 'user_accepted',
        fusedScore: 1, repositoryId: null, branch: null, reasonCodes: ['ranked'], finalOrdinal: 0,
        freshnessAt: new Date(Date.now() - 8 * 86_400_000),
      }],
    })
    const outcome = await createContextCompiler(deps).compile(REQUEST)
    expect(outcome).toMatchObject({ kind: 'ready', itemCount: 1 })
    expect((persisted[0].items as Array<{ versionId: string }>).map(item => item.versionId))
      .toEqual(['v-persona'])
  })

	test('a non-owner compile reservation never mutates the shared run or pack', async () => {
		const { deps } = fakeDeps({ mode: 'enabled' })
		deps.generation.reserve = vi.fn(async () => ({
			runId: 'run-existing', owner: false, state: 'running', outputKind: null, outputId: null,
		})) as never
		const compiler = createContextCompiler(deps)
		expect(await compiler.compile(REQUEST)).toEqual({ kind: 'degraded', reason: 'compile_in_progress' })
		expect(deps.retrieval.retrieve).not.toHaveBeenCalled()
		expect(deps.packs.persist).not.toHaveBeenCalled()
		expect(deps.generation.attachPolicies).not.toHaveBeenCalled()
	})

  test('a completed shared reservation reports the persisted item count', async () => {
    const { deps } = fakeDeps({ mode: 'enabled' })
    deps.generation.reserve = vi.fn(async () => ({
      runId: 'run-existing', owner: false, state: 'succeeded',
      outputKind: 'context_pack', outputId: 'pack-existing',
    })) as never
    const outcome = await createContextCompiler(deps).compile(REQUEST)
    expect(outcome).toMatchObject({ kind: 'ready', itemCount: 2 })
  })

  test('an empty shared reservation replays its original reason and degradation', async () => {
    const { deps } = fakeDeps({ mode: 'enabled' })
    deps.generation.reserve = vi.fn(async () => ({
      runId: 'run-existing', owner: false, state: 'succeeded',
      outputKind: 'context_pack', outputId: 'pack-existing',
    })) as never
    deps.packs.get = vi.fn(async () => ({
      state: 'empty', mode: 'enabled', stable_text: '', dynamic_text: '',
      stable_tokens: 0, dynamic_tokens: 0, item_count: 0,
      error_code: 'token_budget', degraded_components: ['embedding'],
    })) as never
    expect(await createContextCompiler(deps).compile(REQUEST)).toEqual({
      kind: 'empty', reason: 'token_budget', degradedComponents: ['embedding'],
    })
  })

  test('identical inputs produce byte-identical pack content', async () => {
    const { deps, persisted } = fakeDeps({
      mode: 'enabled',
      candidates: [{
        versionId: 'v-2', claimId: 'c-2', claimType: 'test_invariant',
        statement: 'stable text across runs', scopeKind: 'task', authority: 'user_accepted',
        fusedScore: 0.5, repositoryId: null, branch: null,
        reasonCodes: ['ranked'], finalOrdinal: 0,
      }],
    })
    const compiler = createContextCompiler(deps)
    await compiler.compile(REQUEST)
    await compiler.compile(REQUEST)
    const first = persisted[0]
    const second = persisted[1]
    // Same deterministic inputs -> same policy/revision inputs and item text.
    expect(second.effectivePolicyHash).toEqual(first.effectivePolicyHash)
    expect(second.items).toEqual(first.items)
  })
})
