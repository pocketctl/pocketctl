import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../db.js', async original => ({
  ...await original<typeof import('../db.js')>(),
  getSessionRuntimePolicy: vi.fn(),
  getUserPlanAndWhitelist: vi.fn(async () => ({ plan: 'free', whitelist: false })),
  getSessionDaemonId: vi.fn(async () => null),
}));
vi.mock('../session-message-admissions.js', async original => ({
  ...await original<typeof import('../session-message-admissions.js')>(),
  resolveMessageSessionId: vi.fn(async () => null),
  admitSessionMessage: vi.fn(),
}));
import * as db from '../db.js';
import { admitSessionMessage, resolveMessageSessionId } from '../session-message-admissions.js';
import { Router } from '../router.js';

let records: any[];
const command = { type: 'user_message', session_id: 's1', msg_id: 'm-u16', content: 'private prompt' };
function socket(): any { return { readyState: 1, send: vi.fn(), close: vi.fn() }; }
function setup() {
  const router = new Router({ query: vi.fn(async () => ({ rows: [] })) } as any);
  const client = socket(), daemon = socket();
  router.registerClient(client, 16);
  (router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 16 });
  (router as any).sessionToDaemon.set('s1', 'd1');
  vi.spyOn(router as any, 'broadcastQuotaStatus').mockResolvedValue(undefined);
  return { router, client, daemon };
}
beforeEach(() => {
  vi.clearAllMocks(); records = [];
  vi.spyOn(console, 'log').mockImplementation(line => {
    if (typeof line === 'string' && line.startsWith('{')) records.push(JSON.parse(line));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(resolveMessageSessionId).mockResolvedValue(null);
  vi.mocked(db.getSessionRuntimePolicy).mockResolvedValue({ daemonId: 'd1', agentType: 'codex', status: 'idle' } as any);
  vi.mocked(admitSessionMessage).mockResolvedValue({ kind: 'continue', reused: false,
    admission: { id: 'grant1', expiresAt: new Date(Date.now() + 20000) } } as any);
});
afterEach(() => vi.restoreAllMocks());

test('records actual received, admission, daemon write and ACK with one attempt ID', async () => {
  const { router, client, daemon } = setup();
  await router.handleClientMessage(client, command);
  expect(records.map(r => r.stage)).toEqual(['received', 'admitted', 'forwarded', 'ack', 'finished']);
  expect(new Set(records.map(r => r.attempt_id)).size).toBe(1);
  expect(records.at(-1)).toMatchObject({ outcome: 'forwarded', user_id: 16, daemon_id: 'd1', request_id: 'm-u16' });
  expect(daemon.send).toHaveBeenCalledOnce();
  expect(JSON.parse(daemon.send.mock.calls[0][0])).not.toHaveProperty('attempt_id');
  expect(JSON.stringify(records)).not.toContain(command.content);
});

test.each([
  ['conflict', { kind: 'conflict' }, 'rejected', 'quota_reservation_binding_conflict'],
  ['duplicate', { kind: 'continue', reused: true, admission: { id: 'grant1', expiresAt: new Date() } }, 'duplicate', 'request_in_progress'],
  ['quota', { kind: 'resume', decision: { allowed: false, reason: 'concurrent_session_quota_exceeded' } }, 'rejected', 'concurrent_session_quota_exceeded'],
])('%s logs its disposition without forwarding', async (_, decision, outcome, reason) => {
  const { router, client, daemon } = setup();
  vi.mocked(admitSessionMessage).mockResolvedValue(decision as any);
  await router.handleClientMessage(client, command);
  expect(daemon.send).not.toHaveBeenCalled();
  expect(records.at(-1)).toMatchObject({ stage: 'finished', outcome });
  expect(records).toContainEqual(expect.objectContaining({ reason }));
});

test('disconnected daemon, authorization denial and canonical lookup errors are observable', async () => {
  const { router, client, daemon } = setup();
  daemon.readyState = 3;
  await router.handleClientMessage(client, command);
  expect(records).toContainEqual(expect.objectContaining({ stage: 'rejected', reason: 'daemon_offline' }));
  vi.mocked(db.getSessionRuntimePolicy).mockResolvedValueOnce(null);
  await router.handleClientMessage(client, command);
  expect(records).toContainEqual(expect.objectContaining({ stage: 'rejected', reason: 'session_not_found_or_not_owned' }));
  vi.mocked(resolveMessageSessionId).mockRejectedValueOnce(new Error('lookup failure'));
  await router.handleClientMessage(client, command);
  expect(records).toContainEqual(expect.objectContaining({ stage: 'rejected', reason: 'quota_check_failed' }));
  expect(records.filter(r => r.stage === 'received')).toHaveLength(3);
});

test('socket closing during admission is not logged as a successful daemon write', async () => {
  const { router, client, daemon } = setup();
  vi.mocked(admitSessionMessage).mockImplementationOnce(async () => {
    daemon.readyState = 3;
    return { kind: 'continue', reused: false, admission: { id: 'grant1', expiresAt: new Date() } } as any;
  });
  await router.handleClientMessage(client, command);
  expect(daemon.send).not.toHaveBeenCalled();
  expect(records).toContainEqual(expect.objectContaining({ stage: 'forward_skipped', transport: 'socket_not_open' }));
  expect(records.at(-1).outcome).toBe('forward_skipped');
});

test('send exceptions are logged and still propagate', async () => {
  const { router, client, daemon } = setup();
  daemon.send.mockImplementation(() => { throw new Error('socket failed'); });
  await expect(router.handleClientMessage(client, command)).rejects.toThrow('socket failed');
  expect(records.at(-1)).toMatchObject({ outcome: 'failed' });
  expect(records.some(r => r.stage === 'forwarded')).toBe(false);
});

test('logs daemon receipts before persistence without mistaking them for new client attempts', () => {
  const { router } = setup();
  vi.spyOn(router as any, 'persistAndAck').mockImplementation(() => {});
  router.handleDaemonMessage('d1', { type: 'user_message_receipt', session_id: 's1', msg_id: 'm-u16', request_id: 'm-u16', status: 'accepted' });
  expect(records).toEqual([expect.objectContaining({ stage: 'receipt_received', user_id: 16, daemon_id: 'd1', status: 'accepted' })]);
});

test('does not log unrelated client commands', async () => {
  const { router, client } = setup();
  await router.handleClientMessage(client, { type: 'set_locale', locale: 'zh' });
  expect(records).toEqual([]);
});

test('four conflicting sends count as four received attempts, not one business request', async () => {
  const { router, client, daemon } = setup();
  vi.mocked(admitSessionMessage).mockResolvedValue({ kind: 'conflict' });
  await Promise.all(Array.from({ length: 4 }, () => router.handleClientMessage(client, { ...command })));
  const received = records.filter(r => r.stage === 'received');
  expect(received).toHaveLength(4);
  expect(new Set(received.map(r => r.attempt_id)).size).toBe(4);
  expect(new Set(received.map(r => r.request_id))).toEqual(new Set(['m-u16']));
  expect(records.filter(r => r.stage === 'rejected' && r.reason === 'quota_reservation_binding_conflict')).toHaveLength(4);
  expect(daemon.send).not.toHaveBeenCalled();
});
