import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import ts from 'typescript'

import {
  canonicalJsonStringify,
  languageCapabilityFor,
  type CodeEdgeKind,
  type CodeEdgeResolution,
  type CodeNodeKind,
  type GraphCoverage,
} from './types.js'

/**
 * Deterministic TypeScript/JavaScript parser (ADR-0006 §3-§4). Builds an
 * in-memory Program/CompilerHost over accepted snapshot entries only: no
 * repository code, plugin, tsconfig hook, package script, emit, or network
 * resolution ever executes. Output ordering and ids are canonical, so the
 * same manifest and parser version always produce the same content hash.
 */

export const PARSER_VERSION = 'phase4-parser-v1'

export interface ParsedNode {
  nodeId: string
  kind: CodeNodeKind
  stableKey: string
  path: string | null
  name: string
  symbolKind?: string
  startLine?: number
  startColumn?: number
  endLine?: number
  endColumn?: number
  signatureHash?: string
  metadata: Record<string, unknown>
}

export interface ParsedEdge {
  edgeId: string
  kind: CodeEdgeKind
  fromStableKey: string
  toStableKey: string
  sourcePath: string
  sourceLine?: number
  resolution: CodeEdgeResolution
  metadata: Record<string, unknown>
}

export interface ParseCoverage {
  files: Record<string, 'complete' | 'file_only' | 'unsupported'>
  summary: { complete: number; fileOnly: number; unsupported: number }
}

export interface ParsedGraph {
  parserVersion: string
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  coverage: ParseCoverage
  contentHash: string
}

export interface ParseInputFile {
  path: string
  content: string
}

const SYMBOL_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const RESOLUTION_SUFFIXES = [
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
]

