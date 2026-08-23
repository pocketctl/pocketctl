import { describe, expect, test } from 'vitest'
import { findRequestMessage, normalizeRequestId, scrollToRequest } from '../requestDeepLink'

describe('request deep links', () => {
  test('accepts only bounded identifiers that are safe to use in selectors', () => {
    expect(normalizeRequestId('codex:1:req_abc-123')).toBe('codex:1:req_abc-123')
    expect(normalizeRequestId('')).toBeNull()
    expect(normalizeRequestId('../approval')).toBeNull()
    expect(normalizeRequestId('x'.repeat(129))).toBeNull()
    expect(normalizeRequestId(['request'])).toBeNull()
  })

  test('can locate a request after it arrives later', () => {
    const messages: Array<{ request_id?: string; status?: string }> = []

    expect(findRequestMessage(messages, 'req_1')).toBeUndefined()
    messages.push({ request_id: 'req_1', status: 'resolved' })
    expect(findRequestMessage(messages, 'req_1')).toMatchObject({ status: 'resolved' })
  })

  test('scrolls and highlights the matching request without changing its state', () => {
    const root = document.createElement('div')
    const card = document.createElement('div')
    const scrollIntoView = () => undefined
    Object.assign(card, { scrollIntoView })
    card.dataset.requestId = 'req_2'
    card.dataset.status = 'resolved'
    root.append(card)

    expect(scrollToRequest(root, 'req_2')).toBe(true)
    expect(card.classList.contains('request-deep-link-target')).toBe(true)
    expect(card.dataset.status).toBe('resolved')
  })
})
