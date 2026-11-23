import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isOperationalDialogueText } from '../episodes/dialogue-operation.js'
import { certifiedCodexDialogue, readDialogueText, selectDialogue, type Member } from '../episodes/turn-dialogue.js'

function row(id: string, kind: string, header: Member['header'] = {}): Member {
  return { id, kind, header, hash: id, at: new Date(0), proof: null }
}
const prompt = row('1', 'user_text', { part_id: 'p' })
const terminal = row('9', 'turn_status', { turn_status: 'completed' })
describe('turn dialogue input', () => {
  it('uses a semantic final marker and accepts a genuine interruption with only a prompt', () => {
    const middle = row('2', 'agent_text', { part_id: 'progress', final: true })
    expect(() => selectDialogue([prompt, middle, terminal])).toThrow('final_message_unconfirmed')
    expect(
      selectDialogue([prompt, middle, row('3', 'turn_status', { turn_status: 'interrupted' })]).groups,
    ).toHaveLength(1)
  })
  it('keeps same-turn corrections, excludes tools and joins native final text blocks by message identity', () => {
    const correction = row('2', 'user_text', { part_id: 'p2' })
    const first = row('3', 'agent_text', { event_id: 'a', dialogue_message_id: 'm' })
    const last = row('4', 'agent_text', {
      event_id: 'b',
      dialogue_message_id: 'm',
      message_phase: 'final_answer',
    })
    const { groups } = selectDialogue([prompt, correction, row('5', 'tool_result'), first, last, terminal])
    expect(groups.map((g) => g.anchor.id)).toEqual(['1', '2', '3', '4'])
    expect(() =>
      selectDialogue([prompt, last, row('5', 'agent_text', { message_phase: 'final_answer' }), terminal]),
    ).toThrow('final_message_unconfirmed')
  })
  it('reads a final stream by UTF-8 offset and sequence even when the completion frame has no text', () => {
    const text = '测试abc',
      hash = createHash('sha256').update(text).digest('hex').slice(0, 16)
    const chunk = row('5', 'agent_text', { part_id: 'p', stream_id: 's', chunk_seq: 0, byte_offset: 0 })
    const end = row('6', 'agent_text', {
      ...chunk.header,
      final: true,
      chunk_seq: 1,
      byte_offset: 9,
      total_bytes: 9,
      content_hash: hash,
      message_phase: 'final_answer',
    })
    const bodies = new Map([
      ['5', { text }],
      ['6', { text: '' }],
    ])
    expect(readDialogueText(end, [end, chunk], bodies)).toBe(text)
    expect(() => readDialogueText(end, [end], bodies)).toThrow('message_incomplete')
    expect(() => readDialogueText(end, [chunk, end], new Map([['5', { text: '更改abc' }]]))).toThrow(
      'message_incomplete',
    )
  })
})

it('extracts the tail of a long answer with UTF-16 offsets into the complete sanitized source', async () => {
  const { extractDialogueConclusions } = await import('../curation/dialogue-extraction.js')
  const quote = '最后的结论',
    text = 'x'.repeat(63999) + '🚆' + quote
  const calls: string[] = []
  const result = await extractDialogueConclusions(
    {
      async generateJson<T>(
        request: Parameters<import('../ports/text-generator.js').TextGenerator['generateJson']>[0],
      ) {
        calls.push(request.requestKey!)
        const { sources } = request.document as { sources: { text: string }[] }
        const tasks = sources[0].text.includes(quote)
          ? [{ space_id: null, task_id: null, spans: [{ event_id: 'answer', quote }], conclusions: [] }]
          : []
        return { ok: true, value: { tasks } as T, usage: { model: 'local', inputTokens: 1, outputTokens: 2 } }
      },
    },
    {
      sources: [{ id: 'answer', role: 'assistant', verified: false, text }],
      tasks: [],
      spaces: [],
      requestKey: 'long',
      signal: new AbortController().signal,
      now: new Date(),
    },
  )
  expect(calls).toEqual(['long:window:0', 'long:window:1'])
  expect(result.ok && result.tasks[0].spans).toEqual([
    { event_id: 'answer', start: text.indexOf(quote), end: text.length },
  ])
  expect(result.usage?.inputTokens).toBe(2)
})

