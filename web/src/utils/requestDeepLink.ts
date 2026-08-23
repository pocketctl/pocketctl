const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function normalizeRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null
}

export function findRequestMessage<T extends { request_id?: string }>(
  messages: readonly T[],
  requestId: string,
): T | undefined {
  return messages.find(message => message.request_id === requestId)
}

export function scrollToRequest(root: ParentNode, requestId: string): boolean {
  const target = Array.from(root.querySelectorAll<HTMLElement>('[data-request-id]'))
    .find(element => element.dataset.requestId === requestId)
  if (!target) return false

  target.classList.remove('request-deep-link-target')
  void target.offsetWidth
  target.classList.add('request-deep-link-target')
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  return true
}
