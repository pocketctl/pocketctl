import type { ParsedEdge, ParsedGraph, ParsedNode } from './typescript-parser.js'

/**
 * Deterministic graph candidate validation (plan §3.6): referential
 * integrity, range sanity, stable-key uniqueness, and canonical ordering are
 * checked before any activation. A failing candidate never switches a head.
 */

export interface GraphValidationVerdict {
  ok: boolean
  errors: string[]
}

export function validateGraphCandidate(graph: ParsedGraph): GraphValidationVerdict {
  const errors: string[] = []

  const stableKeys = new Set<string>()
  for (const node of graph.nodes) {
    if (stableKeys.has(node.stableKey)) {
      errors.push(`duplicate_stable_key:${node.stableKey}`)
    }
    stableKeys.add(node.stableKey)
    if (!node.stableKey || !node.nodeId) {
      errors.push('missing_node_identity')
    }
    if (node.kind === 'symbol') {
      if (!node.path) errors.push('symbol_without_path')
      if (!node.startLine || node.startLine < 1) errors.push('invalid_start_line')
      if (node.endLine !== undefined && node.startLine !== undefined && node.endLine < node.startLine) {
        errors.push('inverted_range')
      }
      if (!node.symbolKind) errors.push('symbol_without_kind')
    }
  }

  for (const edge of graph.edges) {
    if (!stableKeys.has(edge.fromStableKey)) errors.push(`dangling_from:${edge.edgeId}`)
    if (!stableKeys.has(edge.toStableKey)) errors.push(`dangling_to:${edge.edgeId}`)
    if (!edge.sourcePath) errors.push('edge_without_source_path')
    if (edge.sourceLine !== undefined && edge.sourceLine < 1) errors.push('invalid_edge_line')
    if (!['resolved', 'unresolved', 'dynamic'].includes(edge.resolution)) {
      errors.push('invalid_resolution')
    }
  }

  // Canonical ordering must already hold: the content hash is only
  // meaningful over the sorted projection.
  for (let i = 1; i < graph.nodes.length; i++) {
    if (graph.nodes[i - 1]!.stableKey >= graph.nodes[i]!.stableKey) {
      errors.push('nodes_not_canonical')
      break
    }
  }
  const edgeTuple = (edge: ParsedEdge) => `${edge.kind}\n${edge.fromStableKey}\n${edge.toStableKey}\n${edge.sourcePath}\n${edge.sourceLine ?? 0}\n${edge.resolution}`
  for (let i = 1; i < graph.edges.length; i++) {
    if (edgeTuple(graph.edges[i - 1]!) >= edgeTuple(graph.edges[i]!)) {
      errors.push('edges_not_canonical')
      break
    }
  }

  if (graph.nodes.some((node: ParsedNode) => node.kind === 'file' && !node.path)) {
    errors.push('file_node_without_path')
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)].slice(0, 32) }
}

export type { ParsedEdge }
