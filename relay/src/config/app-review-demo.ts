import type pg from 'pg';

export const APP_REVIEW_DEMO_DAEMON_ID = 'app-review-demo-host';

export function isAppReviewDemoDaemon(daemonId: string | null | undefined): boolean {
  return daemonId === APP_REVIEW_DEMO_DAEMON_ID;
}

export function isAppReviewDemoSession(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith('app-review-demo-');
}

interface DemoSession {
  id: string;
  agent: string;
  cwd: string;
  title: string;
  source: string;
  status: string;
  model: string;
  minutesAgo: number;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
}

const demoSessions: DemoSession[] = [
  {
    id: 'app-review-demo-ios-release',
    agent: 'codex', cwd: '~/projects/pocketctl', source: 'app_review_demo', status: 'running',
    title: '准备 iOS 1.0 App Store 发布', model: 'gpt-5.3-codex', minutesAgo: 2,
    events: [
      { type: 'user_text', payload: { type: 'user_text', content: '检查 iOS 发版配置和 App Store 提交材料。' } },
      { type: 'agent_text', payload: { type: 'agent_text', content: '已检查当前项目配置。版本号、Bundle ID、隐私政策和应用图标均已准备完成。' } },
      { type: 'tool_call', payload: { type: 'tool_call', tool: 'Read', input: { file_path: 'ios/project.yml' } } },
      { type: 'tool_result', payload: { type: 'tool_result', tool: 'Read', content: 'MARKETING_VERSION: 1.0.0\nCURRENT_PROJECT_VERSION: 1' } },
      { type: 'agent_text', payload: { type: 'agent_text', content: '接下来可以选择构建版本并提交审核。' } },
    ],
  },
  {
    id: 'app-review-demo-session-sync',
    agent: 'claude-code', cwd: '~/projects/pocketctl', source: 'app_review_demo', status: 'completed',
    title: '优化跨设备会话同步', model: 'claude-opus-4-6', minutesAgo: 18,
    events: [
      { type: 'user_text', payload: { type: 'user_text', content: '检查会话在手机和电脑之间的同步状态。' } },
      { type: 'agent_text', payload: { type: 'agent_text', content: '同步检查完成，历史消息和会话状态均已更新。' } },
    ],
  },
  {
    id: 'app-review-demo-host-monitoring',
    agent: 'opencode', cwd: '~/projects/demo', source: 'app_review_demo', status: 'completed',
    title: '查看开发主机运行状态', model: 'anthropic/claude-sonnet-4', minutesAgo: 45,
    events: [
      { type: 'user_text', payload: { type: 'user_text', content: '汇总当前开发主机和 Agent 状态。' } },
      { type: 'agent_text', payload: { type: 'agent_text', content: '演示主机运行正常，三个 AI 编程 Agent 已连接。' } },
    ],
  },
];

/** Idempotently provision read-only data used only by the App Review account. */
export async function ensureAppReviewDemoData(pool: pg.Pool, userId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO daemons (daemon_id, hostname, agents, status, last_heartbeat, user_id, alias, arch, version)
       VALUES ($1, $2, $3, 'online', NOW(), $4, $5, $6, $7)
       ON CONFLICT (daemon_id) DO UPDATE SET
         hostname = EXCLUDED.hostname, agents = EXCLUDED.agents, status = 'online',
         last_heartbeat = NOW(), user_id = EXCLUDED.user_id, alias = EXCLUDED.alias,
         arch = EXCLUDED.arch, version = EXCLUDED.version`,
      [APP_REVIEW_DEMO_DAEMON_ID, 'App Review Mac', JSON.stringify([
        { type: 'claude-code', version: '2.1.95', latest: '2.1.95', manageable: false },
        { type: 'codex', version: '0.142.3', latest: '0.142.3', manageable: false },
        { type: 'opencode', version: '1.17.11', latest: '1.17.11', manageable: false },
      ]), userId, '演示主机', 'arm64', '1.0.0']
    );

    for (const session of demoSessions) {
      await client.query(
        `INSERT INTO sessions
           (session_id, daemon_id, agent_type, cwd, title, source, status, created_at,
            updated_at, last_activity_at, user_id, model, pinned)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 NOW() - ($8 * INTERVAL '1 minute'), NOW() - ($8 * INTERVAL '1 minute'),
                 NOW() - ($8 * INTERVAL '1 minute'), $9, $10, $11)
         ON CONFLICT (session_id) DO UPDATE SET
           daemon_id = EXCLUDED.daemon_id, agent_type = EXCLUDED.agent_type,
           cwd = EXCLUDED.cwd, title = EXCLUDED.title, source = EXCLUDED.source,
           status = EXCLUDED.status, user_id = EXCLUDED.user_id, model = EXCLUDED.model`,
        [session.id, APP_REVIEW_DEMO_DAEMON_ID, session.agent, session.cwd, session.title,
          session.source, session.status, session.minutesAgo, userId, session.model,
          session.id === 'app-review-demo-ios-release']
      );

      for (let index = 0; index < session.events.length; index++) {
        const event = session.events[index];
        const payload = { ...event.payload, session_id: session.id, status: session.status };
        await client.query(
          `INSERT INTO events (session_id, event_type, payload, event_hash, created_at)
           VALUES ($1, $2, $3, $4, NOW() - ($5 * INTERVAL '1 minute'))
           ON CONFLICT (session_id, event_hash) DO NOTHING`,
          [session.id, event.type, JSON.stringify(payload), `review-${index}-${session.id}`.slice(0, 32),
            Math.max(session.minutesAgo - index, 0)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
