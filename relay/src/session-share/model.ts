/** Read-only projection: keep source records even when a protocol is unknown/incomplete. */
type Payload = Record<string, unknown>;
export interface ShareEvent { event_type?: string; created_at?: string | Date; payload?: unknown; [key: string]: unknown }
export interface ShareItem {
  kind: 'user' | 'agent' | 'tool' | 'detail' | 'notice';
  label: string; text: string; time: string; actor: string; scope: string;
  input?: unknown; output?: string; failed?: boolean; incomplete?: boolean;
  status?: string; revision?: number; eventId?: string; streaming?: boolean;
  records: ShareEvent[];
  streamOutput?: boolean;
}
export interface ShareTurn { id: string; items: ShareItem[]; records: ShareEvent[] }
const privateTypes = new Set(['session_document_begin', 'session_document_chunk', 'session_document_commit', 'session_documents_changed']);
const failures = new Set(['failed', 'error', 'interrupted', 'cancelled', 'canceled', 'aborted']);
export const str = (value: unknown): string => typeof value === 'string' ? value : '';
export function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}
function payload(event: ShareEvent): Payload {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Payload : {};
}
function timestamp(event: ShareEvent): string {
  if (event.created_at instanceof Date) return event.created_at.toISOString();
  return str(event.created_at);
}
function actorName(p: Payload): string {
  const agent = str(p.agent);
  const name = ({ codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', zcode: 'ZCode' } as Record<string, string>)[agent] || agent || 'Agent';
  return p.agent_id ? `${name} · 子 Agent ${str(p.agent_id)}` : name;
}
function streamDisplayId(id: string): string {
  return id.replace(/^codex:[0-9]+:stream:(agent_text|agent_reasoning):([^:]+):([^:]+):(.+)$/, 'codex:stream:$1:$2:$3:$4');
}

/** Assemble durable chunks offline: sequence AND UTF-8 byte offsets must be contiguous. */
function assemble(records: ShareEvent[], output: boolean): { text: string; incomplete: boolean } {
  const streams = new Map<string, Map<number, Payload>>();
  let malformed = false;
  for (const record of records) {
    const p = payload(record);
    if (!p.stream_id) continue;
    const seq = p.chunk_seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) { malformed = true; continue; }
    const id = str(p.stream_id);
    const chunks = streams.get(id) ?? new Map<number, Payload>();
    const old = chunks.get(seq);
    const chunkText = (value: Payload) => output ? readable(value.output ?? value.result) : str(value.text ?? value.content);
    if (old && (old.byte_offset !== p.byte_offset || chunkText(old) !== chunkText(p)
      || (old.total_bytes !== undefined && p.total_bytes !== undefined && old.total_bytes !== p.total_bytes))) malformed = true;
    else if (!old || old.final !== true || p.final === true) chunks.set(seq, p);
    streams.set(id, chunks);
  }
  let best = { text: '', incomplete: true };
  for (const chunks of streams.values()) {
    let bytes = 0; let text = ''; let final = false; let count = 0;
    for (let seq = 0; chunks.has(seq); seq++) {
      const chunk = chunks.get(seq)!;
      if (chunk.byte_offset !== bytes) break;
      const content = output ? readable(chunk.output ?? chunk.result) : str(chunk.text ?? chunk.content);
      text += content;
      bytes += Buffer.byteLength(content);
      count++;
      if (chunk.final === true) {
        final = chunk.total_bytes === undefined || chunk.total_bytes === bytes;
        break;
      }
    }
    const candidate = { text, incomplete: !final || count !== chunks.size || malformed };
    // Replay generations can contain a shorter prefix. Keep the longest compatible view.
    if (text.startsWith(best.text)) best = candidate;
    else if (!best.text.startsWith(text)) best = { ...candidate, incomplete: true };
  }
  return best;
}

export function projectShareEvents(events: ShareEvent[]): ShareTurn[] {
  const turns: ShareTurn[] = [];
  const byTurn = new Map<string, ShareTurn>();
  const identities = new Map<string, ShareItem>();
  const seen = new Set<string>();
  let current: ShareTurn | undefined;
  let userOrdinal = 0;
  const makeTurn = () => { const t: ShareTurn = { id: `turn-${turns.length + 1}`, items: [], records: [] }; turns.push(t); return t; };
  for (const event of events) {
    const p = payload(event);
    const type = str(event.event_type) || str(p.type) || 'event';
    // Either discriminator can identify private document protocol data.
    if (privateTypes.has(type) || privateTypes.has(str(p.type))) continue;
    const owner = JSON.stringify([str(event.session_id ?? p.session_id), str(p.agent_id)]);
    const turnId = str(p.turn_id);
    const eventKey = str(p.event_id);
    const unique = eventKey ? JSON.stringify([owner, type, eventKey]) : '';
    if (unique && seen.has(unique)) continue;
    if (unique) seen.add(unique);
    const isUser = type === 'user_text';
    const nativeUserId = str(p.msg_id) || str(p.request_id) || str(p.message_id) || str(p.part_id);
    const userKey = nativeUserId ? JSON.stringify([owner, 'user', turnId, nativeUserId]) : '';
    let priorUser = userKey ? identities.get(userKey) : undefined;
    const canonicalTurnKey = turnId ? JSON.stringify([owner, turnId]) : '';
    let turn = canonicalTurnKey ? byTurn.get(canonicalTurnKey) : undefined;
    // Native Claude history can echo an admitted input under a different identity.
    // Bridge exactly once using a known turn and exact text; never dedup by text alone.
    if (isUser && !priorUser && turnId && p.message_id && !p.msg_id && !p.request_id) {
      const latest = (turn ?? current)?.items.filter(row => row.kind === 'user').at(-1);
      if (latest && latest.text === str(p.text ?? p.content)
        && latest.records.some(record => {
          const source = payload(record);
          return source.turn_id === turnId && (source.msg_id || source.request_id);
        }) && !latest.records.some(record => payload(record).message_id)) {
        priorUser = latest;
        if (userKey) identities.set(userKey, latest);
      }
    }
    if (isUser && !priorUser) {
      userOrdinal++;
      if (!turn) turn = makeTurn();
      current = turn;
    }
    turn ??= current ?? makeTurn();
    current ??= turn;
    if (canonicalTurnKey && !byTurn.has(canonicalTurnKey)) byTurn.set(canonicalTurnKey, turn);
    turn.records.push(event);
    const scope = JSON.stringify([owner, turnId || `legacy:${userOrdinal}`]);
    const text = str(p.snapshot ?? p.text ?? p.content);
    const item = (kind: ShareItem['kind'], label: string, content: string): ShareItem => ({
      kind, label, text: content, time: timestamp(event), actor: actorName(p), scope, records: [event],
    });
    if (isUser) {
      if (priorUser) { priorUser.records.push(event); continue; }
      if (!text) { turn.items.push(item('detail', '用户记录', readable(event.payload))); continue; }
      const row = item('user', '用户', text);
      turn.items.push(row);
      if (userKey) identities.set(userKey, row);
      continue;
    }
    if (type === 'agent_text' || type === 'agent_reasoning') {
      const streamId = str(p.stream_id);
      const partId = str(p.part_id);
      const messageId = str(p.message_id);
      const identity = streamId ? `stream:${streamDisplayId(streamId)}` : partId ? `part:${messageId}:${partId}` : messageId ? `message:${messageId}` : '';
      const key = identity ? JSON.stringify([scope, type, identity]) : '';
      let row = key ? identities.get(key) : undefined;
      const last = turn.items.at(-1);
      // Legacy append streams have no stable ID. Only merge adjacent, same-owner live chunks.
      if (!identity && last?.scope === scope && last.kind === (type === 'agent_text' ? 'agent' : 'detail') && last.streaming && !text.startsWith('\n')) row = last;
      if (!row) {
        if (!text && !streamId) { turn.items.push(item('detail', '消息元数据', readable(event.payload))); continue; }
        row = item(type === 'agent_text' ? 'agent' : 'detail', type === 'agent_text' ? actorName(p) : '思考过程', '');
        row.records = [];
        turn.items.push(row);
        if (key) identities.set(key, row);
      }
      row.records.push(event);
      if (streamId) {
        row.streamOutput = false;
      } else {
        // Full snapshots may restart revision numbering after a runtime restart.
        // A causal predecessor takes priority; otherwise a larger revision wins.
        const revision = typeof p.revision === 'number' ? p.revision : undefined;
        const causal = !!p.previous_event_id && row.eventId === p.previous_event_id;
        if (eventKey && row.records.some(r => payload(r).previous_event_id === eventKey)) continue;
        if (row.revision !== undefined && revision !== undefined && revision <= row.revision && !causal) continue;
        if (p.previous_event_id && row.eventId && !causal) {
          // Do not replace a known successor with its replayed ancestor.
          if (row.records.some(r => payload(r).previous_event_id === p.event_id)) continue;
        }
        row.text = p.snapshot !== undefined ? str(p.snapshot) : p.replace === true ? text : row.text + text;
        row.revision = revision;
        row.eventId = eventKey;
        row.streaming = p.streaming === true;
        row.incomplete = row.streaming;
      }
      continue;
    }
    if (type === 'tool_call' || type === 'tool_result') {
      const callId = str(p.call_id);
      const key = callId ? JSON.stringify([scope, 'tool', callId]) : '';
      let row = key ? identities.get(key) : undefined;
      if (!row) {
        row = item('tool', str(p.tool) || '工具操作', ''); row.records = []; row.status = '未收到完成记录';
        turn.items.push(row);
        if (key) identities.set(key, row);
      }
      row.records.push(event);
      if (type === 'tool_call') { row.input = p.input; row.label = str(p.tool) || row.label; }
      else {
        if (p.stream_id) row.streamOutput = true;
        row.output = readable(p.output ?? p.result);
        row.incomplete = p.streaming === true;
        row.failed = row.failed || p.is_error === true || !!p.error || failures.has(str(p.status)) || (typeof p.exit_code === 'number' && p.exit_code !== 0);
        if (p.error) row.output += `\n${readable(p.error)}`;
        row.status = row.failed ? '执行失败' : row.incomplete ? '输出尚不完整' : '已收到结果';
      }
      continue;
    }
    if (type === 'error' || type === 'agent_retry' || (type === 'turn_status' && failures.has(str(p.turn_status))) || (type === 'session_exit' && (failures.has(str(p.exit_reason)) || !!p.error))) {
      const label = type === 'agent_retry' ? '执行重试记录' : p.turn_status === 'interrupted' ? '执行已中断' : '执行异常记录';
      const row = item('notice', label, readable(p.error ?? p.message ?? p.turn_reason ?? p.exit_reason ?? p.content) || '详情见原始记录。');
      row.failed = true;
      turn.items.push(row);
      continue;
    }
    // Unknown/control/structured records stay available, but do not interrupt the prose.
    const names: Record<string, string> = { agent_plan: '执行计划', agent_file_change: '文件变更', approval_request: '审批记录（只读）', question_request: '提问记录（只读）', turn_status: '执行状态', session_meta: '会话信息' };
    turn.items.push(item('detail', names[type] || `其他记录 · ${type}`, readable(event.payload)));
  }
  for (const turn of turns) for (const row of turn.items) {
    if (row.streamOutput === undefined) continue;
    const update = assemble(row.records, row.streamOutput);
    row.incomplete = update.incomplete;
    if (row.streamOutput) {
      row.output = update.text;
      row.status = row.failed ? '执行失败' : update.incomplete ? '输出尚不完整' : '已收到结果';
    } else row.text = update.text;
  }
  return turns;
}
