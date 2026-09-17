import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const memoryWorkbenchCss = readFileSync(
  resolve(process.cwd(), 'src/components/memory/memory-workbench.css'),
  'utf8',
)

describe('Memory workspace toolbar layout', () => {
  afterEach(() => {
    document.head.querySelector('[data-memory-toolbar-test-style]')?.remove()
    document.body.replaceChildren()
  })

  test('contains an oversized tab row instead of widening the page', () => {
    const style = document.createElement('style')
    style.dataset.memoryToolbarTestStyle = 'true'
    style.textContent = memoryWorkbenchCss
    document.head.append(style)

    const toolbar = document.createElement('header')
    toolbar.className = 'memory-workspace-toolbar'
    toolbar.innerHTML = '<nav class="memory-tabs"></nav><span class="memory-workspace-health"></span>'
    document.body.append(toolbar)

    const toolbarStyle = getComputedStyle(toolbar)
    const tabsStyle = getComputedStyle(toolbar.querySelector('.memory-tabs')!)
    const tab = document.createElement('button')
    tab.className = 'memory-tab'
    toolbar.querySelector('.memory-tabs')!.append(tab)
    const tabStyle = getComputedStyle(tab)

    expect({
      maxWidth: toolbarStyle.maxWidth,
      overflow: toolbarStyle.overflow,
    }).toEqual({
      maxWidth: '100%',
      overflow: 'hidden',
    })
    expect({
      minWidth: tabsStyle.minWidth,
      flexGrow: tabsStyle.flexGrow,
      flexShrink: tabsStyle.flexShrink,
      overflowX: tabsStyle.overflowX,
      overflowY: tabsStyle.overflowY,
    }).toEqual({
      minWidth: '0',
      flexGrow: '1',
      flexShrink: '1',
      overflowX: 'auto',
      overflowY: 'hidden',
    })
    expect(tabStyle.flexShrink).toBe('0')
  })
})
