import {describe, expect, test} from 'vitest'
import {teamMessagePreview} from '../team/message-preview.js'
describe('public Team message previews', () => {
 test('uses a structured agent conclusion while leaving the source unchanged', () => {
  const chunks = ['{"action":"complete","summary":"已完成检查",', '"todo":', '[]}' ]
  const source = chunks.join('')
  expect(teamMessagePreview(source,'agent_message')).toBe('已完成检查')
  expect(source).toContain('"todo":[]}')
 })
 test('does not reinterpret member JSON or drop partial agent responses', () => {
  expect(teamMessagePreview('{"summary":"literal member content"}','member_message')).toBe('{"summary":"literal member content"}')
  expect(teamMessagePreview('Work in\nprogress','agent_message')).toBe('Work in progress')
  expect(teamMessagePreview(null,null)).toBeNull()
 })
})
