import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/views/SessionDetail.vue'), 'utf8')

function cssRule(selector: string, css = source): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('SessionDetail floating composer layout', () => {
  test('overlays the message stream while keeping the composer on a distinct surface', () => {
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
    expect(composerContainer).toContain('background: var(--surface)')
  })

  test('aligns the message stream and composer to one shared reading column', () => {
    const chatArea = cssRule('.chat-area')
    const messages = cssRule('.chat-messages')
    const composer = cssRule('.chat-input-area')

    expect(chatArea).toContain('--session-content-gutter: max(20px, calc(50% - 460px))')
    expect(messages).toContain('var(--session-content-gutter)')
    expect(composer).toContain('var(--session-content-gutter)')
  })

  test('anchors the mobile composer to the panned visual viewport bottom', () => {
    const mobileStyles = source.slice(source.indexOf('@media (max-width: 768px)'))
    const sessionLayout = cssRule('.session-layout', mobileStyles)

    expect(sessionLayout).toContain('var(--visual-viewport-bottom, 100dvh)')
    expect(sessionLayout).not.toContain('var(--visual-viewport-height, 100dvh)')
  })
})
