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
assert.match(
  makefile,
  /^RELEASE_LDFLAGS\s*=\s*-ldflags "-s -w -X main\.version=\$\(VERSION\)"$/m,
  'Makefile release profile must strip the symbol table and DWARF while preserving version injection',
)
assert.match(
  makefile,
  /^build-release:\n\tGOOS=\$\(GOOS\) GOARCH=\$\(GOARCH\) go build -trimpath \$\(RELEASE_LDFLAGS\)/m,
  'Makefile release profile must remove build-machine paths',
)

for (const workflowName of ['release.yml', 'release-candidate.yml']) {
  const releaseWorkflow = fs.readFileSync(
    path.join(repoRoot, '.github/workflows', workflowName),
    'utf8',
  )
  assert.match(
    releaseWorkflow,
    /\bmake build-release\b/,
    `${workflowName} must use the centralized release build profile`,
  )
  assert.doesNotMatch(
    releaseWorkflow,
    /\bgo build\s+-ldflags/,
    `${workflowName} must not duplicate release linker flags`,
  )
}

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

const dependencyQueue = [...requiredScripts]
for (let index = 0; index < dependencyQueue.length; index += 1) {
  const script = dependencyQueue[index]
  const scriptPath = path.join(repoRoot, script)
  // A referenced path may be a directory (docker build context, mkdir
  // fixtures). Only script files carry dependencies; skip the rest.
  if (!fs.existsSync(scriptPath) || fs.statSync(scriptPath).isDirectory()) continue
  const scriptText = fs.readFileSync(scriptPath, 'utf8')
  for (const match of scriptText.matchAll(/(?:\.\/)?(scripts\/[A-Za-z0-9._/-]+)/g)) {
    if (requiredScripts.has(match[1])) continue
    requiredScripts.add(match[1])
    dependencyQueue.push(match[1])
  }
}

for (const script of requiredScripts) {
  assert.ok(mirrored.has(script), `workflow dependency is absent from public mirror: ${script}`)
}

assert.ok(
  mirrored.has('scripts/lib/github-sync-retry.sh'),
  'GitHub sync retry library is absent from the public mirror',
)

assert.ok(
  mirrored.has('testdata/contracts'),
  'agent file change contract fixtures are absent from the public mirror',
)

assert.ok(
  mirrored.has('testdata/turn_projection_golden.json'),
  'turn lifecycle projection fixture is absent from the public mirror',
)

const mirrorCovers = (relativePath) =>
  [...mirrored].some(
    (entry) => relativePath === entry || relativePath.startsWith(`${entry}/`),
  )

// Both service images rebuild this package from source. Keeping only their
// committed npm tarballs would leave the filtered repository unbuildable.
for (const service of ['memory', 'relay']) {
  const dockerfile = fs.readFileSync(path.join(repoRoot, service, 'Dockerfile'), 'utf8')
  if (dockerfile.includes('shared/session-source')) {
    for (const dependency of ['shared/session-source', 'scripts/build-session-source.mjs']) {
      assert.ok(mirrorCovers(dependency), `${service} build dependency is absent from public mirror: ${dependency}`)
    }
  }
}

const walkFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(absolutePath) : [absolutePath]
  })

for (const testFile of walkFiles(path.join(repoRoot, 'relay/src/__tests__'))) {
  if (!/\.[cm]?[jt]sx?$/.test(testFile)) continue
  const testText = fs.readFileSync(testFile, 'utf8')
  for (const match of testText.matchAll(
    /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  )) {
    const dependencyPath = path.resolve(path.dirname(testFile), match[1])
    const relativePath = path.relative(repoRoot, dependencyPath)
    if (relativePath.startsWith('..')) continue
    assert.ok(
      mirrorCovers(relativePath),
      `relay test dependency is absent from public mirror: ${relativePath}`,
    )
  }
}

assert.ok(
  ![...mirrored].some((entry) => entry === 'ios' || entry.startsWith('ios/')),
  'the public GitHub mirror must not include iOS source or project files',
)

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

// The private source owns the exporter; the public mirror only needs its copy helper.
const syncPath = path.join(repoRoot, 'scripts', 'sync-github.sh')
if (fs.existsSync(syncPath)) {
const syncScript = fs.readFileSync(syncPath, 'utf8')
assert.match(syncScript, /bash "\$SCRIPT_DIR\/lib\/github-mirror-copy\.sh"/, 'mirror must export committed files through the safe copier')
assert.doesNotMatch(syncScript, /cp -a "\$\{REPO_ROOT\}\/\$\{entry\}"/, 'mirror must not copy working-tree directories')
}
assert.ok(mirrored.has('scripts/lib/github-mirror-copy.sh'))
assert.ok(mirrored.has('scripts/tests/github-mirror-copy.test.mjs'))
console.log('github mirror contract tests passed')
