import type pg from 'pg'

import type { WikiStaleReason } from './types.js'

type Queryable = pg.Pool | pg.PoolClient

interface BindingComparison {
  wiki_id: string
  section_key: string
  source_kind: 'file' | 'symbol'
  stable_key: string
  path: string | null
  old_blob_hash: string | null
  new_blob_hash: string | null
  old_signature_hash: Buffer | null
  new_signature_hash: Buffer | null
  new_node_exists: boolean
}

function changedReason(row: BindingComparison): WikiStaleReason | null {
  if (!row.new_node_exists) return 'binding_removed'
  if (row.source_kind === 'symbol') {
    if (row.old_blob_hash !== row.new_blob_hash
      || !row.old_signature_hash?.equals(row.new_signature_hash ?? Buffer.alloc(0))) {
      return 'source_symbol_changed'
    }
    return null
  }
  return row.old_blob_hash !== row.new_blob_hash ? 'source_file_changed' : null
}

const REASON_PRIORITY: Readonly<Record<WikiStaleReason, number>> = {
  binding_removed: 3,
  source_symbol_changed: 2,
  source_file_changed: 1,
  graph_rebuilt: 0,
}

/** Derived stale projection over the current active Wiki's generated bindings. */
export function createWikiStaleService(pool: pg.Pool) {
  async function mark(input: {
    installationId: string
    repositoryId: string
    graphVersionId: string
    snapshotId: string
    client?: pg.PoolClient
  }): Promise<number> {
    const queryable: Queryable = input.client ?? pool
    const result = await queryable.query<BindingComparison>(`
      SELECT h.wiki_id::text, s.section_key, b.source_kind,
             bs.stable_key, bs.path,
             old_entry.blob_hash AS old_blob_hash,
             new_entry.blob_hash AS new_blob_hash,
             old_node.signature_hash AS old_signature_hash,
             new_node.signature_hash AS new_signature_hash,
             (new_node.node_id IS NOT NULL) AS new_node_exists
      FROM memory_wiki_heads h
      JOIN memory_wiki_versions v
        ON v.installation_id = h.installation_id
       AND v.wiki_version_id = h.active_version_id
      JOIN memory_wiki_sections s
        ON s.installation_id = v.installation_id
       AND s.wiki_version_id = v.wiki_version_id
       AND s.authority = 'generated'
      JOIN memory_wiki_source_bindings b
        ON b.installation_id = s.installation_id
       AND b.wiki_version_id = s.wiki_version_id
       AND b.section_id = s.section_id
       AND b.source_kind IN ('file','symbol')
      JOIN memory_wiki_build_sources bs
        ON bs.installation_id = v.installation_id
       AND bs.run_id = v.build_run_id
       AND bs.source_token = b.source_token
      LEFT JOIN memory_source_snapshot_entries old_entry
        ON old_entry.installation_id = v.installation_id
       AND old_entry.snapshot_id = v.source_snapshot_id
       AND old_entry.path = bs.path
      LEFT JOIN memory_source_snapshot_entries new_entry
        ON new_entry.installation_id = v.installation_id
       AND new_entry.snapshot_id = $4
       AND new_entry.path = bs.path
      LEFT JOIN memory_code_nodes old_node
        ON old_node.installation_id = v.installation_id
       AND old_node.graph_version_id = v.graph_version_id
       AND old_node.stable_key = bs.stable_key
      LEFT JOIN memory_code_nodes new_node
        ON new_node.installation_id = v.installation_id
       AND new_node.graph_version_id = $3
       AND new_node.stable_key = bs.stable_key
      WHERE h.installation_id = $1 AND h.repository_id = $2
      ORDER BY s.section_key, bs.ordinal
    `, [input.installationId, input.repositoryId, input.graphVersionId, input.snapshotId])
    const evaluatedSections = new Map<string, { wikiId: string; sectionKey: string }>()
    const sectionReasons = new Map<string, {
      wikiId: string
      sectionKey: string
      reason: WikiStaleReason
    }>()
    for (const row of result.rows) {
      const key = `${row.wiki_id}\n${row.section_key}`
      evaluatedSections.set(key, { wikiId: row.wiki_id, sectionKey: row.section_key })
      const reason = changedReason(row)
      if (!reason) continue
      const previous = sectionReasons.get(key)
      if (!previous || REASON_PRIORITY[reason] > REASON_PRIORITY[previous.reason]) {
        sectionReasons.set(key, { wikiId: row.wiki_id, sectionKey: row.section_key, reason })
      }
    }
    for (const [key, item] of evaluatedSections) {
      if (sectionReasons.has(key)) continue
      await queryable.query(`
        UPDATE memory_wiki_stale_marks SET cleared_at = NOW()
        WHERE installation_id = $1 AND wiki_id = $2 AND section_key = $3
          AND cleared_at IS NULL
      `, [input.installationId, item.wikiId, item.sectionKey])
    }
    for (const item of sectionReasons.values()) {
      await queryable.query(`
        INSERT INTO memory_wiki_stale_marks
          (installation_id, wiki_id, section_key, reason, source_snapshot_id,
           graph_version_id, marked_at, cleared_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)
        ON CONFLICT (installation_id, wiki_id, section_key) DO UPDATE
        SET reason = EXCLUDED.reason,
            source_snapshot_id = EXCLUDED.source_snapshot_id,
            graph_version_id = EXCLUDED.graph_version_id,
            marked_at = NOW(), cleared_at = NULL
      `, [input.installationId, item.wikiId, item.sectionKey, item.reason,
        input.snapshotId, input.graphVersionId])
    }
    return sectionReasons.size
  }

  return { markForGraphActivation: mark }
}
