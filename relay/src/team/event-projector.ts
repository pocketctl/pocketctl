import type { MaterializationInput } from '../materialization/types.js'
import { dispatchProjectionKind } from './dispatch-repository.js'

const receiptTypes = new Set([
  'session_created', 'collaboration_dispatch_receipt',
  'collaboration_context_receipt', 'collaboration_config_receipt',
])

export interface TeamDaemonEventProjector {
  handleDaemonEvent(daemonId: string, ownerUserId: number, message: Record<string, unknown>, daemonGeneration?: number, materializedEventId?: number | null): Promise<void>
}

/** Ingress identity is trusted; collaboration payload identity is not. */
export function createTeamEventProjector(service: TeamDaemonEventProjector) {
  return async (input: MaterializationInput, materializedEventId?: number | null): Promise<void> => {
    if (input.userId === null || input.userId <= 0 || input.eventType !== input.payload.type) return
    if (!dispatchProjectionKind(input.payload)
      && !(receiptTypes.has(input.eventType) && input.payload.collaboration)) return
    await service.handleDaemonEvent(input.daemonId, input.userId, input.payload, input.daemonGeneration, materializedEventId)
  }
}
