export const IOS_HOST_ACTIONS = [
  { id: 'refresh', danger: false },
  { id: 'restart', danger: false },
  { id: 'alias', danger: false },
  { id: 'kick', danger: true },
  { id: 'unregister', danger: true },
] as const

export type HostActionId = typeof IOS_HOST_ACTIONS[number]['id']
