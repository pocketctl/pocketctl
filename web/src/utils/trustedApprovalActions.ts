export type TrustedApprovalAction = 'once' | 'always' | 'reject' | 'cancel'

interface ApprovalMessage {
  approvalKind?: string
  availableDecisions?: unknown
  always?: unknown
  securityContext?: unknown
}

interface SecurityContext {
  schema_version: 1
  risk_level: 'low' | 'medium' | 'high' | 'critical'
  classification_incomplete: boolean
  risk_reasons: string[]
  allowed_actions: string[]
}

const canonicalActions = new Set<TrustedApprovalAction>(['once', 'always', 'reject', 'cancel'])

function nativeActions(message: ApprovalMessage, supportsActions: boolean): TrustedApprovalAction[] {
  if (Array.isArray(message.availableDecisions) && message.availableDecisions.length > 0) {
    const mapped: TrustedApprovalAction[] = []
    for (const value of message.availableDecisions) {
      const action = value === 'accept' ? 'once'
        : value === 'acceptForSession' ? 'always'
          : value === 'decline' ? 'reject'
            : value === 'cancel' ? 'cancel'
              : null
      if (action && !mapped.includes(action)) mapped.push(action)
    }
    return mapped
  }
  if (supportsActions) {
    return ['once', ...(Array.isArray(message.always) && message.always.length > 0 ? ['always' as const] : []), 'reject']
  }
  return ['once', 'reject']
}

function validContext(value: unknown): SecurityContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const context = value as Record<string, unknown>
  if (context.schema_version !== 1
    || typeof context.risk_level !== 'string'
    || !['low', 'medium', 'high', 'critical'].includes(context.risk_level)
    || typeof context.classification_incomplete !== 'boolean'
    || !Array.isArray(context.risk_reasons)
    || !Array.isArray(context.allowed_actions)) return null
  if (!context.risk_reasons.every(reason => typeof reason === 'string')
    || !context.allowed_actions.every(action => typeof action === 'string')) return null
  return context as unknown as SecurityContext
}

export function trustedApprovalActions(
  message: ApprovalMessage,
  supportsActions: boolean,
  trustedPolicy: boolean,
): TrustedApprovalAction[] {
  const native = nativeActions(message, supportsActions)
  const context = trustedPolicy ? validContext(message.securityContext) : null
  if (context === null) return native.filter(action => action !== 'always')

  const advertised = new Set(
    context.allowed_actions.filter((action): action is TrustedApprovalAction => canonicalActions.has(action as TrustedApprovalAction)),
  )
  const persistentAllowed = !context.classification_incomplete
    && (context.risk_level === 'low' || context.risk_level === 'medium')
  return native.filter(action => advertised.has(action) && (action !== 'always' || persistentAllowed))
}
