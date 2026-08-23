import { describe, expect, test } from 'vitest'
import { useSessionHeader } from '../useSessionHeader'

describe('session header state', () => {
  test('publishes compact session identity and clears it on route exit', () => {
    const { sessionHeader, setSessionHeader, clearSessionHeader } = useSessionHeader()
    setSessionHeader({ title: 'Long-running migration', host: 'build-mac', status: 'running', statusLabel: 'Running' })
    expect(sessionHeader.value).toEqual({ title: 'Long-running migration', host: 'build-mac', status: 'running', statusLabel: 'Running' })
    clearSessionHeader()
    expect(sessionHeader.value).toEqual({ title: '', host: '', status: '', statusLabel: '' })
  })
})
