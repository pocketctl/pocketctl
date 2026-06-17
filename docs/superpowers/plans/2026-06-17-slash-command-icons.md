# Slash Command Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CommandPopover emoji icons with SVG outline icons (kind+source 5 categories), gray out + tooltip for web-unavailable local commands.

**Architecture:** Single-component change (`CommandPopover.vue`) — add an inline SVG icon map keyed by `kind`+`source`, a CSS class `is-command` for gray-out + hover tooltip, and update the existing test to assert SVG icons + gray-out instead of emoji.

**Tech Stack:** Vue 3 (script setup), vitest + @vue/test-utils, inline SVG (lucide/feather paths, stroke-width 2, matching system icon style).

## Global Constraints

- Icon size 14×14, `stroke="currentColor" stroke-width="2" fill="none"` (matches SessionActions/copy-btn icons).
- `kind: 'command'` items get class `is-command` (opacity 0.4) + `title="web 不支持，在终端使用"`.
- `CommandItem` interface unchanged (`kind: 'command'|'skill'`, `source: 'builtin'|'project'|'user'|'plugin'`).
- No icon library dependency — inline SVG paths only.
- `plugin` source keeps existing namespace badge (`.cmd-source`).

---

### Task 1: SVG icon map + command gray-out + tooltip

**Files:**
- Modify: `web/src/components/CommandPopover.vue` (template line 10 icon span, script add icon map, CSS add `.is-command`)
- Test: `web/src/components/__tests__/CommandPopover.test.ts` (update icon test lines 30-35, add gray-out test)

**Interfaces:**
- Consumes: `CommandItem` from `../composables/useWebSocket` (existing, unchanged: `kind`, `source`, `name`, `namespace?`)
- Produces: rendered `<svg>` icons per kind+source; `.is-command` class on command rows for gray-out

- [ ] **Step 1: Write the failing test (replace emoji assertion with SVG + gray-out)**

Replace test `distinguishes command (🔧) and skill (📘) icons` (lines 30-35) in `web/src/components/__tests__/CommandPopover.test.ts`:

```ts
  test('renders SVG icons by kind+source and grays out commands', () => {
    const wrapper = mount(CommandPopover, { props: { commands, activeIndex: 0 } })
    const html = wrapper.html()
    // SVG icons present (no emoji)
    expect(html).not.toContain('🔧')
    expect(html).not.toContain('📘')
    expect(wrapper.findAll('.cmd-icon svg').length).toBe(4)
    // command items grayed out
    const items = wrapper.findAll('.cmd-item')
    expect(items[0].classes()).toContain('is-command') // clear (command)
    expect(items[1].classes()).toContain('is-command') // compact (command)
    expect(items[2].classes()).not.toContain('is-command') // pocket-release (skill)
    expect(items[3].classes()).not.toContain('is-command') // codex:rescue (skill)
    // command tooltip
    expect(items[0].attributes('title')).toContain('web 不支持')
  })
```

Also add a `user` skill to the test commands array (line 6-11) for source coverage — add after codex:rescue:

```ts
  { name: 'my-skill', source: 'user', kind: 'skill', description: '我的' },
```

And update the render-count assertion in `renders each command with leading slash` (line 17) from `toBe(4)` to `toBe(5)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/__tests__/CommandPopover.test.ts`
Expected: FAIL — emoji still rendered (contains 🔧/📘), no `.is-command` class, no SVG.

- [ ] **Step 3: Implement SVG icon map + gray-out in CommandPopover.vue**

Replace the icon span (template line 10):

```vue
      <span class="cmd-icon" v-html="commandIcon(c)"></span>
```

Replace the `:class` on `.cmd-item` (template line 6) to add `is-command`:

```vue
      :class="['cmd-item', { active: i === activeIndex, 'is-command': c.kind === 'command' }]"
      :title="c.kind === 'command' ? 'web 不支持，在终端使用' : undefined"
```

Add the icon map in `<script setup>` (after defineEmits, before `</script>`):

```ts
// SVG icon paths (lucide/feather, stroke-width 2, 14×14) — session-resume-command brainstorm design
const ICONS: Record<string, string> = {
  terminal:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  sparkles:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg>',
  folder:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  user:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  package:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
}

function commandIcon(c: CommandItem): string {
  if (c.kind === 'command') return ICONS.terminal
  switch (c.source) {
    case 'builtin': return ICONS.sparkles
    case 'project': return ICONS.folder
    case 'user':    return ICONS.user
    case 'plugin':  return ICONS.package
    default:        return ICONS.sparkles
  }
}
```

Add CSS for gray-out (in `<style scoped>`, after `.cmd-item.active`):

```css
.cmd-item.is-command {
  opacity: 0.4;
}
.cmd-item.is-command:hover {
  opacity: 0.7;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/__tests__/CommandPopover.test.ts`
Expected: PASS — all 7 tests green (SVG icons, no emoji, is-command gray-out, tooltip).

- [ ] **Step 5: vue-tsc type check**

Run: `cd web && npx vue-tsc --noEmit`
Expected: exit 0 (no type errors).

- [ ] **Step 6: Commit**

```bash
cd /Users/muwenbin/projects/pocketctl
git add web/src/components/CommandPopover.vue web/src/components/__tests__/CommandPopover.test.ts
git commit -m "feat(web): slash command icon 改 SVG outline（kind+source 5 类）+ command 灰显

CommandPopover emoji（📘🔧）改 SVG outline（lucide：Terminal/Sparkles/
Folder/User/Package），按 kind+source 组合 5 类。kind=command（local
command，web PTY 不可执行）灰显 + tooltip「web 不支持，在终端使用」。
风格统一系统 SVG（stroke-width 2）。

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
