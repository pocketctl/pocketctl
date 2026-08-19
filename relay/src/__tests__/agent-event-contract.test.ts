import { describe, expect, test, vi } from 'vitest';
import { agentEventContracts } from './fixtures/agent-event-contracts.js';
import { buildDedupKey, classifyDaemonEvent } from '../ingress/event-policy.js';
import { Router } from '../router.js';

function createRouterPool(): any {
  const pool: any = {
    query: vi.fn(async (sql: string) => {
      if (/INSERT INTO events/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  };
  pool.connect = vi.fn(async () => ({ query: pool.query, release: vi.fn() }));
  return pool;
}

function createDaemonWs(): any {
  const sent: any[] = [];
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    _sent: sent,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('agent event compatibility contract', () => {
  test.each(agentEventContracts)('$agent $name preserves the exact payload', ({ payload, expectedPriority }) => {
    const before = structuredClone(payload);
    const policy = classifyDaemonEvent(payload);
    expect(payload).toEqual(before);
    expect(policy.durable).toBe((payload.type as string) !== 'ping');
    expect(policy.priority).toBe(expectedPriority);
  });
});

describe('daemon event ingress policy', () => {
  test.each([
    { name: 'ping is ephemeral control', payload: { type: 'ping' }, durable: false, priority: 'control' },
    { name: 'title generation is ephemeral aggregate', payload: { type: 'generate_title_request' }, durable: false, priority: 'aggregate' },
    { name: 'subagent title generation is ephemeral aggregate', payload: { type: 'generate_subagent_title_request' }, durable: false, priority: 'aggregate' },
    { name: 'title update is ephemeral aggregate', payload: { type: 'session_title_update' }, durable: false, priority: 'aggregate' },
    { name: 'daemon shutdown is ephemeral control', payload: { type: 'daemon_shutdown' }, durable: false, priority: 'control' },
    { name: 'takeover cancellation is ephemeral control', payload: { type: 'cancel_takeover' }, durable: false, priority: 'control' },
    { name: 'session create failure is durable control', payload: { type: 'session_create_failed' }, durable: true, priority: 'control' },
    { name: 'model list is ephemeral control', payload: { type: 'model_list' }, durable: false, priority: 'control' },
    { name: 'upgrade result is ephemeral control', payload: { type: 'upgrade_result' }, durable: false, priority: 'control' },
    { name: 'host-level error is ephemeral control', payload: { type: 'error' }, durable: false, priority: 'control' },
    { name: 'session error remains durable live data', payload: { type: 'error', session_id: 'session-1' }, durable: true, priority: 'live' },
    { name: 'ordinary content is live', payload: { type: 'agent_text' }, durable: true, priority: 'live' },
  ] as const)('$name', ({ payload, durable, priority }) => {
    expect(classifyDaemonEvent(payload)).toEqual({ durable, priority });
  });

  test('prefers event id, then request id, then generation sequence for deduplication', () => {
    expect(buildDedupKey('daemon-1', 7, 9, {
      session_id: 'session-1', type: 'approval_request', event_id: 'event-1', request_id: 'request-1',
    })).toBe('session-1:approval_request:event:event-1');
    expect(buildDedupKey('daemon-1', 7, 9, {
      session_id: 'session-1', type: 'approval_request', event_id: '', request_id: 'request-1',
    })).toBe('session-1:approval_request:request:request-1');
    expect(buildDedupKey('daemon-1', 7, 9, {
      session_id: 'session-1', type: 'approval_request', event_id: '', request_id: '',
    })).toBe('daemon-1:7:9');
  });

  test('observes durable and receipt-only daemon events with a sequence', () => {
    const observeIngressClass = vi.fn();
    const router = new Router({ query: vi.fn() } as any, { observeIngressClass });

    router.handleDaemonMessage('daemon-1', { type: 'agent_text', seq: 1 });
    router.handleDaemonMessage('daemon-1', { type: 'ping', seq: 2 });
    router.handleDaemonMessage('daemon-1', { type: 'agent_text' });

    expect(observeIngressClass).toHaveBeenCalledTimes(2);
    expect(observeIngressClass).toHaveBeenCalledWith('daemon-1', 'live');
    expect(observeIngressClass).toHaveBeenCalledWith('daemon-1', 'control');
  });

  test('isolates a throwing observer and still persists the durable event', async () => {
    const pool = createRouterPool();
    const daemonWs = createDaemonWs();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = new Router(pool, {
      observeIngressClass: () => { throw new Error('observer failed'); },
    });

    try {
      await router.registerDaemon(daemonWs, {
        type: 'register', daemon_id: 'daemon-1', hostname: 'host', agents: [], started_at: 100,
      }, 1);
      daemonWs._sent.length = 0;

      expect(() => router.handleDaemonMessage('daemon-1', {
        type: 'agent_text', session_id: 'session-1', seq: 1,
      })).not.toThrow();
      await tick();

      expect(pool.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO events/i), expect.any(Array));
      expect((router as any).daemonSeq.get('daemon-1').persistedHigh).toBe(1);
      router.handleDaemonMessage('daemon-1', { type: 'ping' });
      expect(daemonWs._sent).toContainEqual(expect.objectContaining({ type: 'event_ack', up_to_seq: 1 }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