it('uses a terminal message identity and ignores late older revisions', () => {
  const end = row('4', 'turn_status', {
    message_phase: 'final_answer',
    dialogue_message_id: 'answer',
    turn_status: 'completed',
  })
  const changed = row('2', 'agent_text', { part_id: 'part', dialogue_message_id: 'answer', revision: 2 })
  const stale = row('3', 'agent_text', { part_id: 'part', dialogue_message_id: 'answer', revision: 1 })
  expect(selectDialogue([prompt, changed, stale, end]).groups.map((g) => g.anchor.id)).toEqual(['1', '2'])
})

describe('operational turn admission', () => {
  it.each([
    '当前分支提交代码合并到本地 develop 分支，然后提交 develop 分支代码',
    '提交当前分支的代码',
    '请将这个分支合并到 develop',
    'git commit -m "fix"',
    '麻烦帮我查询一下当前进度',
    '进展怎么样了？',
    '目前做到哪了？',
    '调用 skill push-dev',
    '使用 MCP 查询数据',
    '$push-dev',
    '/skills merge-master',
    'Please invoke the calendar MCP',
    'merge feature/a into develop',
    'What is the current status?',
  ])('filters request %s', (text) => expect(isOperationalDialogueText(text, 'user')).toBe(true))
  it.each([
    '如何设计 MCP 调用的超时机制？',
    '合并代码有什么风险？',
    '提交代码时为什么会超时？',
    '不要提交代码，只分析这个问题',
    '请设计一个查询进度的接口',
    '查看进度条组件的颜色',
    '在当前分支增加规则过滤：调用 skill、mcp、提交代码、合并代码、查询进度',
    'Explain how git merge works',
    'I prefer rail for personal travel.',
  ])('retains discussion %s', (text) => expect(isOperationalDialogueText(text, 'user')).toBe(false))
  it('checks explicit execution receipts and retains discussion in answers', () => {
    expect(isOperationalDialogueText('已将功能分支合并到 develop。', 'assistant')).toBe(true)
    expect(isOperationalDialogueText('工具调用中的 MCP 类型用于计量。', 'assistant')).toBe(false)
  })
})

it('binds the native terminal witness to the accepted input, exact final bytes and native echo', () => {
  const rootId = 'input:dc1d565f06ec7b27ba8178083fc75bce48a07e666eafff436de626302577c64f'
  const rootProof = {version:1,producer:'codex',session_id:'session',turn_id:'turn',sequence:'1',
    event_id:rootId,invocation_id:rootId,source_role:'user',skill_state:'non_skill',lineage_complete:true,derived_from_event_ids:[]}
  const root = {...row('1','user_text',{}),proof:rootProof}
  const echo = row('2','user_text',{part_id:'native-user'})
  const answer = row('3','agent_text',{part_id:'answer',message_phase:'final_answer'})
  const end = {...terminal,proof:{...rootProof,sequence:'4',source_role:'system',parent_invocation_id:rootId,
    invocation_id:'dialogue:'+createHash('sha256').update('native-user').digest('hex'),derived_from_event_ids:[rootId],
    event_id:'codex-dialogue-v1:2911fdb3e1e9780213edb8d94c01114588ee30fe0a806b4887fc874fdbe3e4d7'}}
  const messages = [root,echo,answer], texts = new Map([['1','问题'],['2','问题'],['3','回复']])
  const check = () => certifiedCodexDialogue(end,messages,texts,new Set(),'session','turn')
  expect(check()).toMatchObject({echo:'2',answer:'3',proof:{source_role:'assistant',derived_from_event_ids:[rootId]}})
  expect(certifiedCodexDialogue(end,messages,texts,new Set([rootId]),'session','turn')).toBeUndefined()
  expect(certifiedCodexDialogue(end,messages,texts,new Set(),'session','other')).toBeUndefined()
  texts.set('3','tampered')
  expect(check()).toBeUndefined()
  texts.set('3','回复'); echo.header.part_id='different'
  expect(check()).toBeUndefined()
})
