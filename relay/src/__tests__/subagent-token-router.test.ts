import { describe, test, expect, vi, beforeEach } from 'vitest'

process.env.DAEMON_OFFLINE_GRACE_MS = '20'

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    persistEvent: vi.fn().mockResolvedValue(1),
    getUserPlanAndWhitelist: vi.fn().mockResolvedValue({ plan: 'pro', whitelist: false }),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    setDaemonOnline: vi.fn().mockResolvedValue(undefined),
    getDaemonAlias: vi.fn().mockResolvedValue(null),
    getDaemonOwner: vi.fn().mockResolvedValue(null),
    addSubagentUsage: actual.addSubagentUsage,
  }
})

import * as db from '../db.js'
import { Router } from '../router.js'

function createMockPool() {
  // seen 表 INSERT：首次 rowCount=1（新），重复 rowCount=0（已 seen）
  const seenSeqs = new Set<string>()
  return {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (/subagent_usage_seen/i.test(sql) && /ON CONFLICT DO NOTHING/i.test(sql)) {
        const key = `${params[0]}:${params[1]}`
        if (seenSeqs.has(key)) return { rowCount: 0 }
        seenSeqs.add(key)
        return { rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
  } as any
}
function createMockWs() {
  const sent: any[] = []
  return { readyState: 1, send: vi.fn((d: string) => sent.push(JSON.parse(d))), close: vi.fn(), _sent: sent } as any
}
async function setupDaemon(router: Router, daemonId = 'd1', ackedSeq = 0) {
  const ws = createMockWs()
  await router.registerDaemon(ws, { type: 'register', daemon_id: daemonId, hostname: 'h', agents: [], acked_seq: ackedSeq }, null)
  return { ws, daemonId }
}

describe('router subagent_usage 幂等去重 (P1a)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test('重复 seq 的 subagent_usage → addSubagentUsage 仅调一次；首次传 cache_create', async () => {
    const usageSpy = vi.spyOn(db, 'addSubagentUsage').mockResolvedValue(undefined)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    const msg = {
      type: 'subagent_usage', session_id: 'parent-1', agent_id: 'agent-x', seq: 5,
      usage: { input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_create_tokens: 30 },
    }
    // First delivery — daemon starts at acked_seq=4, seq=5 is new
    router.handleDaemonMessage(daemonId, msg as any)
    await new Promise((r) => setTimeout(r, 50))

    // Simulate daemon restart: re-register with same daemonId but different startedAt + acked_seq=4.
    // This resets persistedHigh to 4, so seq=5 passes the early-return guard again.
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: daemonId, hostname: 'h', agents: [], acked_seq: 4, started_at: 99999 }, null)
    router.handleDaemonMessage(daemonId, msg as any) // replay after restart
    await new Promise((r) => setTimeout(r, 80))

    expect(usageSpy).toHaveBeenCalledTimes(1) // 幂等：重复 seq 不重复累加
    const call = usageSpy.mock.calls[0]
    expect(call[1]).toBe('parent-1')   // parentId
    expect(call[2]).toBe('agent-x')    // agentId
    expect(call[6]).toBe(30)           // cache_create（第 7 参数，补传）

    usageSpy.mockRestore()
  })

  test('内容指纹去重：同一份 per-turn usage 用不同 seq 重放也只累加一次', async () => {
    // 场景：daemon incarnation 切换后 seq 计数器 reset，subagent tailer 从 offset 0
    // 重读 child JSONL，把同一行 assistant 的 usage 用「新 seq」再发一次。
    // 旧逻辑（按 seq 去重 + incarnation 清表）会把这次重放当成新 delta 累加 → 滚到 10^16。
    // 新逻辑按内容指纹 (daemon_id, usage_hash) 去重，应只计入一次。
    const usageSpy = vi.spyOn(db, 'addSubagentUsage').mockResolvedValue(undefined)
    const router = new Router(createMockPool())
    const { daemonId } = await setupDaemon(router)

    const usage = { input_tokens: 100, output_tokens: 200, cache_read_tokens: 50, cache_create_tokens: 30 }
    // 首次：seq=5
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'parent-1', agent_id: 'agent-x', seq: 5, usage } as any)
    await new Promise((r) => setTimeout(r, 50))
    // incarnation 切换：重置 persistedHigh 到 4
    const ws2 = createMockWs()
    await router.registerDaemon(ws2, { type: 'register', daemon_id: daemonId, hostname: 'h', agents: [], acked_seq: 4, started_at: 99999 }, null)
    // 重放：同一份 usage 但 seq=6（新 incarnation 的新 seq）
    router.handleDaemonMessage(daemonId, { type: 'subagent_usage', session_id: 'parent-1', agent_id: 'agent-x', seq: 6, usage } as any)
    await new Promise((r) => setTimeout(r, 80))

    expect(usageSpy).toHaveBeenCalledTimes(1) // 内容相同 → 只累加一次，seq 不同也无妨
    usageSpy.mockRestore()
  })
})
