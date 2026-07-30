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
    name: 'subagent historical content',
    expectedPriority: 'replay',
    payload: {
      type: 'agent_text', session_id: 'thr_root', agent_id: 'thr_child',
      parent_session_id: 'thr_root', root_session_id: 'thr_root', is_subagent: true,
      part_id: 'item_1', revision: 2, snapshot: 'done', resync: true,
      event_id: 'codex:item_1:2', seq: 13,
    },
  },
] as const;
