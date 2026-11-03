import { associateReplyRetries } from './replyProjection'
import MarkdownIt from 'markdown-it'

export interface SessionPrompt { id: string; text: string }
const markdown = new MarkdownIt({ html: false })

/** Text projection only; never render prompt markup into the floating button. */
export function promptSummary(content: string): string {
  const tokens = markdown.parse(content, {})
  const pieces: string[] = []
  for (const token of tokens) {
    if (token.type === 'inline') {
      pieces.push((token.children || []).map(child => {
        if (child.type === 'image') return child.content || '[图片]'
        if (child.type === 'softbreak' || child.type === 'hardbreak') return ' '
        return ['text', 'code_inline'].includes(child.type) ? child.content : ''
      }).join(''))
    } else if (token.type === 'fence' || token.type === 'code_block') pieces.push(token.content)
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim()
}

export function latestSentPrompt(source: readonly any[], clean: (text: string) => string = text => text): SessionPrompt | null {
  const messages = associateReplyRetries(source)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'user' || message.type !== 'user_text' || message.retry_of_turn_id) continue
    if (message.deliveryStatus === 'failed') continue
    if (message.deliveryStatus && message.deliveryStatus !== 'accepted' && !message.__echo_reconciled) continue
    const text = promptSummary(clean(message.content || ''))
    if (text) return { id: String(message.id), text }
  }
  return null
}
