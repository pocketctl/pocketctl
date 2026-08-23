import { describe, expect, it, vi } from 'vitest';
import { APP_REVIEW_DEMO_DAEMON_ID, ensureAppReviewDemoData, isAppReviewDemoDaemon, isAppReviewDemoSession } from '../app-review-demo.js';

describe('App Review demo data', () => {
  it('recognizes only the dedicated demo daemon', () => {
    expect(isAppReviewDemoDaemon(APP_REVIEW_DEMO_DAEMON_ID)).toBe(true);
    expect(isAppReviewDemoDaemon('real-daemon')).toBe(false);
    expect(isAppReviewDemoSession('app-review-demo-ios-release')).toBe(true);
    expect(isAppReviewDemoSession('real-session')).toBe(false);
  });

  it('seeds a host, three sessions, and replay events idempotently', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as any;

    await ensureAppReviewDemoData(pool, 42);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('INSERT INTO daemons');
    expect(sql).toContain('ON CONFLICT (daemon_id) DO UPDATE');
    expect(sql.match(/INSERT INTO sessions/g)).toHaveLength(3);
    expect(sql).toContain('INSERT INTO events');
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
