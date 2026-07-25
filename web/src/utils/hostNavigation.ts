export function hostSessionsLocation(daemonId: string) {
  return {
    path: '/sessions',
    query: { host: daemonId },
  }
}
