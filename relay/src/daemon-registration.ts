export interface DaemonSocketIdentity {
  daemonId: string
  startedAt: number
}

interface DaemonRegistrationRouter {
  registerDaemon(
    socket: any,
    message: any,
    userId: number | null,
    tokenJti?: string,
    machineId?: string,
  ): Promise<boolean>
  unregisterDaemon(daemonId: string, socket?: any): void
}

/**
 * Bridges the server socket lifecycle to Router activation. The provisional
 * identity lets a close event unregister the socket even while registration is
 * awaiting DB work. Cleanup is identity-guarded so an older attempt cannot
 * erase a newer socket assignment.
 */
export async function registerDaemonConnection(
  router: DaemonRegistrationRouter,
  identities: Map<any, DaemonSocketIdentity>,
  socket: any,
  message: any,
  userId: number | null,
  tokenJti?: string,
  machineId?: string,
  releaseAdmission?: () => void,
): Promise<boolean> {
  const identity: DaemonSocketIdentity = {
    daemonId: message.daemon_id,
    startedAt: message.started_at || 0,
  }
  identities.set(socket, identity)
  let registered: boolean
  try {
    registered = await router.registerDaemon(socket, message, userId, tokenJti, machineId)
  } catch (error) {
    releaseAdmission?.()
    if (identities.get(socket) === identity) identities.delete(socket)
    throw error
  }
  releaseAdmission?.()
  if (!registered) {
    if (identities.get(socket) === identity) identities.delete(socket)
    return false
  }
  // The close handler removes the provisional identity. If that happened
  // after Router activation, immediately hand the active socket back through
  // normal disconnect cleanup instead of leaving an unreachable connection.
  if (identities.get(socket) !== identity) {
    router.unregisterDaemon(identity.daemonId, socket)
    return false
  }
  return true
}
