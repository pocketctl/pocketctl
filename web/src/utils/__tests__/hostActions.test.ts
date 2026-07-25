import { describe, expect, test } from 'vitest'
import { IOS_HOST_ACTIONS } from '../hostActions'

describe('host actions', () => {
  test('matches the five actions exposed by the iOS host action sheet', () => {
    expect(IOS_HOST_ACTIONS.map(action => action.id)).toEqual([
      'refresh',
      'restart',
      'alias',
      'kick',
      'unregister',
    ])
  })
})
