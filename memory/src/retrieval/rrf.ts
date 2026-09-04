/**
 * Deterministic Reciprocal Rank Fusion (plan §8.1): score = Σ 1/(60 + rank)
 * over every pool that ranked the version. Ranks are 0-based; ties break by
 * the stable version id so identical inputs always fuse identically.
 */

export const RRF_K = 60

export interface RankedPool {
  name: string
  /** Version ids in rank order (best first). */
  ranked: readonly string[]
}

export interface FusedResult {
  versionId: string
  score: number
  /** Pool names that contributed to the score. */
  sources: string[]
}

export function fuseRanks(pools: readonly RankedPool[], limit: number): FusedResult[] {
  const scores = new Map<string, { score: number; sources: string[] }>()
  for (const pool of pools) {
    pool.ranked.forEach((versionId, rank) => {
      const entry = scores.get(versionId) ?? { score: 0, sources: [] }
      entry.score += 1 / (RRF_K + rank)
      if (!entry.sources.includes(pool.name)) entry.sources.push(pool.name)
      scores.set(versionId, entry)
    })
  }
  const results = [...scores.entries()].map(([versionId, entry]) => ({
    versionId,
    score: entry.score,
    sources: entry.sources,
  }))
  // Deterministic total order: score desc, then version id asc.
  results.sort((a, b) => b.score - a.score || (a.versionId < b.versionId ? -1 : 1))
  return results.slice(0, Math.max(0, limit))
}
