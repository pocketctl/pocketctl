import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const memoryWorkbenchCss = readFileSync(
  resolve(process.cwd(), 'src/components/memory/memory-workbench.css'),
  'utf8',
)

describe('Memory workspace grouped navigation layout', () => {
  afterEach(() => {
    document.head.querySelector('[data-memory-toolbar-test-style]')?.remove()
    document.body.replaceChildren()
  })

  test('keeps navigation in a fixed rail and content shrinkable', () => {
    const style = document.createElement('style')
    style.dataset.memoryToolbarTestStyle = 'true'
    style.textContent = memoryWorkbenchCss
    document.head.append(style)

    const shell = document.createElement('section')
    shell.className = 'memory-workspace-shell'
    shell.innerHTML = '<nav class="memory-module-navigation"><div class="memory-module-tabs"></div></nav><main class="memory-workspace-main"></main>'
    document.body.append(shell)

    const shellStyle = getComputedStyle(shell)
    const navigationStyle = getComputedStyle(shell.querySelector('.memory-module-navigation')!)
    const tab = document.createElement('button')
    tab.className = 'memory-module-tab'
    shell.querySelector('.memory-module-tabs')!.append(tab)
    const tabStyle = getComputedStyle(tab)

    expect({
      display: shellStyle.display,
      columns: shellStyle.gridTemplateColumns,
      overflow: shellStyle.overflow,
    }).toEqual({
      display: 'grid',
      columns: '196px minmax(0, 1fr)',
      overflow: 'hidden',
    })
    expect({
      minWidth: navigationStyle.minWidth,
      width: tabStyle.width,
      display: tabStyle.display,
    }).toEqual({
      minWidth: '0',
      width: '100%',
      display: 'grid',
    })
  })
})
