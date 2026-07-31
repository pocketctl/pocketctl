export type InteractionConnectivity = 'offline' | 'connecting' | 'syncing' | 'ready'
export type InteractionReadinessState =
  | InteractionConnectivity
  | 'submitting'
  | 'unknown'
  | 'resolved'

export interface InteractionReadinessInput {
  connectivity: InteractionConnectivity
  requestStatus: string
  submitting?: boolean
  resultUnknown?: boolean
  resolvedElsewhere?: boolean
}

export interface InteractionReadiness {
  canInteract: boolean
  state: InteractionReadinessState
  reasonKey: string
}

export function resolveInteractionReadiness(input: InteractionReadinessInput): InteractionReadiness {
  if (input.requestStatus !== 'pending' || input.resolvedElsewhere) {
    return { canInteract: false, state: 'resolved', reasonKey: 'interaction.resolved' }
  }
  if (input.resultUnknown) {
    return { canInteract: false, state: 'unknown', reasonKey: 'interaction.unknown' }
  }
  if (input.submitting) {
    return { canInteract: false, state: 'submitting', reasonKey: 'interaction.submitting' }
  }
  if (input.connectivity !== 'ready') {
    return {
      canInteract: false,
      state: input.connectivity,
      reasonKey: `interaction.${input.connectivity}`,
    }
  }
  return { canInteract: true, state: 'ready', reasonKey: '' }
}