/** Deterministic id: hash-derived UUID so repeated builds agree byte-for-byte. */
function deterministicUuid(name: string): string {
  const digest = createHash('sha256').update(name).digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function parseCodeSnapshot(input: {
  files: readonly ParseInputFile[]
  parserVersion?: string
  /**
   * Incremental collection filter: when present, only symbol nodes defined
   * in these paths and edges whose source lies in these paths are emitted.
   * File and external nodes stay complete so copied edges stay resolvable.
   */
  collectPaths?: ReadonlySet<string>
}): ParsedGraph {
  const parserVersion = input.parserVersion ?? PARSER_VERSION
  const symbolFiles: ParseInputFile[] = []
  const coverage: ParseCoverage = { files: {}, summary: { complete: 0, fileOnly: 0, unsupported: 0 } }
  for (const file of input.files) {
    const capability = languageCapabilityFor(file.path)
    if (capability === 'symbols_and_edges' && !isMinified(file.path)) {
      symbolFiles.push({ ...file })
      coverage.files[file.path] = 'complete'
      coverage.summary.complete++
    } else if (capability === 'file_only') {
      coverage.files[file.path] = 'file_only'
      coverage.summary.fileOnly++
    } else {
      coverage.files[file.path] = 'unsupported'
      coverage.summary.unsupported++
    }
  }
  symbolFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const virtualRoot = '/'
  const sourceMap = new Map<string, ts.SourceFile>()
  const pathSet = new Set(symbolFiles.map(file => file.path))
  for (const file of symbolFiles) {
    sourceMap.set(virtualRoot + file.path, ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.ES2022,
      true,
      scriptKindFor(file.path),
    ))
  }

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => sourceMap.get(fileName),
    getDefaultLibFileName: () => 'lib.d.ts',
    getDefaultLibLocation: () => virtualRoot,
    writeFile: () => undefined,
    getCurrentDirectory: () => virtualRoot,
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => sourceMap.has(fileName),
    readFile: (fileName) => sourceMap.get(fileName)?.text ?? undefined,
    directoryExists: (directoryName) => {
      if (directoryName === virtualRoot) return true
      const prefix = directoryName.endsWith('/') ? directoryName : `${directoryName}/`
      for (const key of sourceMap.keys()) {
        if (key.startsWith(prefix)) return true
      }
      return false
    },
    getDirectories: () => [],
    readDirectory: () => [],
    resolveModuleNames: (moduleNames, containingFile) => moduleNames.map(specifier => {
      if (!specifier.startsWith('.')) return undefined
      const resolved = resolveRelative(specifier, containingFile, virtualRoot, pathSet)
      if (!resolved) return undefined
      return { resolvedFileName: resolved, extension: ts.Extension.Ts, isExternalLibraryImport: false }
    }),
  }

  const program = ts.createProgram(
    [...sourceMap.keys()],
    {
      noResolve: false,
      allowJs: true,
      noLib: true,
      skipLibCheck: true,
      skipDefaultLibCheck: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      types: [],
    },
    host,
  )
  const checker = program.getTypeChecker()

  const nodes = new Map<string, ParsedNode>()
  const edges = new Map<string, ParsedEdge>()
  const declaredDependencies = readDeclaredDependencies(input.files)
  const fileNode = (path: string): ParsedNode => {
    const stableKey = `file:${path}`
    let node = nodes.get(stableKey)
    if (!node) {
      node = {
        nodeId: deterministicUuid(stableKey),
        kind: 'file',
        stableKey,
        path,
        name: path,
        metadata: {},
      }
      nodes.set(stableKey, node)
    }
    return node
  }
  const externalNode = (packageName: string): ParsedNode => {
    const stableKey = `external:${packageName}`
    let node = nodes.get(stableKey)
    if (!node) {
      node = {
        nodeId: deterministicUuid(stableKey),
        kind: 'external_package',
        stableKey,
        path: null,
        name: packageName,
        metadata: {},
      }
      nodes.set(stableKey, node)
    }
    return node
  }
  const addEdge = (edge: Omit<ParsedEdge, 'edgeId'>): void => {
    const canonical = `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`
    if (!edges.has(canonical)) {
      edges.set(canonical, { ...edge, edgeId: deterministicUuid(canonical) })
    }
  }

  for (const file of symbolFiles) {
    const fileStableKey = `file:${file.path}`
    fileNode(file.path)

    const sourceFile = sourceMap.get(virtualRoot + file.path)!
    const symbolByDeclaration = new Map<ts.Node, string>()

    const registerSymbol = (
      name: string,
      containerFqn: string | null,
      declaration: ts.NamedDeclaration,
      symbolKind: string,
    ): { stableKey: string; fqn: string } => {
      const start = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile))
      const end = sourceFile.getLineAndCharacterOfPosition(declaration.getEnd())
      const fqn = containerFqn ? `${containerFqn}.${name}` : name
      const stableKey = `symbol:${file.path}#${fqn}:${symbolKind}:${start.line + 1}`
      if (!nodes.has(stableKey)) {
        nodes.set(stableKey, {
          nodeId: deterministicUuid(stableKey),
          kind: 'symbol',
          stableKey,
          path: file.path,
          name,
          symbolKind,
          startLine: start.line + 1,
          startColumn: start.character + 1,
          endLine: end.line + 1,
          endColumn: end.character + 1,
          metadata: {},
        })
        symbolByDeclaration.set(declaration, stableKey)
      }
      return { stableKey, fqn }
    }

    const extractDeclarations = (node: ts.Node, containerFqn: string | null): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const registered = registerSymbol(node.name.text, containerFqn, node, 'class')
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name) {
            const memberName = member.name.getText(sourceFile)
            registerSymbol(memberName, registered.fqn, member, 'method')
          }
        }
      } else if (ts.isInterfaceDeclaration(node) && node.name) {
        registerSymbol(node.name.text, containerFqn, node, 'interface')
      } else if (ts.isTypeAliasDeclaration(node)) {
        registerSymbol(node.name.text, containerFqn, node, 'type_alias')
      } else if (ts.isEnumDeclaration(node)) {
        registerSymbol(node.name.text, containerFqn, node, 'enum')
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        registerSymbol(node.name.text, containerFqn, node, 'function')
      } else if (ts.isModuleDeclaration(node) && !ts.isStringLiteral(node.name)) {
        const registeredNamespace = registerSymbol(String(node.name.escapedText), containerFqn, node, 'namespace')
        if (node.body) extractDeclarations(node.body, registeredNamespace.fqn)
      } else if (ts.isVariableStatement(node)) {
        const exported = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
        if (exported) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              const isFunctionLike = declaration.initializer
                && (ts.isArrowFunction(declaration.initializer)
                  || ts.isFunctionExpression(declaration.initializer))
              const kind = isFunctionLike ? 'function' : 'variable'
              registerSymbol(declaration.name.text, containerFqn, declaration, kind)
            }
          }
        }
      }
      ts.forEachChild(node, child => extractDeclarations(child, containerFqn))
    }
    extractDeclarations(sourceFile, null)

    // Import edges: relative modules resolve inside the manifest; bare
    // specifiers become external package nodes with dependency resolution.
    const collectImports = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const specifier = node.moduleSpecifier.getText(sourceFile).slice(1, -1)
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        if (specifier.startsWith('.')) {
          const resolved = resolveRelative(specifier, virtualRoot + file.path, virtualRoot, pathSet)
          if (resolved) {
            const targetPath = resolved.slice(virtualRoot.length)
            fileNode(targetPath)
            addEdge({
              kind: 'import',
              fromStableKey: fileStableKey,
              toStableKey: `file:${targetPath}`,
              sourcePath: file.path,
              sourceLine: line,
              resolution: 'resolved',
              metadata: {},
            })
            if (isTestPath(file.path) && !isTestPath(targetPath)) {
              addEdge({
                kind: 'test',
                fromStableKey: fileStableKey,
                toStableKey: `file:${targetPath}`,
                sourcePath: file.path,
                sourceLine: line,
                resolution: 'resolved',
                metadata: {},
              })
            }
          } else {
            const external = externalNode(specifier)
            addEdge({
              kind: 'import',
              fromStableKey: fileStableKey,
              toStableKey: external.stableKey,
              sourcePath: file.path,
              sourceLine: line,
              resolution: 'unresolved',
              metadata: { unresolved_kind: 'relative' },
            })
          }
        } else {
          const external = externalNode(specifier)
          addEdge({
            kind: 'import',
            fromStableKey: fileStableKey,
            toStableKey: external.stableKey,
            sourcePath: file.path,
            sourceLine: line,
            resolution: 'resolved',
            metadata: {},
          })
          addEdge({
            kind: 'dependency',
            fromStableKey: fileStableKey,
            toStableKey: external.stableKey,
            sourcePath: file.path,
            sourceLine: line,
            resolution: declaredDependencies.has(specifier) ? 'resolved' : 'unresolved',
            metadata: {},
          })
        }
      }
      ts.forEachChild(node, collectImports)
    }
    collectImports(sourceFile)

    // Definition edges bind symbols to their file.
    for (const [stableKey, node2] of nodes) {
      if (stableKey.startsWith(`symbol:${file.path}#`) && !edges.has(`definition\n${fileStableKey}\n${stableKey}\n${file.path}\n0\nresolved`)) {
        addEdge({
          kind: 'definition',
          fromStableKey: fileStableKey,
          toStableKey: stableKey,
          sourcePath: file.path,
          sourceLine: node2.startLine,
          resolution: 'resolved',
          metadata: {},
        })
      }
    }
  }

  // Reference and call edges through the type checker. The checker is the
  // single symbol authority; identifiers that resolve to extracted symbols
  // become reference edges and static callees become call edges.
  for (const file of symbolFiles) {
    const sourceFile = sourceMap.get(virtualRoot + file.path)!
    const fileStableKey = `file:${file.path}`
    const pathPrefix = `symbol:${file.path}#`

    const containerStack: string[] = []
    const enclosingSymbol = (): string => containerStack[containerStack.length - 1] ?? fileStableKey

    const visit = (node: ts.Node): void => {
      const pushed = maybePushContainer(node)
      if (ts.isCallExpression(node)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        const calleeSymbol = resolveAliased(checker.getSymbolAtLocation(node.expression))
        const calleeKey = calleeSymbol ? symbolKeyFor(calleeSymbol) : undefined
        if (calleeKey && nodes.has(calleeKey)) {
          addEdge({
            kind: 'call',
            fromStableKey: enclosingSymbol(),
            toStableKey: calleeKey,
            sourcePath: file.path,
            sourceLine: line,
            resolution: 'resolved',
            metadata: {},
          })
        } else {
          // Dynamic or unresolved callee: visible as dynamic, never as a
          // confident no-impact.
          addEdge({
            kind: 'call',
            fromStableKey: enclosingSymbol(),
            toStableKey: fileStableKey,
            sourcePath: file.path,
            sourceLine: line,
            resolution: 'dynamic',
            metadata: {},
          })
        }
      } else if (ts.isIdentifier(node)) {
        const referenced = resolveAliased(checker.getSymbolAtLocation(node))
        if (referenced && !isDeclarationName(node)) {
          const targetKey = symbolKeyFor(referenced)
          if (targetKey && targetKey.startsWith(pathPrefix) === false && nodes.has(targetKey)) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
            addEdge({
              kind: 'reference',
              fromStableKey: enclosingSymbol(),
              toStableKey: targetKey,
              sourcePath: file.path,
              sourceLine: line,
              resolution: 'resolved',
              metadata: {},
            })
          }
        }
      }
      ts.forEachChild(node, visit)
      if (pushed) containerStack.pop()

      function maybePushContainer(current: ts.Node): boolean {
        if (!ts.isClassDeclaration(current) && !ts.isFunctionDeclaration(current)
          && !ts.isMethodDeclaration(current) && !ts.isInterfaceDeclaration(current)) {
          return false
        }
        const name = current.name
        if (!name) return false
        const stableKey = findSymbolKeyInRange(file.path, name.getText(sourceFile), current, sourceFile)
        if (stableKey) {
          containerStack.push(stableKey)
          return true
        }
        return false
      }
    }
    visit(sourceFile)
  }

  function findSymbolKeyInRange(path: string, name: string, node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    for (const key of nodes.keys()) {
      if (key.startsWith(`symbol:${path}#${buildFqnPrefix(name)}`) && key.endsWith(`:${start}`)) {
        return key
      }
    }
    // Nested containers (Repository.add) are keyed by fqn; fall back to any
    // symbol on this path whose name segment matches.
    for (const key of nodes.keys()) {
      if (key.startsWith(`symbol:${path}#`) && key.includes(`.${name}:`)) {
        const line = Number(key.slice(key.lastIndexOf(':') + 1))
        const nodeStart = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        if (Math.abs(line - nodeStart) <= 1) return key
      }
    }
    return undefined
  }

  function buildFqnPrefix(name: string): string {
    return name
  }

  function resolveAliased(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (!symbol) return undefined
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        const resolved = checker.getAliasedSymbol(symbol)
        return resolved && resolved.declarations?.length ? resolved : symbol
      } catch {
        return symbol
      }
    }
    return symbol
  }

  function symbolKeyFor(symbol: ts.Symbol): string | undefined {
    for (const declaration of symbol.declarations ?? []) {
      for (const [key, node] of nodes) {
        if (node.kind === 'symbol' && node.path && node.name === symbol.getName()) {
          // Same-name disambiguation: prefer declarations in the same file.
          if (declaration.getSourceFile().fileName === `/${node.path}`) {
            return key
          }
        }
      }
    }
    return undefined
  }

  function isDeclarationName(node: ts.Identifier): boolean {
    const parent: ts.Node = node.parent
    const named = parent as ts.NamedDeclaration
    return (ts.isImportSpecifier(parent) || ts.isImportClause(parent)
      || ts.isImportEqualsDeclaration(parent) || ts.isNamespaceImport(parent)
      || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)
      || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
      || ts.isEnumDeclaration(parent) || ts.isVariableDeclaration(parent)
      || ts.isMethodDeclaration(parent)) && named.name === node
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => (a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0))
  const orderedEdges = [...edges.values()].sort((a, b) => {
    const tuple = (edge: ParsedEdge) => `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`
    return tuple(a) < tuple(b) ? -1 : tuple(a) > tuple(b) ? 1 : 0
  })

  const collectedNodes = input.collectPaths
    ? orderedNodes.filter(node =>
      node.kind !== 'symbol' || (node.path !== null && input.collectPaths!.has(node.path)))
    : orderedNodes
  const collectedEdges = input.collectPaths
    ? orderedEdges.filter(edge => input.collectPaths!.has(edge.sourcePath))
    : orderedEdges
  const orderedNodesFinal = collectedNodes
  const orderedEdgesFinal = collectedEdges

  const coverageFiles: Record<string, string> = {}
  for (const path of Object.keys(coverage.files).sort()) {
    coverageFiles[path] = coverage.files[path]!
  }
  const canonical = canonicalJsonStringify({
    parserVersion,
    nodes: orderedNodesFinal.map(node => ({
      nodeId: node.nodeId, kind: node.kind, stableKey: node.stableKey, path: node.path,
      name: node.name, symbolKind: node.symbolKind ?? null,
      startLine: node.startLine ?? null, startColumn: node.startColumn ?? null,
      endLine: node.endLine ?? null, endColumn: node.endColumn ?? null,
      metadata: node.metadata,
    })),
    edges: orderedEdgesFinal.map(edge => ({
      edgeId: edge.edgeId, kind: edge.kind, fromStableKey: edge.fromStableKey,
      toStableKey: edge.toStableKey, sourcePath: edge.sourcePath,
      sourceLine: edge.sourceLine ?? null, resolution: edge.resolution, metadata: edge.metadata,
    })),
    coverage: { files: coverageFiles, summary: coverage.summary },
  })
  return {
    parserVersion,
    nodes: orderedNodesFinal,
    edges: orderedEdgesFinal,
    coverage: { files: coverageFiles as ParseCoverage['files'], summary: coverage.summary },
    contentHash: createHash('sha256').update(canonical).digest('hex'),
  }
}

