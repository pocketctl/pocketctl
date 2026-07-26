#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(repoRoot, 'scripts/github-mirror-files.txt')

assert.ok(
  fs.existsSync(manifestPath),
  'scripts/github-mirror-files.txt must define the public mirror contract',
)

const mirrored = new Set(
  fs
    .readFileSync(manifestPath, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean),
)

for (const relativePath of mirrored) {
  assert.ok(
    fs.existsSync(path.join(repoRoot, relativePath)),
    `public mirror entry does not exist: ${relativePath}`,
  )
}

const workflowFiles = fs
  .readdirSync(path.join(repoRoot, '.github/workflows'))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))

const workflowText = workflowFiles
  .map((name) => fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8'))
  .join('\n')

const requiredScripts = new Set(
  [...workflowText.matchAll(/(?:\.\/)?(scripts\/[A-Za-z0-9._/-]+)/g)].map((match) => match[1]),
)

const makefile = fs.readFileSync(path.join(repoRoot, 'Makefile'), 'utf8')
for (const match of workflowText.matchAll(/\bmake\s+([A-Za-z0-9._-]+)/g)) {
  const target = match[1]
  const recipe = makefile.match(
    new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*\\n((?:\\t.*\\n)+)`, 'm'),
  )
  assert.ok(recipe, `workflow references missing Make target: ${target}`)
  for (const script of recipe[1].matchAll(/(?:\.\/)?(scripts\/[A-Za-z0-9._/-]+)/g)) {
    requiredScripts.add(script[1])
  }
}

for (const script of requiredScripts) {
  assert.ok(mirrored.has(script), `workflow dependency is absent from public mirror: ${script}`)
}

for (const readmeName of ['README.md', 'README.zh-CN.md']) {
  const readme = fs.readFileSync(path.join(repoRoot, readmeName), 'utf8')
  for (const match of readme.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1]
    if (/^(?:https?:|#)/.test(target)) continue
    assert.ok(mirrored.has(target), `${readmeName} links to an absent mirror file: ${target}`)
  }
  assert.doesNotMatch(readme, /download the iOS app from|从官网下载安装 iOS App/i)
}

const installer = fs.readFileSync(path.join(repoRoot, 'scripts/install-daemon.sh'), 'utf8')
assert.doesNotMatch(installer, /brew tap|brew install/, 'installer advertises unavailable Homebrew formula')
assert.ok(
  !fs.existsSync(path.join(repoRoot, 'tap/pocketctl.rb')),
  'stale Homebrew formula must not be published',
)

console.log('github mirror contract tests passed')
