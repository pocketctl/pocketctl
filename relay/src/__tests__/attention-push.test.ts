import { describe, expect, test } from 'vitest'
import { approvalPush, interactivePush, questionPush } from '../push.js'

describe('attention push payloads', () => {
  test('approval payload contains iOS deep-link identifiers', () => {
    expect(approvalPush('', 'Bash', 'echo test', 'session-1', 'request-1')).toEqual({
      title: '需要你的审批',
      body: 'Bash 想执行 echo test',
      data: { type: 'approval', session_id: 'session-1', request_id: 'request-1' },
    })
  })

  test('interactive payload contains iOS deep-link identifiers', () => {
    expect(interactivePush('', '请选择执行方式', 'session-2', 'request-2')).toEqual({
      title: 'Agent 需要你的输入',
      body: '请选择执行方式',
      data: { type: 'interactive', session_id: 'session-2', request_id: 'request-2' },
    })
  })
})

test('questionPush points to the pending native question', () => {
  expect(questionPush('Choose scope', 'session-1', 'question-1')).toEqual({
    title: 'Agent 需要你的回答',
    body: 'Choose scope',
    data: { type: 'question', session_id: 'session-1', request_id: 'question-1' },
  })
})
