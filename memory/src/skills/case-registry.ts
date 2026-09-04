import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { z } from 'zod'
import type { SkillReplayCaseRegistry } from './replay-service.js'
import { ReplayCaseSchema, type ReplayCase } from './replay-runner.js'

const Registry = z.object({ schema_version: z.literal('skill-replay-registry.v1'), cases: z.array(ReplayCaseSchema).max(256) }).strict()
export interface TrustedSkillCaseRegistry extends SkillReplayCaseRegistry {
  listCases(input: Omit<Parameters<SkillReplayCaseRegistry['loadCases']>[0], 'caseIds'>): Promise<ReplayCase[]>
}
/** Operator-owned local recording registry. No network, commands, or client-provided responses.
 * Re-read on each access so removing a recording immediately revokes its evidence. */
export function createFileSkillCaseRegistry(path?: string): TrustedSkillCaseRegistry {
  async function read(): Promise<ReplayCase[]> {
    if (!path) return []
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 16_384_000 || (stat.mode & 0o022) !== 0) throw new Error('skill_registry_invalid')
      const buffer = Buffer.alloc(16_384_001)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 16_384_000) throw new Error('skill_registry_invalid')
      const parsed = Registry.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')))
      if (!parsed.success) throw new Error('skill_registry_invalid')
      const ids = parsed.data.cases.map(c => `${c.installation_id}:${c.version_id}:${c.case_id}`)
      if (new Set(ids).size !== ids.length) throw new Error('skill_registry_invalid')
      return parsed.data.cases
    } finally { await file.close() }
  }
  const listCases: TrustedSkillCaseRegistry['listCases'] = async input => (await read()).filter(c =>
    c.installation_id === input.installationId && c.repository_id === input.repositoryId
    && c.repo_snapshot_id === input.repoSnapshotId && c.version_id === input.versionId
    && c.document_hash === input.documentHash && c.policy_hash === input.policyHash)
  return { listCases, async loadCases(input) { return (await listCases(input)).filter(c => input.caseIds.includes(c.case_id)) } }
}
