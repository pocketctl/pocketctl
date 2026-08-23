import { describe, expect, test, vi } from 'vitest';

// eventHashInput is module-private by design; insertEvent exposes its effect
// through the (session_id, event_hash) upsert key. The stub pool records the
// computed hash so the tests below pin the DB fallback behavior directly —
// the tier the ingress-level buildDedupKey tests never touch (review P1-8).
const pgMock = vi.hoisted(() => ({ Pool: class {} }));
vi.mock('pg', () => ({ default: pgMock, ...pgMock }));

const { insertEvent } = await import('../db.js');

function captureHashPool() {
  const captured: { hash: string; payload: string }[] = [];
  const pool: any = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (/INSERT INTO events/i.test(sql)) {
        captured.push({ hash: params[3], payload: params[2] });
        return { rows: [{ id: captured.length }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool, captured };
}

const enrichment = {
  source_turn_id: 'turn:v1:codex:abc',
  turn_origin: 'native',
  turn_confidence: 'native',
  actor_scope: 'root',
  flow_scope: 'main',
  content_class: 'dialogue',
  classifier_version: 'v1',
};

describe('db event fallback hash excludes turn enrichment (review P1-8)', () => {
  test('fallback tier: pre/post-upgrade deliveries of the same content hash identically', async () => {
    const legacy = captureHashPool();
    await insertEvent(legacy.pool, 'session-1', 'user_text', {
      type: 'user_text', session_id: 'session-1', text: 'hi', seq: 5,
    });
    const enriched = captureHashPool();
    await insertEvent(enriched.pool, 'session-1', 'user_text', {
      type: 'user_text', session_id: 'session-1', text: 'hi', seq: 5,
      turn_id: 'turn:v1:claude-code:rec-1',
      ...enrichment,
    });
    expect(legacy.captured[0].hash).toBe(enriched.captured[0].hash);
    // The persisted payload keeps the enrichment — only the identity hash strips it.
    expect(JSON.parse(enriched.captured[0].payload).classifier_version).toBe('v1');
  });

  test('fallback tier still discriminates different content and seq', async () => {
    const a = captureHashPool();
    await insertEvent(a.pool, 'session-1', 'user_text', {
      type: 'user_text', session_id: 'session-1', text: 'hi', seq: 5, ...enrichment,
    });
    const b = captureHashPool();
    await insertEvent(b.pool, 'session-1', 'user_text', {
      type: 'user_text', session_id: 'session-1', text: 'hi again', seq: 5, ...enrichment,
    });
    const c = captureHashPool();
    await insertEvent(c.pool, 'session-1', 'user_text', {
      type: 'user_text', session_id: 'session-1', text: 'hi', seq: 6, ...enrichment,
    });
    expect(a.captured[0].hash).not.toBe(b.captured[0].hash);
    expect(a.captured[0].hash).not.toBe(c.captured[0].hash);
  });

  test('event_id tier: enrichment never changes the identity hash', async () => {
    const withId = captureHashPool();
    await insertEvent(withId.pool, 'session-1', 'agent_text', {
      type: 'agent_text', event_id: 'evt-9', text: 'reply', ...enrichment,
    });
    const withIdBare = captureHashPool();
    await insertEvent(withIdBare.pool, 'session-1', 'agent_text', {
      type: 'agent_text', event_id: 'evt-9', text: 'reply',
    });
    expect(withId.captured[0].hash).toBe(withIdBare.captured[0].hash);
  });
});
