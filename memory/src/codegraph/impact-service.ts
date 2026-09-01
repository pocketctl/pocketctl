import {
  IMPACT_DEFAULT_DEPTH,
  IMPACT_MAX_EDGES,
  IMPACT_MAX_NODES,
  IMPACT_SERVER_BUDGET_MS,
  languageCapabilityFor,
} from './types.js'
import type { ParsedEdge, ParsedGraph } from './typescript-parser.js'

/**
 * Bounded change-impact traversal (ADR-0006 §4 / plan §3.6): reverse
 * dependency closure from changed files with hard node/edge/time budgets.
 * Hitting any bound returns `partial` plus a reason — never an empty
 * complete result; file_only or unsupported entries are explicit.
 */

export interface ImpactRequest {
  graph: ParsedGraph
  entryPaths: string[]
  depth?: number
  maxNodes?: number
  maxEdges?: number
  budgetMs?: number
}

export interface ImpactResult {
  paths: string[]
  nodeKeys: string[]
  edgeCount: number
  coverage: 'complete' | 'partial' | 'unsupported' | 'degraded'
  reasons: string[]
}

export function analyzeImpact(request: ImpactRequest): ImpactResult {
  const depth = request.depth ?? IMPACT_DEFAULT_DEPTH
  const maxNodes = request.maxNodes ?? IMPACT_MAX_NODES
  const maxEdges = request.maxEdges ?? IMPACT_MAX_EDGES
  const budgetMs = request.budgetMs ?? IMPACT_SERVER_BUDGET_MS
  const startedAt = Date.now()
  const reasons = new Set<string>()

  // Language honesty first: file_only and unsupported entries can never
  // produce a confident answer, whether or not they carry graph nodes.
  const entrySet = new Set(request.entryPaths)
  for (const entry of request.entryPaths) {
    const capability = languageCapabilityFor(entry)
    if (capability === 'file_only') {
      return {
        paths: [entry],
        nodeKeys: [`file:${entry}`],
        edgeCount: 0,
        coverage: 'unsupported',
        reasons: ['file_only_entry'],
      }
    }
    if (capability === 'unsupported') {
      return {
        paths: [entry],
        nodeKeys: [],
        edgeCount: 0,
        coverage: 'unsupported',
        reasons: ['unsupported_entry'],
      }
    }
  }

  // Entry validation: unknown entries are explicit errors, never silent
  // emptiness.
  const knownPaths = new Set<string>()
  for (const node of request.graph.nodes) {
    if (node.path) knownPaths.add(node.path)
  }
  for (const entry of request.entryPaths) {
    if (!knownPaths.has(entry)) {
      throw new Error('not_found')
    }
  }

  // Unresolved external dependencies of an entry file (imports pointing
  // nowhere, undeclared packages) make its closure untrustworthy; dynamic
  // calls INSIDE the entry do not change who depends on it.
  let languageDowngrade: 'degraded' | null = null
  for (const edge of request.graph.edges) {
    if ((edge.kind === 'import' || edge.kind === 'dependency')
      && edge.resolution !== 'resolved'
      && entrySet.has(edge.sourcePath)) {
      languageDowngrade = 'degraded'
      break
    }
  }

  // Reverse adjacency: who depends on each node's file.
  const reverse = new Map<string, Set<string>>()
  const forward = new Map<string, Set<string>>()
  const pairUnresolved = new Map<string, boolean>()
  for (const edge of request.graph.edges) {
    const fromFile = stableKeyPath(edge.fromStableKey)
    const toFile = stableKeyPath(edge.toStableKey)
    if (!fromFile || !toFile || fromFile === toFile) continue
    const pair = `${fromFile}\n${toFile}`
    pairUnresolved.set(pair, (pairUnresolved.get(pair) ?? false) || edge.resolution !== 'resolved')
    if (!reverse.has(toFile)) reverse.set(toFile, new Set())
    reverse.get(toFile)!.add(fromFile)
    if (!forward.has(fromFile)) forward.set(fromFile, new Set())
    forward.get(fromFile)!.add(toFile)
  }
  const traversedPairs = new Set<string>()

  const visited = new Set<string>(request.entryPaths)
  let frontier = [...request.entryPaths]
  let traversedEdges = 0
  let capped = false

  if (depth <= 0) {
    reasons.add('depth_limit')
    capped = true
  }

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = []
    for (const current of frontier) {
      // Direct dependencies also belong to the impact set (level-1 forward).
      if (level === 0) {
        for (const dependent of forward.get(current) ?? []) {
          traversedPairs.add(`${current}\n${dependent}`)
          if (!visited.has(dependent)) {
            if (visited.size >= maxNodes) { capped = true; reasons.add('node_limit'); break }
            visited.add(dependent)
            traversedEdges++
          }
        }
      }
      for (const dependent of reverse.get(current) ?? []) {
        traversedPairs.add(`${dependent}\n${current}`)
        traversedEdges++
        if (traversedEdges > maxEdges) { capped = true; reasons.add('edge_limit'); break }
        if (!visited.has(dependent)) {
          if (visited.size >= maxNodes) { capped = true; reasons.add('node_limit'); break }
          visited.add(dependent)
          next.push(dependent)
        }
      }
      if (Date.now() - startedAt > budgetMs) {
        capped = true
        reasons.add('time_budget')
        break
      }
    }
    frontier = next
    if (capped) break
  }

  const nodeKeys: string[] = []
  for (const node of request.graph.nodes) {
    if (node.path && visited.has(node.path)) nodeKeys.push(node.stableKey)
  }

  let coverage: ImpactResult['coverage'] = 'complete'
  if (capped) coverage = 'partial'
  else {
    // Only unresolved/dynamic edges actually traversed degrade confidence;
    // unrelated dynamic calls elsewhere in the graph do not.
    let touchesClosure = false
    for (const pair of traversedPairs) {
      if (pairUnresolved.get(pair)) {
        touchesClosure = true
        break
      }
    }
    // languageDowngrade already covers entry-rooted dynamic/unresolved edges.
    if (languageDowngrade || touchesClosure) {
      coverage = 'degraded'
      reasons.add('unresolved_or_dynamic_edges')
    }
  }

  return {
    paths: [...visited].sort(),
    nodeKeys: nodeKeys.sort(),
    edgeCount: traversedEdges,
    coverage,
    reasons: [...reasons].sort(),
  }
}

function stableKeyPath(stableKey: string): string | null {
  if (stableKey.startsWith('file:')) return stableKey.slice('file:'.length)
  if (stableKey.startsWith('symbol:')) {
    const rest = stableKey.slice('symbol:'.length)
    const hashIndex = rest.indexOf('#')
    if (hashIndex > 0) return rest.slice(0, hashIndex)
  }
  return null
}

export type { ParsedEdge, ParsedGraph }
