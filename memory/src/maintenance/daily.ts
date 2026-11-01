export const dailyMaintenanceSchedule={timeZone:'Asia/Shanghai',dailyAt:'03:00',windowMs:7_200_000,continuationMs:1000} as const
/** Daily maintenance uses a fixed Asia/Shanghai civil day, independent of host TZ. */
const DAY = 86_400_000, OFFSET = 8 * 3_600_000
export function dailyMaintenanceSlot(now = new Date()): Date | null {
  const local = new Date(now.getTime() + OFFSET)
  const slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3) - OFFSET
  return now.getTime() >= slot ? new Date(slot) : null
}
export function nextDailyMaintenanceAt(now = new Date()): Date {
  const local = new Date(now.getTime() + OFFSET)
  const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3) - OFFSET
  return new Date(today > now.getTime() ? today : today + DAY)
}
export const DAILY_MAINTENANCE_MIGRATION = { version: 75, statements: [
  `CREATE TABLE memory_maintenance_runs (
    scheduled_at TIMESTAMPTZ NOT NULL, scope_key TEXT NOT NULL,
    installation_id UUID REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    stage INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'running' CHECK(state IN('running','completed')),
    counts JSONB NOT NULL DEFAULT '{}', cursor JSONB NOT NULL DEFAULT '{}',
    revision BIGINT NOT NULL DEFAULT 1, reported_revision BIGINT NOT NULL DEFAULT 0, reported_at TIMESTAMPTZ, report_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error_code TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
    PRIMARY KEY(scheduled_at,scope_key), CHECK((scope_key='global')=(installation_id IS NULL))
  )`,
  `CREATE INDEX memory_maintenance_pending ON memory_maintenance_runs(next_attempt_at,scheduled_at,scope_key) WHERE state='running'`,
] } as const
