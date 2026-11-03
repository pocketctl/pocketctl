import { latestSentPrompt } from '../sessionPrompt'
import { describe, expect, test } from 'vitest'
import { projectReplies, replyText, replyStatus, type ReplyMessage } from '../replyProjection'
const user = (id: number, turn_id = ''): ReplyMessage => ({id,role:'user',type:'user_text',content:'question',turn_id})
const agent = (id: number, turn_id = '', content = 'paragraph'): ReplyMessage => ({id,role:'agent',type:'agent_text',content,turn_id})
describe('question-scoped replies', () => {
  test('split-page retry echoes share explicit association and keep the original sticky prompt', () => {
    const messages = [user(1,'root'),agent(2,'root'),{...user(3,'retry'),retry_of_turn_id:'root'},user(4,'retry'),agent(5,'retry')]
    const rows = projectReplies(messages)
    expect(rows.filter(r=>r.kind==='message').map(r=>r.messages[0].id)).toEqual([1])
    expect(rows.filter(r=>r.kind==='reply').map(r=>r.prompt?.id)).toEqual([1,1])
    expect(latestSentPrompt(messages)?.id).toBe('1')
  })
  test('one identity and footer across paragraphs and tools; original messages retained', () => {
    const input = [user(1,'a'),agent(2,'a'),{...agent(3,'a'),type:'tool_call'},agent(4,'b','```js\nconst x = 1\n```')]
    const rows = projectReplies(input)
    expect(rows).toHaveLength(2)
    expect(rows[1].messages).toEqual(input.slice(1))
    expect(rows[1].messages[0]).toBe(input[1])
    expect(replyText(rows[1])).toBe('paragraph\n\n```js\nconst x = 1\n```')
  })
  test('new identical user prompts still create distinct replies', () => {
    const rows = projectReplies([user(1),agent(2),user(3),agent(4)])
    expect(rows.filter(r=>r.kind==='reply').map(r=>r.prompt?.id)).toEqual([1,3])
  })
  test('late events and explicit continuation remain attributed to the old question without sorting', () => {
    const input = [user(1,'a'),agent(2,'a'),user(3,'b'),agent(4,'b'),agent(5,'a'),{...agent(6,'c'),previous_turn_id:'a'}]
    const rows = projectReplies(input)
    expect(rows.flatMap(r=>r.messages)).toEqual(input)
    expect(rows.at(-1)?.prompt?.id).toBe(1)
    expect(rows.at(-1)?.messages.map(m=>m.id)).toEqual([5,6])
  })
  test('actor changes are not merged', () => {
    expect(projectReplies([user(1),{...agent(2),actor_scope:'primary'},{...agent(3),actor_scope:'review'}]).filter(r=>r.kind==='reply')).toHaveLength(2)
  })
  test('pending/failed local send is not the new question owner', () => {
    for (const deliveryStatus of ['sending','failed','unknown']) {
      const rows = projectReplies([user(1),agent(2),{...user(3),deliveryStatus},agent(4)])
      expect(rows.at(-1)?.prompt?.id).toBe(1)
    }
  })
  test('partial history is unknown, not falsely completed; prepend restores the owner', () => {
    const input = [agent(2,'a'),agent(3,'a')]
    expect(projectReplies(input)[0].partial).toBe(true)
    expect(replyStatus(projectReplies(input)[0])).toBe('recorded')
    expect(projectReplies([user(1,'a'),...input])[1].id).toBe(projectReplies(input)[0].id)
  })
  test('pending interaction stays actionable even after terminal marker', () => {
    const group=projectReplies([user(1),{...agent(2),type:'approval_request',status:'pending'},{...agent(3),type:'turn_status',turn_status:'completed'}])[1]
    expect(replyStatus(group)).toBe('waiting')
    expect(replyText(group)).toBe('')
  })
  test('interruption is never presented as successful completion', () => {
    expect(replyStatus(projectReplies([agent(1),{...agent(2),turn_status:'interrupted'}])[0])).toBe('interrupted')
  })
})

 test('explicit retries retain old answers without repeating the question, including delayed echo and replay', () => {
   const retry = {...user(3, 'retry'), retry_of_turn_id: 'root'}
   for (const input of [[user(1,'root'),agent(2,'root'),retry,agent(4,'retry')], [user(1,'root'),agent(2,'root'),agent(4,'retry'),retry]]) {
     const rows=projectReplies(input)
     expect(rows.filter(r=>r.kind==='message')).toHaveLength(1)
     expect(rows.filter(r=>r.kind==='reply').map(r=>r.prompt?.id)).toEqual([1,1])
     expect(rows.filter(r=>r.kind==='reply').map(replyText)).toEqual(['paragraph','paragraph'])
   }
 })
 test('retry with unloaded root stays partial and recovers after prepend', () => {
   const tail=[{...user(3,'retry'),retry_of_turn_id:'root'},agent(4,'retry')]
   expect(projectReplies(tail)[0].partial).toBe(true)
   expect(projectReplies([user(1,'root'),...tail]).at(-1)?.prompt?.id).toBe(1)
 })
