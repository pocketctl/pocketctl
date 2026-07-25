import { describe, expect, test } from 'vitest'
import { resolveInteractionReadiness } from '../useInteractionReadiness'

describe('resolveInteractionReadiness', () => {
  test.each(['offline', 'connecting', 'syncing'] as const)('%s connectivity disables interactions', connectivity => {
    expect(resolveInteractionReadiness({ connectivity, requestStatus: 'pending' })).toMatchObject({
      canInteract: false,
      state: connectivity,
    })
  })

  test('only a ready pending request can be acted on', () => {
    expect(resolveInteractionReadiness({ connectivity: 'ready', requestStatus: 'pending' })).toEqual({
      canInteract: true,
      state: 'ready',
      reasonKey: '',
    })
    expect(resolveInteractionReadiness({ connectivity: 'ready', requestStatus: 'resolved' }).canInteract).toBe(false)
  })

  test('submitting timeout becomes unknown and never becomes actionable again', () => {
    expect(resolveInteractionReadiness({
      connectivity: 'ready',
      requestStatus: 'pending',
      submitting: true,
    }).state).toBe('submitting')

    expect(resolveInteractionReadiness({
      connectivity: 'ready',
      requestStatus: 'pending',
      resultUnknown: true,
    })).toMatchObject({ canInteract: false, state: 'unknown' })
  })

  test('resolved elsewhere remains locked', () => {
    expect(resolveInteractionReadiness({
      connectivity: 'ready',
      requestStatus: 'resolved',
      resolvedElsewhere: true,
    })).toMatchObject({ canInteract: false, state: 'resolved' })
  })
})
