import type { ParsedEdge, ParsedGraph, ParsedNode } from './typescript-parser.js'

/**
 * Phase 4 graph diff (plan §3.6/§7 Task 7): deterministic structural
 * comparison of two graph versions. The changed-file/symbol sets feed the
 * bounded impact traversal and the stale projection.
 */

export interface GraphDiff {
  addedNodes: ParsedNode[]
  removedNodes: ParsedNode[]
  addedEdges: ParsedEdge[]
  removedEdges: ParsedEdge[]
  changedFiles: Set<string>
  changedSymbolKeys: Set<string>
}

const edgeKey = (edge: ParsedEdge): string =>
  `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`

const nodeKey = (node: ParsedNode): string => node.stableKey

export function diffGraphs(previous: ParsedGraph, next: ParsedGraph): GraphDiff {
  const previousNodes = new Map(previous.nodes.map(node => [nodeKey(node), node]))
  const nextNodes = new Map(next.nodes.map(node => [nodeKey(node), node]))
  const previousEdges = new Map(previous.edges.map(edge => [edgeKey(edge), edge]))
  const nextEdges = new Map(next.edges.map(edge => [edgeKey(edge), edge]))

  const addedNodes: ParsedNode[] = []
  const removedNodes: ParsedNode[] = []
  for (const [key, node] of nextNodes) {
    if (!previousNodes.has(key)) addedNodes.push(node)
  }
  for (const [key, node] of previousNodes) {
    if (!nextNodes.has(key)) removedNodes.push(node)
  }

  const addedEdges: ParsedEdge[] = []
  const removedEdges: ParsedEdge[] = []
  for (const [key, edge] of nextEdges) {
    if (!previousEdges.has(key)) addedEdges.push(edge)
  }
  for (const [key, edge] of previousEdges) {
    if (!nextEdges.has(key)) removedEdges.push(edge)
  }

  const changedFiles = new Set<string>()
  const changedSymbolKeys = new Set<string>()
  for (const node of [...addedNodes, ...removedNodes]) {
    if (node.kind === 'file' && node.path) changedFiles.add(node.path)
    if (node.kind === 'symbol' && node.path) {
      changedFiles.add(node.path)
      changedSymbolKeys.add(node.stableKey)
    }
  }
  for (const edge of [...addedEdges, ...removedEdges]) {
    changedFiles.add(edge.sourcePath)
  }

  return { addedNodes, removedNodes, addedEdges, removedEdges, changedFiles, changedSymbolKeys }
}

export { edgeKey, nodeKey }
