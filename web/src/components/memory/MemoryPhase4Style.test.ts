import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('Phase 4 Memory workspace style contract', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/components/memory/memory-workbench.css'), 'utf8')
  const phase4 = css.split('/* --- ADR-0006 Phase 4:')[1]?.split('/* --- ADR-0005 Phase 3')[0] ?? ''

  test('uses existing theme tokens for both light and dark themes', () => {
    expect(phase4).toContain('var(--surface)')
    expect(phase4).toContain('var(--fg)')
    expect(phase4).toContain('var(--border)')
    expect(phase4).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  test('collapses graph and Wiki workspaces on mobile and respects reduced motion', () => {
    expect(phase4).toContain('@media (max-width: 760px)')
    expect(phase4).toMatch(/\.memory-codegraph-grid,\s*\n\s*\.memory-wiki-layout\s*\{\s*grid-template-columns:\s*1fr/)
    expect(phase4).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
