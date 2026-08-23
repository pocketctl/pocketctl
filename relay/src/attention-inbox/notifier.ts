import type pg from 'pg'

interface NotificationMessage {
  channel: string
  payload?: string
}

interface NotificationClient extends Pick<pg.PoolClient, 'query' | 'release'> {
  on(event: 'notification', listener: (message: NotificationMessage) => void): unknown
  off(event: 'notification', listener: (message: NotificationMessage) => void): unknown
}

interface AttentionNotification {
  entity: 'item' | 'recovery'
  userID: number
  itemID: string
  revision: number
  operation: 'changed' | 'removed'
}

export interface AttentionNotifierDependencies {
  pool: { connect(): Promise<NotificationClient> }
  loadItem(userId: number, itemId: string, revision: number): Promise<unknown | null>
  loadRecovery?: (userId: number, itemId: string, revision: number) => Promise<unknown | null>
  recoveryVisible?: boolean
  broadcast(userId: number, payload: unknown): void
}

function parseNotification(message: NotificationMessage): AttentionNotification | null {
  if (message.channel !== 'pocketctl_attention' || !message.payload) return null
  try {
    const value = JSON.parse(message.payload) as Record<string, unknown>
    const userID = value.user_id
    const itemID = value.item_id
    const revision = value.revision
    const operation = value.operation
    const entity = value.entity === undefined || value.entity === 'item'
      ? 'item'
      : value.entity === 'recovery' ? 'recovery' : null
    if (typeof userID !== 'number' || !Number.isSafeInteger(userID) || userID <= 0) return null
    if (typeof itemID !== 'string' || !itemID) return null
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return null
    if (operation !== 'changed' && operation !== 'removed') return null
    if (!entity) return null
    return { entity, userID, itemID, revision, operation }
  } catch {
    return null
  }
}

export function createAttentionNotifier(dependencies: AttentionNotifierDependencies) {
  let client: NotificationClient | null = null

  const onNotification = (message: NotificationMessage): void => {
    const notification = parseNotification(message)
    if (!notification) return
    void (async () => {
      if (notification.entity === 'recovery') {
        if (!dependencies.recoveryVisible || !dependencies.loadRecovery) return
        if (notification.operation === 'removed') {
          dependencies.broadcast(notification.userID, {
            type: 'attention_recovery_removed', schema_version: 2,
            recovery_id: notification.itemID, last_revision: notification.revision,
            reason: 'retention',
          })
          return
        }
        const recovery = await dependencies.loadRecovery(
          notification.userID, notification.itemID, notification.revision,
        )
        if (recovery === null) return
        dependencies.broadcast(notification.userID, {
          type: 'attention_recovery_changed', schema_version: 2, recovery,
        })
        return
      }
      if (notification.operation === 'removed') {
        dependencies.broadcast(notification.userID, {
          type: 'attention_item_removed',
          schema_version: 1,
          item_id: notification.itemID,
          last_revision: notification.revision,
          reason: 'retention',
        })
        return
      }
      const item = await dependencies.loadItem(
        notification.userID,
        notification.itemID,
        notification.revision,
      )
      if (item === null) return
      dependencies.broadcast(notification.userID, {
        type: 'attention_item_changed', schema_version: 1, item,
      })
    })().catch(() => {
      // REST snapshot recovery is authoritative when a transient notification load fails.
    })
  }

  return {
    async start(): Promise<void> {
      if (client) return
      const connected = await dependencies.pool.connect()
      try {
        connected.on('notification', onNotification)
        await connected.query('LISTEN pocketctl_attention')
        client = connected
      } catch (error) {
        connected.off('notification', onNotification)
        connected.release()
        throw error
      }
    },
    async stop(): Promise<void> {
      const connected = client
      if (!connected) return
      client = null
      try {
        await connected.query('UNLISTEN pocketctl_attention')
      } finally {
        connected.off('notification', onNotification)
        connected.release()
      }
    },
  }
}
