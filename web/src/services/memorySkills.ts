import { scopedMemoryJson } from './memoryClient'
import type {
  MemorySkillCandidate, MemorySkillDetail, MemorySkillDiff, MemorySkillDocument, MemorySkillMutation,
  MemorySkillPage, MemorySkillPolicy, MemorySkillPolicyState, MemorySkillReplay, MemorySkillReplayCase, MemorySkillReviewOutcome, MemorySkillSummary,
} from '../types/memorySkills'

const base = '/api/v1/memory/skills'
const id = encodeURIComponent
function read<T>(scope: string, path: string, signal?: AbortSignal): Promise<T> {
  return scopedMemoryJson<T>(scope, 'memory.search', `${base}${path}`, { signal })
}
function write<T>(scope: string, path: string, body: unknown, signal?: AbortSignal, method = 'POST'): Promise<T> {
  return scopedMemoryJson<T>(scope, 'memory.manage', `${base}${path}`, { method, body: JSON.stringify(body), signal })
}
function query(options: { cursor?: string; repository_id?: string; state?: string } = {}) {
  const params = new URLSearchParams({ limit: '20' })
  for (const [key, value] of Object.entries(options)) if (value) params.set(key, value)
  return `?${params}`
}
export const memorySkills = {
  list: (scope: string, options: { cursor?: string; repository_id?: string; state?: string } = {}, signal?: AbortSignal) =>
    read<MemorySkillPage<MemorySkillSummary>>(scope, query(options), signal),
  candidates: (scope: string, options: { cursor?: string; repository_id?: string } = {}, signal?: AbortSignal) =>
    read<MemorySkillPage<MemorySkillCandidate>>(scope, `/candidates${query(options)}`, signal),
  detail: (scope: string, skill: string, signal?: AbortSignal) => read<MemorySkillDetail>(scope, `/${id(skill)}`, signal),
  draft: (scope: string, candidate: string, revision: number, signal?: AbortSignal) =>
    write<MemorySkillMutation>(scope, `/candidates/${id(candidate)}/draft`, { expected_revision: revision }, signal),
  edit: (scope: string, skill: string, revision: number, document: MemorySkillDocument, signal?: AbortSignal) =>
    write<MemorySkillMutation>(scope, `/${id(skill)}/edit`, { expected_revision: revision, document }, signal),
  review: (scope: string, skill: string, revision: number, decision: 'approve' | 'request_changes' | 'reject', signal?: AbortSignal, reviewOutcome?: MemorySkillReviewOutcome) =>
    write<MemorySkillMutation>(scope, `/${id(skill)}/review`, { expected_revision: revision, decision,
      ...(decision === 'approve' && reviewOutcome ? { review_outcome: reviewOutcome } : {}) }, signal),
  revoke: (scope: string, skill: string, revision: number, signal?: AbortSignal) =>
    write<MemorySkillMutation>(scope, `/${id(skill)}/revoke`, { expected_revision: revision }, signal),
  diff: (scope: string, skill: string, from: string, to: string, signal?: AbortSignal) =>
    read<MemorySkillDiff>(scope, `/${id(skill)}/diff?${new URLSearchParams({ from_version_id: from, to_version_id: to })}`, signal),
  replayCases: (scope: string, skill: string, signal?: AbortSignal) =>
    read<{ items: MemorySkillReplayCase[] }>(scope, `/${id(skill)}/replay-cases`, signal),
  replay: (scope: string, skill: string, input: { version_id: string; expected_revision: number; case_ids: string[]; idempotency_key: string }, signal?: AbortSignal) =>
    write<MemorySkillReplay>(scope, `/${id(skill)}/replay`, input, signal),
  publish: (scope: string, skill: string, input: { version_id: string; expected_revision: number; expected_publication_revision: number; mode: 'manual' }, signal?: AbortSignal) =>
    write<Record<string, unknown>>(scope, `/${id(skill)}/publish`, input, signal),
  rollback: (scope: string, skill: string, input: { target_version_id: string; expected_revision: number; expected_publication_revision: number }, signal?: AbortSignal) =>
    write<Record<string, unknown>>(scope, `/${id(skill)}/rollback`, input, signal),
  policy: (scope: string, signal?: AbortSignal) => read<MemorySkillPolicyState>(scope, '/policy', signal),
  updatePolicy: (scope: string, revision: number, policy: MemorySkillPolicy, signal?: AbortSignal) =>
    write<MemorySkillPolicyState>(scope, '/policy', { expected_revision: revision, policy }, signal, 'PUT'),
}
