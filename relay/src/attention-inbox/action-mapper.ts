import type { AttentionAction, AttentionProvider, AttentionRiskLevel } from './types.js'

export interface ApprovalActionSource {
  provider: AttentionProvider | string
  availableDecisions?: string[]
  alwaysRules?: string[]
  controlMode?: string | null
  riskLevel?: AttentionRiskLevel
  classificationIncomplete?: boolean
  enforcedAllowedActions?: string[]
}

const ACTIONS: Record<'once' | 'always' | 'reject' | 'cancel', AttentionAction> = {
  once: {
    id: 'once', style: 'primary', destructive: false, labelKey: 'attention.action.once',
  },
  always: {
    id: 'always', style: 'secondary', destructive: false, labelKey: 'attention.action.always',
  },
  reject: {
    id: 'reject', style: 'danger', destructive: true, labelKey: 'attention.action.reject',
  },
  cancel: {
    id: 'cancel', style: 'secondary', destructive: false, labelKey: 'attention.action.cancel',
  },
}

const QUESTION_ACTIONS: AttentionAction[] = [
  {
    id: 'answer', style: 'primary', destructive: false, labelKey: 'attention.action.answer',
  },
  {
    id: 'reject', style: 'danger', destructive: true, labelKey: 'attention.action.reject',
  },
]

function persistentScopeAllowed(source: ApprovalActionSource): boolean {
  if (source.classificationIncomplete !== false) return false
  return source.riskLevel === 'low' || source.riskLevel === 'medium'
}

function codexAction(decision: string): keyof typeof ACTIONS | null {
  switch (decision) {
    case 'accept':
    case 'once':
      return 'once'
    case 'acceptForSession':
    case 'always':
      return 'always'
    case 'decline':
    case 'reject':
      return 'reject'
    case 'cancel':
      return 'cancel'
    default:
      return null
  }
}

export function mapApprovalActions(source: ApprovalActionSource): AttentionAction[] {
	const enforced = Array.isArray(source.enforcedAllowedActions)
		? new Set(source.enforcedAllowedActions)
		: null
  if (source.provider === 'codex') {
    const seen = new Set<string>()
    const actions: AttentionAction[] = []
    for (const decision of source.availableDecisions ?? []) {
      const id = codexAction(decision)
      if (id === null || seen.has(id)) continue
      if (id === 'always' && !persistentScopeAllowed(source)) continue
      if (enforced !== null && !enforced.has(id)) continue
      if (id === 'always' && enforced === null) continue
      seen.add(id)
      actions.push(ACTIONS[id])
    }
    return actions
  }
  if (source.provider === 'opencode') {
    if (source.controlMode !== 'managed') return []
    const actions = enforced === null || enforced.has('once') ? [ACTIONS.once] : []
    if (enforced?.has('always') && persistentScopeAllowed(source) && (source.alwaysRules?.length ?? 0) > 0) {
      actions.push(ACTIONS.always)
    }
    if (enforced === null || enforced.has('reject')) actions.push(ACTIONS.reject)
    return actions
  }
  return []
}

export function mapQuestionActions(source: {
  provider: AttentionProvider | string
  controlMode?: string | null
  questions?: unknown[]
}): AttentionAction[] {
  if ((source.questions?.length ?? 0) === 0) return []
  const supported = source.provider === 'codex'
    || (source.provider === 'opencode' && source.controlMode === 'managed')
  if (!supported) return []
  const questions = source.questions ?? []
  const answerable = questions.length <= 16 && questions.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const question = raw as Record<string, unknown>
    if (question.custom === true) return true
    if (!Array.isArray(question.options) || question.options.length === 0) return false
    return question.options.every((option) => (typeof option === 'string' && option.length > 0)
      || (option !== null && typeof option === 'object'
        && typeof (option as Record<string, unknown>).label === 'string'
        && ((option as Record<string, unknown>).label as string).length > 0))
  })
  return answerable ? [...QUESTION_ACTIONS] : [ACTIONS.reject]
}
