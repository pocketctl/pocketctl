import { describe, test, expect, vi } from 'vitest'
import { getTokenSummary } from '../db.js'

describe('getTokenSummary daemon scope', () => {
  test('summaries are user-scoped and daemon-filtered', async () => {
    const pool: any = {
      query: vi.fn(async (_sql: string, params: any[]) => {
        const userId = params[0] as number;
        const daemonId = params[1] as string | undefined;

        if (userId === 42 && !daemonId) {
          return { rows: [{ total: 300, today: 50, this_week: 180, this_month: 260 }] };
        }
        if (userId === 42 && daemonId === 'daemon-a') {
          return { rows: [{ total: 180, today: 20, this_week: 100, this_month: 120 }] };
        }
        if (userId === 42 && daemonId === 'daemon-b') {
          return { rows: [{ total: 120, today: 30, this_week: 80, this_month: 140 }] };
        }
        if (userId === 42 && daemonId === 'all') {
          return { rows: [{ total: 300, today: 50, this_week: 180, this_month: 260 }] };
        }
        return { rows: [{ total: 0, today: 0, this_week: 0, this_month: 0 }] };
      }),
    };

    const all = await getTokenSummary(pool, 42);
    const allLiteral = await getTokenSummary(pool, 42, 'all');
    const daemonA = await getTokenSummary(pool, 42, 'daemon-a');
    const daemonB = await getTokenSummary(pool, 42, 'daemon-b');
    const otherUser = await getTokenSummary(pool, 43);

    expect(all).toEqual({ total: 300, today: 50, thisWeek: 180, thisMonth: 260 });
    expect(allLiteral).toEqual({ total: 300, today: 50, thisWeek: 180, thisMonth: 260 });
    expect(daemonA).toEqual({ total: 180, today: 20, thisWeek: 100, thisMonth: 120 });
    expect(daemonB).toEqual({ total: 120, today: 30, thisWeek: 80, thisMonth: 140 });
    expect(otherUser).toEqual({ total: 0, today: 0, thisWeek: 0, thisMonth: 0 });

    const allCalls = pool.query.mock.calls;
    expect(allCalls).toHaveLength(5);
    expect(allCalls[0][1]).toEqual([42]);
    expect(allCalls[0][0]).toContain("s.user_id = $1");
    expect(allCalls[0][0]).not.toContain('s.daemon_id');

    expect(allCalls[1][1]).toEqual([42]);
    expect(allCalls[2][1]).toEqual([42, 'daemon-a']);
    expect(allCalls[3][1]).toEqual([42, 'daemon-b']);
    expect(allCalls[4][1]).toEqual([43]);
    expect(allCalls[2][0]).toContain('s.daemon_id = $2');
    expect(allCalls[3][0]).toContain('s.daemon_id = $2');
  });

  test('daemon predicate is not applied for all scope literals', async () => {
    const pool: any = {
      query: vi.fn(async (_sql: string, params: any[]) => {
        const userId = params[0] as number;
        const daemonId = params[1] as string | undefined;
        if (daemonId === 'all') {
          return { rows: [{ total: 9, today: 1, this_week: 2, this_month: 3 }] };
        }
        if (!daemonId && userId === 42) {
          return { rows: [{ total: 9, today: 1, this_week: 2, this_month: 3 }] };
        }
        return { rows: [{ total: 0, today: 0, this_week: 0, this_month: 0 }] };
      }),
    };

    const explicitAll = await getTokenSummary(pool, 42, 'all');
    const implicitAll = await getTokenSummary(pool, 42);
    expect(explicitAll).toEqual(implicitAll);

    expect(pool.query.mock.calls).toHaveLength(2);
    expect(pool.query.mock.calls[0][1]).toEqual([42]);
    expect(pool.query.mock.calls[1][1]).toEqual([42]);
  });
});
