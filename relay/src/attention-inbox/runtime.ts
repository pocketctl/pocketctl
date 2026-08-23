import type { AttentionInboxMode } from './types.js'

interface LoopTask {
  runOnce?(): Promise<number>
  runMaintenance?(): Promise<number>
}

interface Notifier {
  start(): Promise<void>
  stop(): Promise<void>
}

export function createAttentionInboxRuntime(dependencies: {
  mode: AttentionInboxMode
  projection: LoopTask
  maintenance: LoopTask
  notifier: Notifier
  projectionIntervalMs?: number
  maintenanceIntervalMs?: number
  onError?: (component: 'projection' | 'maintenance' | 'notifier', error: unknown) => void
}) {
  const projectionInterval = Math.max(25, dependencies.projectionIntervalMs ?? 250)
  const maintenanceInterval = Math.max(50, dependencies.maintenanceIntervalMs ?? 5_000)
  let stopped = true
  let projectionTimer: ReturnType<typeof setTimeout> | null = null
  let maintenanceTimer: ReturnType<typeof setTimeout> | null = null
  let projectionFlight: Promise<void> | null = null
  let maintenanceFlight: Promise<void> | null = null

  const projectionLoop = (): void => {
    if (stopped) return
    projectionFlight = (async () => {
      try {
        const count = await dependencies.projection.runOnce?.()
        if (!stopped) projectionTimer = setTimeout(projectionLoop, count && count > 0 ? 0 : projectionInterval)
      } catch (error) {
        dependencies.onError?.('projection', error)
        if (!stopped) projectionTimer = setTimeout(projectionLoop, projectionInterval)
      }
    })().finally(() => { projectionFlight = null })
  }

  const maintenanceLoop = (): void => {
    if (stopped) return
    maintenanceFlight = (async () => {
      try {
        await dependencies.maintenance.runMaintenance?.()
      } catch (error) {
        dependencies.onError?.('maintenance', error)
      } finally {
        if (!stopped) maintenanceTimer = setTimeout(maintenanceLoop, maintenanceInterval)
      }
    })().finally(() => { maintenanceFlight = null })
  }

  return {
    async start(): Promise<void> {
      if (dependencies.mode === 'off' || !stopped) return
      stopped = false
      try {
        await dependencies.notifier.start()
      } catch (error) {
        stopped = true
        dependencies.onError?.('notifier', error)
        throw error
      }
      projectionTimer = setTimeout(projectionLoop, 0)
      maintenanceTimer = setTimeout(maintenanceLoop, 0)
    },
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      if (projectionTimer) clearTimeout(projectionTimer)
      if (maintenanceTimer) clearTimeout(maintenanceTimer)
      await Promise.allSettled([projectionFlight, maintenanceFlight].filter(Boolean))
      await dependencies.notifier.stop()
    },
  }
}
