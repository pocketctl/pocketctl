import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/views/SessionDetail.vue'), 'utf8')

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? ''
}

describe('SessionDetail floating composer layout', () => {
  test('overlays the message stream while reserving clearance with the same backdrop', () => {
    const chatArea = cssRule('.chat-area')
    const messages = cssRule('.chat-messages')
    const composer = cssRule('.chat-input-area')
    const composerContainer = cssRule('.chat-input-container')

    expect(chatArea).toContain('--composer-float-clearance')
    expect(messages).toContain('var(--composer-float-clearance)')
    expect(messages).toContain('background: var(--bg)')
    expect(composer).toContain('position: absolute')
    expect(composer).toContain('bottom: 0')
    expect(composer).toContain('background: transparent')
    expect(composerContainer).toContain('background: var(--bg)')
  })
})
