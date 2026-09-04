import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const memoryWorkbenchCss = readFileSync(
  resolve(process.cwd(), 'src/components/memory/memory-workbench.css'),
  'utf8',
)

describe('Memory button typography', () => {
  afterEach(() => {
    document.head.querySelector('[data-memory-button-test-style]')?.remove()
    document.body.replaceChildren()
  })

  test('keeps text metrics consistent across button variants', () => {
    const style = document.createElement('style')
    style.dataset.memoryButtonTestStyle = 'true'
    style.textContent = memoryWorkbenchCss
    document.head.append(style)

    const host = document.createElement('div')
    host.className = 'memory-workbench'
    host.style.setProperty('--font-body', 'Design Body')
    host.style.fontFamily = 'Inherited Body'
    host.style.lineHeight = '1.8'
    host.innerHTML = [
      '<button class="memory-button">Default</button>',
      '<button class="memory-button is-primary">Primary</button>',
      '<button class="memory-button is-danger">Danger</button>',
      '<button class="memory-button is-success">Success</button>',
    ].join('')
    document.body.append(host)

    const metrics = (button: Element) => {
      const computed = getComputedStyle(button)
      return {
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        letterSpacing: computed.letterSpacing,
        textAlign: computed.textAlign,
      }
    }
    const buttons = [...host.querySelectorAll('.memory-button')]
    const expected = metrics(buttons[0]!)

    expect(expected).toMatchObject({
      fontFamily: '"Design Body"',
      fontSize: '10.5px',
      fontWeight: '600',
      lineHeight: '1',
      textAlign: 'center',
    })
    expect(Number.parseFloat(expected.letterSpacing)).toBeGreaterThan(0)
    for (const button of buttons.slice(1)) expect(metrics(button)).toEqual(expected)
  })

  test('keeps the Active claim filter at the design typography instead of the inherited button reset', () => {
    const style = document.createElement('style')
    style.dataset.memoryButtonTestStyle = 'true'
    style.textContent = memoryWorkbenchCss
    document.head.append(style)

    const host = document.createElement('div')
    host.className = 'memory-workbench'
    host.style.setProperty('--font-body', 'Design Body')
    host.style.fontFamily = 'Inherited Body'
    host.style.fontSize = '16px'
    host.style.fontWeight = '700'
    host.style.lineHeight = '1.8'
    host.innerHTML = '<button class="memory-claim-state-filter" disabled>Active</button>'
    document.body.append(host)

    const computed = getComputedStyle(host.querySelector('.memory-claim-state-filter')!)
    expect({
      fontFamily: computed.fontFamily,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      lineHeight: computed.lineHeight,
    }).toEqual({
      fontFamily: '"Design Body"',
      fontSize: '9px',
      fontWeight: '400',
      lineHeight: '1',
    })
    expect(Number.parseFloat(computed.letterSpacing)).toBe(0)
  })
})
