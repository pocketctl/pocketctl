export const agentEventContracts = [
  {
    agent: 'opencode',
    name: 'permission question and revisioned part',
    expectedPriority: 'control',
    payload: {
      type: 'question_request', session_id: 'ses_oc', request_id: 'q1',
      questions: [{ id: 'q', question: 'Proceed?', options: [{ label: 'Yes' }] }],
      control_mode: 'managed', event_id: 'oc:q1', seq: 11,
    },
  },
  {
    agent: 'claude-code',
    name: 'native approval',
    expectedPriority: 'control',
    payload: {
      type: 'approval_request', session_id: 'ses_claude', request_id: 'a1',
      approval_kind: 'tool', tool: 'Bash', available_decisions: ['once', 'reject'],
      event_id: 'claude:a1', seq: 12,
    },
  },
  {
    agent: 'codex',
    name: 'structured plan snapshot',
    expectedPriority: 'live',
    payload: {
      type: 'agent_plan', session_id: 'thr_root', part_id: 'plan:thr_root',
      event_id: 'codex:plan:call_2', previous_event_id: 'codex:plan:call_1', revision: 2,
      explanation: 'Starting the UI',
      plan: [
        { step: 'Define protocol', status: 'completed' },
        { step: 'Implement UI', status: 'in_progress' },
      ],
      seq: 14,
    },
  },
  {
    agent: 'codex',
    name: 'subagent historical content',
    expectedPriority: 'replay',
    payload: {
      type: 'agent_text', session_id: 'thr_root', agent_id: 'thr_child',
      parent_session_id: 'thr_root', root_session_id: 'thr_root', is_subagent: true,
      part_id: 'item_1', revision: 2, snapshot: 'done', resync: true,
      event_id: 'codex:item_1:2', seq: 13,
    },
  },
  {
    agent: 'zcode',
    name: 'observer read-only content is replay',
    expectedPriority: 'replay',
    payload: {
      type: 'agent_text', session_id: 'zcode-abc123def4567890abcd',
      agent: 'zcode', source: 'observer',
      message_id: 'zcodem-msg1', part_id: 'zcodep-part1',
      revision: 1, replace: true, snapshot: 'observer content', resync: true,
      event_id: 'zcode:abcdef012345:text:part1:hash1', seq: 21,
    },
  },
  // ---- turn lifecycle v1: new+old payloads mix freely (stage 6) ----
  {
    agent: 'codex',
    name: 'native turn lifecycle control frame',
    expectedPriority: 'control',
    payload: {
      type: 'turn_status', session_id: 'thr_root',
      turn_id: 'turn:v1:codex:native-turn-9', source_turn_id: 'turn_9',
      turn_status: 'running', turn_origin: 'native', turn_confidence: 'native',
      actor_scope: 'root', flow_scope: 'auxiliary', content_class: 'lifecycle',
      classifier_version: 'v1',
      event_id: 'turn:abc123native9:status:running', seq: 31,
    },
  },
  {
    agent: 'claude-code',
    name: 'derived interrupted turn with continuation link',
    expectedPriority: 'control',
    payload: {
      type: 'turn_status', session_id: 'ses_claude',
      turn_id: 'turn:v1:claude-code:record-uuid-4', source_turn_id: 'record-uuid-4',
      turn_status: 'interrupted', turn_reason: 'request_interrupted_record',
      turn_origin: 'source_message', turn_confidence: 'derived',
      actor_scope: 'root',
      event_id: 'turn:deadbeefcla4:status:interrupted', seq: 32,
    },
  },
  {
    agent: 'opencode',
    name: 'turn-enriched content keeps legacy dedup identity',
    expectedPriority: 'live',
    payload: {
      type: 'agent_text', session_id: 'ses_oc',
      message_id: 'msg_oc7', part_id: 'prt_oc7', revision: 1, snapshot: 'reply',
      turn_id: 'turn:v1:opencode:msg-oc-7', source_turn_id: 'msg_oc7',
      turn_origin: 'source_message', turn_confidence: 'derived',
      event_id: 'opencode:part:prt_oc7:final:hash7', seq: 33,
    },
  },
  {
    agent: 'zcode',
    name: 'observer turn terminal from finish fact',
    expectedPriority: 'control',
    payload: {
      type: 'turn_status', session_id: 'zcode-abc123def4567890abcd',
      turn_id: 'turn:v1:zcode:m5', source_turn_id: 'm5',
      turn_status: 'completed', turn_reason: 'assistant_finish',
      turn_origin: 'source_message', turn_confidence: 'derived',
      event_id: 'turn:cafebabeszcode5:status:completed', seq: 34,
    },
  },
] as const;

// v1 enrichment fields are optional metadata: the fallback dedup key must
// never include them, so pre/post-upgrade deliveries of the same source
// content converge on one event (no duplicate copies after enrichment).
export const turnEnrichmentFields = [
  'turn_id', 'source_turn_id', 'turn_status', 'turn_reason', 'turn_origin',
  'turn_confidence', 'previous_turn_id', 'continuation_reason',
  'actor_scope', 'flow_scope', 'content_class', 'classifier_version',
] as const;

// The typed nack receipt for input arriving while a turn's interrupt is still
// pending — must pass through with reason/retryable intact, never broadcast as
// an accepted input.
export const turnInterruptPendingReceipt = {
  type: 'user_message_receipt', session_id: 'ses_oc', msg_id: 'm9',
  request_id: 'req-9', status: 'rejected',
  reason: 'turn_interrupt_pending', retryable: true, seq: 35,
} as const;
