export type MetricKey = 'newUsers' | 'activeUsers' | 'sessions' | 'memory' | 'memoryUsers' | 'readRequests'
export interface Metric { value: number | null; status: 'complete' | 'partial' | 'unavailable'; coverageStart: string | null; reason?: string }
export type Metrics = Record<MetricKey, Metric>
export interface DailyMetrics { date: string; newUsers: Metric; activeUsers: Metric; sessions: Metric; memory: Metric }
export interface StatisticsResponse {
  definitionVersion: 'platform-statistics-v2'; generatedAt: string; dataThroughByMetric: Record<MetricKey, string | null>; timezone: 'Asia/Shanghai'; dataThrough: string
  range: { from: string; to: string }; previousRange: { from: string; to: string }; comparisonAvailable: boolean
  metrics: Metrics; previous: Metrics; daily: DailyMetrics[]; previousDaily: DailyMetrics[]
  memorySources: { automatic: Metric; manual: Metric; unclassified: Metric }
  actualUse: { value: null; status: 'unconfirmed' }; exclusions: string[]; warnings: string[]
}
export interface MemoryActor { installationId: string; membershipId?: string; readRequests: number; writeRequests: number; humanActivity?: boolean }
export interface MemoryPeriod {
  memory: number; automatic: number; manual: number; unclassified: number
  daily: Array<{ date: string; memory: number; automatic: number; manual: number; unclassified: number }>
  actors: MemoryActor[]; dailyActors: Array<MemoryActor & { date: string }>
}
export interface MemorySnapshot {
  coverageStart: string | null; dataThrough: string
  gaps: Array<{ metric: 'memory' | 'usage'; from: string; to: string }>
  periods: { current: MemoryPeriod; previous: MemoryPeriod }; actorLimitExceeded: boolean
}
export type MemoryReader = (bounds: { from: string; to: string; previousFrom: string; previousTo: string; excludeInstallationIds?: string[] }) => Promise<MemorySnapshot>
