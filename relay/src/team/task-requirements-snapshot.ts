import { parseTaskRequirements, taskReadiness } from './task-readiness.js'

/** Read only while the caller holds the task row lock. The returned text belongs
 * to the immutable execution event, never to a live lookup during dispatch. */
export function frozenTaskRequirementsText(task: {
  requirements?: unknown
  requirements_revision?: unknown
  requirements_override?: unknown
}): string {
  if (task.requirements == null) return ''
  const revision = Number(task.requirements_revision)
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid requirements snapshot revision')
  const document = parseTaskRequirements(task.requirements)
  let override: {actor_user_id: number; reason: string; requirements_revision: number} | null = null
  const value = task.requirements_override as Record<string, unknown> | null | undefined
  if (value != null) {
    if (typeof value !== 'object' || Array.isArray(value)
      || !Number.isSafeInteger(value.actor_user_id) || Number(value.actor_user_id) < 1
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000
      || value.reason.includes('\0') || value.requirements_revision !== revision) {
      throw new Error('invalid requirements snapshot override')
    }
    override = {actor_user_id: Number(value.actor_user_id), reason: value.reason, requirements_revision: revision}
  }
  return '\n\n本次执行冻结的任务需求（后续编辑不改变本次输入；仓库引用不授予访问权限，需求覆盖不替代交付验收）：\n'
    + JSON.stringify({revision, document, readiness: taskReadiness(document), override})
}