/**
 * Incremental assembly (plan §3.6): copy unchanged nodes/edges from the
 * previous graph and merge them with the freshly collected output for the
 * changed paths. The result is canonically re-sorted so its hash compares
 * directly against a clean full rebuild.
 */
export function assembleIncrementalGraph(input: {
  previousNodes: readonly ParsedNode[]
  previousEdges: readonly ParsedEdge[]
  changedPaths: ReadonlySet<string>
  collected: ParsedGraph
}): { nodes: ParsedNode[]; edges: ParsedEdge[] } {
  const unchangedNodes = input.previousNodes.filter(node =>
    node.kind !== 'symbol' || (node.path !== null && !input.changedPaths.has(node.path)))
  const unchangedEdges = input.previousEdges.filter(edge =>
    !input.changedPaths.has(edge.sourcePath))
  const nodes = [...unchangedNodes, ...input.collected.nodes]
    .sort((a, b) => (a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0))
  const edges = [...unchangedEdges, ...input.collected.edges]
    .sort((a, b) => {
      const tuple = (edge: ParsedEdge) => `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`
      return tuple(a) < tuple(b) ? -1 : tuple(a) > tuple(b) ? 1 : 0
    })
  // Deduplicate by canonical identity, preferring the freshly collected row.
  const seenNodes = new Set<string>()
  const dedupedNodes: ParsedNode[] = []
  for (const node of nodes) {
    if (seenNodes.has(node.stableKey)) continue
    seenNodes.add(node.stableKey)
    dedupedNodes.push(node)
  }
  const seenEdges = new Set<string>()
  const dedupedEdges: ParsedEdge[] = []
  for (const edge of edges) {
    const key = `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    dedupedEdges.push(edge)
  }
  return { nodes: dedupedNodes, edges: dedupedEdges }
}

/** Canonical graph hash over the ordered node/edge projections. */
export function canonicalGraphHash(nodes: readonly ParsedNode[], edges: readonly ParsedEdge[]): string {
  return parseCanonical(nodes, edges)
}

function parseCanonical(nodes: readonly ParsedNode[], edges: readonly ParsedEdge[]): string {
  const canonical = canonicalJsonStringify({
    nodes: nodes.map(node => [node.nodeId, node.stableKey, node.kind, node.path, node.name]),
    edges: edges.map(edge => [edge.edgeId, edge.kind, edge.fromStableKey, edge.toStableKey, edge.sourcePath, edge.sourceLine ?? null, edge.resolution]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function resolveRelative(specifier: string, containingFile: string, root: string, pathSet: Set<string>): string | undefined {
  const base = dirname(containingFile)
  const candidates: string[] = [normalize(`${base}/${specifier}`)]
  // ESM style './x.js' resolves to the compiled TS source 'x.ts'.
  for (const jsSuffix of ['.js', '.jsx', '.mjs', '.cjs']) {
    if (specifier.endsWith(jsSuffix)) {
      candidates.push(normalize(`${base}/${specifier.slice(0, -jsSuffix.length)}`))
      break
    }
  }
  for (const base_candidate of candidates) {
    for (const suffix of RESOLUTION_SUFFIXES) {
      const candidate = `${base_candidate}${suffix}`
      if (pathSet.has(candidate.slice(root.length))) return candidate
    }
    if (pathSet.has(base_candidate.slice(root.length))) return base_candidate
  }
  return undefined
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

function normalize(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)(\/|$)/.test(path) || /\.test\.[a-z]+$/.test(path) || /\.spec\.[a-z]+$/.test(path)
}

function isMinified(path: string): boolean {
  return path.endsWith('.min.js') || path.endsWith('.min.css')
}

function readDeclaredDependencies(files: readonly ParseInputFile[]): Set<string> {
  const set = new Set<string>()
  const manifest = files.find(file => file.path === 'package.json')
  if (!manifest) return set
  try {
    const parsed = JSON.parse(manifest.content) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const key of Object.keys(parsed.dependencies ?? {})) set.add(key)
    for (const key of Object.keys(parsed.devDependencies ?? {})) set.add(key)
  } catch {
    // A malformed manifest simply contributes no declarations.
  }
  return set
}

/** Read a bounded fixture directory into parser input (tests only). */
export function loadFixtureFiles(root: string): ParseInputFile[] {
  const files: ParseInputFile[] = []
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      if (statSync(absolute).isDirectory()) {
        walk(absolute)
      } else {
        files.push({ path: absolute.slice(root.length + 1).split('\\').join('/'), content: readFileSync(absolute, 'utf8') })
      }
    }
  }
  walk(root)
  return files
}

export type { GraphCoverage }
