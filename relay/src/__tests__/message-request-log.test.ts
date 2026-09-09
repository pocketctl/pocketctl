import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MessageRequestLog, logMessageReceipt } from '../message-request-log.js';

let records: any[];
beforeEach(() => {
  records = [];
  vi.spyOn(console, 'log').mockImplementation((line) => records.push(JSON.parse(line)));
});
afterEach(() => vi.restoreAllMocks());

test('four sends with the same business ID remain independently countable across concurrent requests', async () => {
  const log = new MessageRequestLog();
  const socket = {};
  await Promise.all(Array.from({ length: 4 }, (_, index) => log.run(socket, 16,
    { session_id: 's', msg_id: 'm-u16', content: 'private prompt', token: 'secret' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 4 - index));
      log.route('s', `daemon-${index}`);
      log.sent(socket, { type: 'user_message_nack', reason: 'quota_reservation_binding_conflict' }, true);
    })));
  const received = records.filter(row => row.stage === 'received');
  expect(received).toHaveLength(4);
  expect(new Set(received.map(row => row.attempt_id)).size).toBe(4);
  expect(new Set(received.map(row => row.connection_id)).size).toBe(1);
  for (const row of received) {
    const attempt = records.filter(r => r.attempt_id === row.attempt_id);
    expect(attempt.map(r => r.stage)).toEqual(['received', 'rejected', 'finished']);
    expect(attempt[2]).toMatchObject({ outcome: 'rejected', daemon_id: attempt[1].daemon_id });
  }
  expect(JSON.stringify(records)).not.toMatch(/private prompt|secret/);
});

test('bounds untrusted fields and never logs payloads, error text or receipt content', async () => {
  const log = new MessageRequestLog();
  await expect(log.run({}, 16, {
    session_id: '\nforged log', msg_id: 'x'.repeat(10000), content: '秘密', authorization: 'secret-token',
  }, async () => { throw new Error('password=secret-password'); })).rejects.toThrow('secret-password');
  logMessageReceipt(16, 'd1', {
    type: 'user_message_receipt', request_id: 'r1', status: 'accepted', reason: 'bad\nline', content: 'private receipt',
  });
  expect(records[0]).toMatchObject({ session_id: null, msg_id: null, content_bytes: 6 });
  expect(records[1]).toMatchObject({ stage: 'failed', reason: 'handler_exception' });
  expect(records[3]).toMatchObject({ stage: 'receipt_received', request_id: 'r1', reason: null });
  expect(JSON.stringify(records)).not.toMatch(/秘密|secret-|forged|private receipt/);
});

test('logging failures never prevent the handler from running', async () => {
  vi.mocked(console.log).mockImplementation(() => { throw new Error('log unavailable'); });
  const handler = vi.fn(async () => {});
  await new MessageRequestLog().run({}, 16, {}, handler);
  expect(handler).toHaveBeenCalledOnce();
});
