import { describe, test, expect } from 'vitest'

// Pure logic tests for context token usage computation — extracted from
// SessionDetail.vue's contextTokens and contextTooltip computed properties.

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_create_tokens?: number
}

interface Message {
  type: string
  usage?: Usage
}

/** Mirrors contextTokens computed: finds the last message with usage, sums
 *  input + cache tokens, formats as K when > 1000. */
function contextTokens(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage
    if (u) {
      const total = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_create_tokens || 0)
      return total > 1000 ? (total / 1000).toFixed(1) + 'K' : String(total)
    }
  }
  return ''
}

/** Mirrors contextTooltip computed: formats a multi-line breakdown. */
function contextTooltip(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i].usage
    if (u) {
      const parts: string[] = []
      if (u.input_tokens) parts.push(`输入: ${u.input_tokens.toLocaleString()}`)
      if (u.output_tokens) parts.push(`输出: ${u.output_tokens.toLocaleString()}`)
      if (u.cache_read_tokens) parts.push(`缓存读取: ${u.cache_read_tokens.toLocaleString()}`)
      if (u.cache_create_tokens) parts.push(`缓存写入: ${u.cache_create_tokens.toLocaleString()}`)
      return parts.length ? 'Context 用量\n' + parts.join('\n') : ''
    }
  }
  return ''
}

describe('#17 contextTokens — display value', () => {
  test('empty messages → empty string', () => {
    expect(contextTokens([])).toBe('')
  })

  test('no usage on any message → empty string', () => {
    expect(contextTokens([{ type: 'agent_text' }, { type: 'user' }])).toBe('')
  })

  test('small token count (< 1000) → raw number', () => {
    expect(contextTokens([{ type: 'agent_text', usage: { input_tokens: 500 } }])).toBe('500')
  })

  test('large token count (> 1000) → K format with 1 decimal', () => {
    expect(contextTokens([{ type: 'agent_text', usage: { input_tokens: 12300 } }])).toBe('12.3K')
  })

  test('exactly 1000 → raw "1000" (not K)', () => {
    expect(contextTokens([{ type: 'agent_text', usage: { input_tokens: 1000 } }])).toBe('1000')
  })

  test('sums input + cache_read + cache_create (excludes output)', () => {
    const msg: Message = {
      type: 'agent_text',
      usage: { input_tokens: 500, output_tokens: 200, cache_read_tokens: 3000, cache_create_tokens: 500 },
    }
    // 500 + 3000 + 500 = 4000 → 4.0K (output excluded)
    expect(contextTokens([msg])).toBe('4.0K')
  })

  test('uses the LAST message with usage (most recent turn)', () => {
    const messages: Message[] = [
      { type: 'agent_text', usage: { input_tokens: 100 } },
      { type: 'user' },
      { type: 'agent_text', usage: { input_tokens: 2000 } },
    ]
    expect(contextTokens(messages)).toBe('2.0K')
  })

  test('zero usage values handled', () => {
    expect(contextTokens([{ type: 'agent_text', usage: { input_tokens: 0, cache_read_tokens: 0 } }])).toBe('0')
  })
})

describe('#18 contextTooltip — detailed breakdown', () => {
  test('empty messages → empty', () => {
    expect(contextTooltip([])).toBe('')
  })

  test('full breakdown with all token types', () => {
    const msg: Message = {
      type: 'agent_text',
      usage: { input_tokens: 1200, output_tokens: 50, cache_read_tokens: 8000, cache_create_tokens: 300 },
    }
    const tip = contextTooltip([msg])
    expect(tip).toContain('输入: 1,200')
    expect(tip).toContain('输出: 50')
    expect(tip).toContain('缓存读取: 8,000')
    expect(tip).toContain('缓存写入: 300')
    expect(tip).toContain('Context 用量')
  })

  test('only input tokens → partial breakdown', () => {
    const tip = contextTooltip([{ type: 'agent_text', usage: { input_tokens: 500 } }])
    expect(tip).toContain('输入: 500')
    expect(tip).not.toContain('输出')
    expect(tip).not.toContain('缓存')
  })

  test('zero values excluded from tooltip', () => {
    const tip = contextTooltip([{ type: 'agent_text', usage: { input_tokens: 500, output_tokens: 0 } }])
    expect(tip).toContain('输入: 500')
    expect(tip).not.toContain('输出: 0')
  })

  test('uses last message with usage', () => {
    const messages: Message[] = [
      { type: 'agent_text', usage: { input_tokens: 100 } },
      { type: 'agent_text', usage: { input_tokens: 999 } },
    ]
    expect(contextTooltip(messages)).toContain('999')
  })

  test('empty usage object → empty tooltip', () => {
    expect(contextTooltip([{ type: 'agent_text', usage: {} }])).toBe('')
  })
})
