import type pg from 'pg'

export function createWikiReadService(pool: pg.Pool) {
  return {
    async getActiveWiki(input: { installationId: string; repositoryId: string }) {
      const head = await pool.query<{
        wiki_id: string
        wiki_version_id: string
        generation: string
        revision: string
        source_snapshot_id: string
        graph_version_id: string
        commit_sha: string
        coverage: string
        content_hash: string
        owner_scope_kind: string | null
        owner_scope_id: string | null
        build_run_id: string | null
      }>(`
        SELECT h.wiki_id::text, v.wiki_version_id::text, w.generation::text,
               h.revision::text,
               v.source_snapshot_id::text, v.graph_version_id::text, ss.commit_sha,
               g.coverage, v.content_hash, os.owner_scope_kind,
               os.owner_scope_id::text, v.build_run_id::text
        FROM memory_wiki_heads h
        JOIN memory_wikis w
          ON w.installation_id = h.installation_id AND w.wiki_id = h.wiki_id
        JOIN memory_wiki_versions v
          ON v.installation_id = h.installation_id AND v.wiki_version_id = h.active_version_id
        JOIN memory_source_snapshots ss
          ON ss.installation_id = v.installation_id AND ss.snapshot_id = v.source_snapshot_id
        JOIN memory_code_graph_versions g
          ON g.installation_id = v.installation_id AND g.graph_version_id = v.graph_version_id
        LEFT JOIN memory_owner_scopes os ON os.installation_id = h.installation_id
        WHERE h.installation_id = $1 AND h.repository_id = $2 AND v.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM memory_repository_tombstones t
            WHERE t.installation_id = h.installation_id AND t.repository_id = h.repository_id
          )
      `, [input.installationId, input.repositoryId])
      const wiki = head.rows[0]
      if (!wiki) return null
      const pages = await pool.query(`
        SELECT page_id::text, page_key, title, position
        FROM memory_wiki_pages WHERE installation_id = $1 AND wiki_version_id = $2
        ORDER BY position, page_key LIMIT 32
      `, [input.installationId, wiki.wiki_version_id])
      const sections = await pool.query(`
        SELECT s.section_id::text, s.page_id::text, s.section_key, s.heading,
               s.markdown, s.authority, s.coverage, s.position,
               (m.section_key IS NOT NULL AND m.cleared_at IS NULL) AS stale,
               m.reason AS stale_reason,
               COALESCE(mh.locked, s.authority = 'locked') AS locked,
               COALESCE(mh.lock_version, 0)::text AS lock_version
        FROM memory_wiki_sections s
        LEFT JOIN memory_wiki_stale_marks m
         ON m.installation_id = s.installation_id AND m.wiki_id = $3
         AND m.section_key = s.section_key
        LEFT JOIN memory_wiki_manual_section_heads mh
          ON mh.installation_id = s.installation_id AND mh.wiki_id = $3
         AND mh.section_key = s.section_key
        WHERE s.installation_id = $1 AND s.wiki_version_id = $2
        ORDER BY s.page_id, s.position, s.section_key LIMIT 256
      `, [input.installationId, wiki.wiki_version_id, wiki.wiki_id])
      const citations = await pool.query(`
        SELECT b.section_id::text, b.source_kind, b.source_token,
               b.source_snapshot_id::text, b.commit_sha,
               bs.stable_key, bs.path, bs.content_hash
        FROM memory_wiki_source_bindings b
        LEFT JOIN memory_wiki_build_sources bs
          ON bs.installation_id = b.installation_id
         AND bs.run_id = $3 AND bs.source_token = b.source_token
        WHERE b.installation_id = $1 AND b.wiki_version_id = $2
        ORDER BY b.section_id, b.source_token
      `, [input.installationId, wiki.wiki_version_id, wiki.build_run_id])
      const bySection = new Map<string, Record<string, unknown>[]>()
      for (const citation of citations.rows) {
        const list = bySection.get(citation.section_id) ?? []
        list.push(citation)
        bySection.set(citation.section_id, list)
      }
      const byPage = new Map<string, Record<string, unknown>[]>()
      for (const section of sections.rows) {
        const list = byPage.get(section.page_id) ?? []
        list.push({
          ...section,
          lock_version: Number(section.lock_version),
          citations: bySection.get(section.section_id) ?? [],
        })
        byPage.set(section.page_id, list)
      }
      return {
        repository_id: input.repositoryId,
        owner_scope_kind: wiki.owner_scope_kind,
        owner_scope_id: wiki.owner_scope_id,
        wiki_id: wiki.wiki_id,
        wiki_version_id: wiki.wiki_version_id,
        generation: Number(wiki.generation),
        revision: Number(wiki.revision),
        snapshot_id: wiki.source_snapshot_id,
        graph_version_id: wiki.graph_version_id,
        commit_sha: wiki.commit_sha,
        coverage: wiki.coverage,
        content_hash: wiki.content_hash,
        stale: sections.rows.some(section => section.stale),
        pages: pages.rows.map(page => ({ ...page, sections: byPage.get(page.page_id) ?? [] })),
      }
    },
  }
}
