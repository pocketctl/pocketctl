import { describe, expect, test } from 'vitest';
import { projectShareEvents, type ShareEvent } from '../session-share/model.js';
import { shareViewerPage } from '../session-share/render.js';
const event = (type: string, data: Record<string, unknown> = {}): ShareEvent => ({ event_type: type, created_at: '2026-10-20T06:20:00Z', payload: { type, ...data } });
const rows = (events: ShareEvent[]) => projectShareEvents(events).flatMap(turn => turn.items);

describe('public share reading projection', () => {
  test('same user text in distinct inputs remains separate; correlated replay deduplicates', () => {
    const result = rows([event('user_text', { text: '继续', msg_id: '1' }), event('user_text', { text: '继续', msg_id: '1' }), event('user_text', { text: '继续', msg_id: '2' })]);
    expect(result.filter(r => r.kind === 'user').map(r => r.text)).toEqual(['继续', '继续']);
  });
  test('native echo merges once by known turn, without collapsing a second native input', () => {
    const result = rows([
      event('user_text', { text: '继续', msg_id: 'admitted', turn_id: 't' }),
      event('agent_text', { text: '处理中', agent: 'claude-code', turn_id: 't' }),
      event('user_text', { text: '继续', message_id: 'native1', turn_id: 't' }),
      event('user_text', { text: '继续', message_id: 'native2', turn_id: 't' }),
    ]);
    expect(result.filter(row => row.kind === 'user')).toHaveLength(2);
  });
  test('late messages attach to their explicit turn without moving into the current turn', () => {
    const turns = projectShareEvents([
      event('user_text', { text: 'first', msg_id: '1', turn_id: 't1' }),
      event('user_text', { text: 'second', msg_id: '2', turn_id: 't2' }),
      event('agent_text', { text: 'late first', turn_id: 't1', agent: 'codex' }),
      event('agent_text', { text: 'second reply', turn_id: 't2' }),
    ]);
    expect(turns.map(turn => turn.items.map(row => row.text))).toEqual([['first', 'late first'], ['second', 'second reply']]);
  });
  test('optional agent labels do not break tool/result ownership', () => {
    const result = rows([event('tool_call', { call_id: 'a', agent: 'codex', input: 'read' }), event('tool_result', { call_id: 'a', output: 'done' })]);
    expect(result).toHaveLength(1);
    expect(result[0].output).toBe('done');
  });
  test('plain legacy chunks concatenate only while adjacent and streaming', () => {
    const result = rows([event('agent_text', { text: '你', streaming: true }), event('agent_text', { text: '好', streaming: false }), event('agent_text', { text: '独立回复' })]);
    expect(result.map(r => r.text)).toEqual(['你好', '独立回复']);
  });
  test('revisioned snapshots replace deltas and stale revisions cannot regress', () => {
    const base = { message_id: 'm', part_id: 'p', turn_id: 't' };
    const result = rows([event('agent_text', { ...base, revision: 1, text: '你', snapshot: '你' }), event('agent_text', { ...base, revision: 3, text: '世界', snapshot: '你好世界' }), event('agent_text', { ...base, revision: 2, snapshot: '你好' })]);
    expect(result.map(r => r.text)).toEqual(['你好世界']);
  });
  test('causal replay ancestor cannot replace a successor after revision reset', () => {
    const base = { part_id: 'p', turn_id: 't' };
    const result = rows([event('agent_text', { ...base, revision: 1, event_id: 'b', previous_event_id: 'a', snapshot: 'new' }), event('agent_text', { ...base, revision: 10, event_id: 'a', snapshot: 'old' })]);
    expect(result.map(r => r.text)).toEqual(['new']);
  });
  test('identity does not cross actor or turn boundaries', () => {
    const result = rows([event('agent_text', { part_id: 'p', revision: 1, turn_id: 'a', text: 'root' }), event('agent_text', { part_id: 'p', revision: 2, turn_id: 'a', agent_id: 'child', text: 'child' }), event('agent_text', { part_id: 'p', revision: 3, turn_id: 'b', text: 'next' })]);
    expect(result.map(r => r.text)).toEqual(['root', 'child', 'next']);
  });
  test('out of order UTF-8 streams assemble once and duplicate chunks do not repeat text', () => {
    const base = { stream_id: 's', turn_id: 't' };
    const first = event('agent_text', { ...base, chunk_seq: 0, byte_offset: 0, text: '你好' });
    const result = rows([event('agent_text', { ...base, chunk_seq: 1, byte_offset: 6, text: '世界', final: true, total_bytes: 12 }), first, first]);
    expect(result[0].text).toBe('你好世界');
    expect(result[0].incomplete).toBe(false);
  });
  test('a replay of a non-final chunk cannot undo final completion', () => {
    const base = { stream_id: 's', chunk_seq: 0, byte_offset: 0, text: 'done' };
    const result = rows([event('agent_text', { ...base, final: true, total_bytes: 4 }), event('agent_text', base)]);
    expect(result[0]).toMatchObject({ text: 'done', incomplete: false });
  });
  test('normal session exit is not presented as an execution failure', () => {
    expect(rows([event('session_exit', { exit_reason: 'completed' })])[0].kind).toBe('detail');
  });
  test('stream gaps show an incomplete warning and retain raw chunks', () => {
    const events = [event('agent_text', { stream_id: 's', chunk_seq: 0, byte_offset: 0, text: 'start' }), event('agent_text', { stream_id: 's', chunk_seq: 2, byte_offset: 9, text: 'tail', final: true })];
    expect(rows(events)[0]).toMatchObject({ text: 'start', incomplete: true });
    expect(shareViewerPage(events)).toContain('回复尚不完整');
    expect(shareViewerPage(events)).toContain('tail');
  });
  test('shorter codex runtime replay cannot regress a complete stream', () => {
    const result = rows([event('agent_text', { stream_id: 'codex:1:stream:agent_text:s:t:m', chunk_seq: 0, byte_offset: 0, text: 'complete', final: true, total_bytes: 8 }), event('agent_text', { stream_id: 'codex:2:stream:agent_text:s:t:m', chunk_seq: 0, byte_offset: 0, text: 'com' })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: 'complete', incomplete: false });
  });
  test('tool result before its call pairs once; missing result never implies success', () => {
    const result = rows([event('tool_result', { call_id: 'a', output: 'ok' }), event('tool_call', { call_id: 'a', tool: 'Read', input: { path: 'a.ts' } }), event('tool_call', { call_id: 'b', tool: 'Bash' })]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ label: 'Read', output: 'ok', input: { path: 'a.ts' }, status: '已收到结果' });
    expect(result[1].status).toBe('未收到完成记录');
  });
  test('tool failures and turn interruptions are visible outside collapsed details', () => {
    const html = shareViewerPage([event('tool_call', { call_id: 'a', tool: 'Bash' }), event('tool_result', { call_id: 'a', is_error: true, output: 'denied' }), event('turn_status', { turn_status: 'interrupted', turn_reason: 'cancelled' })]);
    expect(html).toContain('class="process-status failed">包含失败记录');
    expect(html).toContain('<aside class="warning">');
    expect(html).toContain('执行已中断');
  });
  test('unknown records stay discoverable and private document payload discriminator is filtered', () => {
    const html = shareViewerPage([{ event_type: 'unknown', payload: { type: 'session_document_chunk', chunk_data: 'PRIVATE' } }, event('future_event', { hello: 'retained' })]);
    expect(html).not.toContain('PRIVATE');
    expect(html).toContain('retained');
    expect(html).toContain('其他记录 · future_event');
  });
});

describe('public share HTML', () => {
  test('renders markdown, tables, fenced code and plain user text safely', () => {
    const html = shareViewerPage([event('user_text', { text: '**literal**' }), event('agent_text', { text: '# Heading\n\n**bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```html\n<script>alert(1)</script>\n```\n\n<script>alert(2)</script>\n\n[x](javascript:alert(3))\n\n![tracking](https://example.com/pixel)\n\n[relative](../danger)\n\n[valid](https://example.com)' })]);
    expect(html).toContain('<h1>Heading</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('**literal**');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/<script|<img|<iframe|<form|href="javascript:|href="\.\./i);
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('[图片：tracking]');
  });
  test('empty page and truthful timestamps replace frozen snapshot claim', () => {
    const html = shareViewerPage([], { readAt: new Date('2026-10-20T06:30:00Z'), expiresAt: new Date('2026-10-20T06:45:00Z') });
    expect(html).toContain('暂无可显示的会话内容');
    expect(html).toContain('2026-10-20 06:45 UTC');
    expect(html).toContain('内容截至本次打开时');
    expect(html).not.toContain('完整会话快照');
  });
});
