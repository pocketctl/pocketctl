import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { canonicalJsonStringify } from '../codegraph/types.js'
import type { ValidatedV2Grant } from '../governance/authorization.js'
import { requireCurrentWikiPermission } from './authorization.js'
import type { WikiBuildSource } from './repository.js'
import { wikiCandidateContentHash } from './skeleton-builder.js'
import type { WikiCandidateDocumentV1, WikiCoverage } from './types.js'
import { validateWikiCandidate } from './validator.js'
import type { Phase4Metrics } from '../metrics.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { readGitAssets, type GitReaderInput } from '../git-sync/asset-reader.js'
import { WikiAssetSchema, type WikiAsset } from '../git-sync/types.js'
import { createWikiManualService } from './manual-service.js'
import { assertImportApproval, type GovernedImport } from '../git-sync/governance-adapter.js'

export type WikiPublicationErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'state_conflict'
  | 'revision_conflict'
  | 'stale_generation'
  | 'tombstoned'
  | 'source_missing'
  | 'candidate_invalid'
  | 'section_key_collision'

export class WikiPublicationError extends Error {
  constructor(readonly code: WikiPublicationErrorCode) {
    super(`wiki_publication_${code}`)
  }
}

interface PublishInput {
  grant: ValidatedV2Grant
  targetInstallationId: string
  wikiId: string
  runId: string
  expectedGeneration: number
  expectedHeadRevision: number
}

function remapError(error: unknown): never {
  if (error instanceof WikiPublicationError) throw error
  if (error instanceof Error && error.message === 'wiki_forbidden') {
    throw new WikiPublicationError('forbidden')
  }
  throw error
}

export function createWikiPublicationService(
  pool: pg.Pool,
  options: { metrics?: Phase4Metrics } = {},
) {
  return {
    /** Intentional withdrawal retains version/section history and permanently
     * retires this Wiki identity. Git caller owns the original transaction. */
    async revoke(input:{grant:ValidatedV2Grant;targetInstallationId:string;current:WikiAsset;sourceContext:GitReaderInput;governed:GovernedImport}):Promise<{wikiVersionId:string;revision:number}> {
      const current=WikiAssetSchema.parse(input.current),client=await pool.connect()
      try {
        await client.query('BEGIN')
        await assertImportApproval(client,input.governed)
        const approved=input.governed.proposal.proposed_document.result
        if(approved.kind!=='proposal'||!approved.asset.deleted||canonicalJsonString(input.governed.current.asset)!==canonicalJsonString(current))throw new Error('git_governance_required')
        const actor=await requireCurrentWikiPermission({client,grant:input.grant,targetInstallationId:input.targetInstallationId,permission:'publish'})
        await assertImportApproval(client,input.governed,actor.membership_id)
        if(current.immutable.installationId!==input.targetInstallationId||current.immutable.ownerScopeKind!==actor.owner_scope_kind
          ||current.immutable.ownerScopeId!==actor.owner_scope_id||!Number.isSafeInteger(Number(current.baseRevision)))throw new WikiPublicationError('revision_conflict')
        const [fresh]=await readGitAssets(client,{...input.sourceContext,grant:input.grant},[current.key]);fresh.path=current.path
        if(canonicalJsonString(fresh)!==canonicalJsonString(current))throw new WikiPublicationError('source_missing')
        const h=(await client.query(`SELECT h.active_version_id,h.revision::text,w.state,w.generation::text FROM memory_wiki_heads h JOIN memory_wikis w USING(installation_id,wiki_id)
          WHERE h.installation_id=$1 AND h.wiki_id=$2 FOR UPDATE OF h,w`,[input.targetInstallationId,current.key.id])).rows[0]
        if(!h||h.state!=='active'||h.active_version_id!==current.baseVersionId||h.revision!==current.baseRevision||h.generation!==current.serverOnly.generation)throw new WikiPublicationError('revision_conflict')
        const revision=Number(current.baseRevision)+1
        await client.query("UPDATE memory_wiki_versions SET state='revoked' WHERE installation_id=$1 AND wiki_version_id=$2",[input.targetInstallationId,current.baseVersionId])
        await client.query('UPDATE memory_wiki_heads SET active_version_id=NULL,revision=revision+1,updated_at=NOW() WHERE installation_id=$1 AND wiki_id=$2',[input.targetInstallationId,current.key.id])
        await client.query("UPDATE memory_wikis SET state='revoked',generation=generation+1,updated_at=NOW() WHERE installation_id=$1 AND wiki_id=$2",[input.targetInstallationId,current.key.id])
        await client.query('COMMIT');return {wikiVersionId:current.baseVersionId,revision}
      }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    },
    /** Publish an independently governed same-Scope whole-page revision. Exact
     * source projection is shared with export; never forge a generator run.
     * All generated provenance stays attached to its original published build. */
    async publishRevision(input:{grant:ValidatedV2Grant;targetInstallationId:string;current:WikiAsset;proposed:WikiAsset;sourceContext:GitReaderInput;governed:GovernedImport}):Promise<{wikiVersionId:string;revision:number}> {
      const current=WikiAssetSchema.parse(input.current),proposed=WikiAssetSchema.parse(input.proposed)
      if(!Number.isSafeInteger(Number(current.baseRevision))||Number(current.baseRevision)>=Number.MAX_SAFE_INTEGER
        ||!Number.isSafeInteger(Number(current.serverOnly.generation)))throw new WikiPublicationError('revision_conflict')
      const client=await pool.connect()
      try {
        await client.query('BEGIN')
        await assertImportApproval(client,input.governed)
        const approved=input.governed.proposal.proposed_document.result
        if(approved.kind==='conflict'||canonicalJsonString(input.governed.current.asset)!==canonicalJsonString(current)
          ||canonicalJsonString(approved.asset.asset)!==canonicalJsonString(proposed))throw new Error('git_governance_required')
        const actor=await requireCurrentWikiPermission({client,grant:input.grant,targetInstallationId:input.targetInstallationId,permission:'publish'})
        await assertImportApproval(client,input.governed,actor.membership_id)
        if(input.sourceContext.connection.installationId!==input.targetInstallationId||current.immutable.installationId!==input.targetInstallationId
          ||current.immutable.ownerScopeKind!==actor.owner_scope_kind||current.immutable.ownerScopeId!==actor.owner_scope_id
          ||canonicalJsonString({...proposed,editable:current.editable,path:current.path})!==canonicalJsonString(current))throw new WikiPublicationError('candidate_invalid')
        const [fresh]=await readGitAssets(client,{...input.sourceContext,grant:input.grant},[current.key])
        fresh.path=current.path
        if(canonicalJsonString(fresh)!==canonicalJsonString(current))throw new WikiPublicationError('source_missing')
        const head=(await client.query('SELECT active_version_id,revision::text FROM memory_wiki_heads WHERE installation_id=$1 AND wiki_id=$2 FOR UPDATE',[input.targetInstallationId,current.key.id])).rows[0]
        if(!head||head.active_version_id!==current.baseVersionId||head.revision!==current.baseRevision)throw new WikiPublicationError('revision_conflict')
        const authorities=new Map<string,string>(),manual=createWikiManualService(createTransactionBoundPool(client))
        for(const [pi,page] of proposed.editable.pages.entries())for(const [si,section] of page.sections.entries()) {
          const original=current.editable.pages[pi].sections[si],meta=current.immutable.pages[pi].sections[si]
          const changed=canonicalJsonString(original)!==canonicalJsonString(section)
          if(changed&&meta.authority==='locked')throw new WikiPublicationError('state_conflict')
          authorities.set(section.sectionId,changed?'manual':meta.authority)
          if(changed) {
            if(!Number.isSafeInteger(Number(meta.lockVersion))||Number(meta.lockVersion)>=Number.MAX_SAFE_INTEGER)throw new WikiPublicationError('revision_conflict')
            await manual.appendGoverned({grant:input.grant,targetInstallationId:input.targetInstallationId,wikiId:current.key.id,
              sectionKey:section.sectionKey,expectedLockVersion:Number(meta.lockVersion),markdown:section.markdown,reasonCode:'git_governed_revision'},original.sectionKey)
          }
        }
        const wikiVersionId=randomUUID(),revision=Number(current.baseRevision)+1
        const contentHash=createHash('sha256').update(canonicalJsonString({editable:proposed.editable,sourceVersionId:current.baseVersionId})).digest('hex')
        await client.query("UPDATE memory_wiki_versions SET state='superseded' WHERE installation_id=$1 AND wiki_version_id=$2 AND state='active'",[input.targetInstallationId,current.baseVersionId])
        await client.query(`INSERT INTO memory_wiki_versions(wiki_version_id,installation_id,wiki_id,revision,source_snapshot_id,graph_version_id,build_run_id,state,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8)`,[wikiVersionId,input.targetInstallationId,current.key.id,revision,current.serverOnly.sourceSnapshotId,
          current.serverOnly.graphVersionId,current.serverOnly.buildRunId,contentHash])
        for(const [pi,page] of proposed.editable.pages.entries()) {
          const meta=current.immutable.pages[pi]
          await client.query('INSERT INTO memory_wiki_pages(wiki_version_id,installation_id,page_id,page_key,title,position) VALUES($1,$2,$3,$4,$5,$6)',
            [wikiVersionId,input.targetInstallationId,page.pageId,meta.pageKey,page.title,meta.position])
          for(const [si,section] of page.sections.entries()) {
            await client.query(`INSERT INTO memory_wiki_sections(wiki_version_id,installation_id,section_id,page_id,section_key,heading,markdown,authority,coverage,position)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[wikiVersionId,input.targetInstallationId,section.sectionId,page.pageId,section.sectionKey,section.heading,
              section.markdown,authorities.get(section.sectionId),section.coverage,meta.sections[si].position])
          }
        }
        await client.query(`INSERT INTO memory_wiki_source_bindings(wiki_version_id,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha,created_at)
          SELECT $1,installation_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha,created_at
          FROM memory_wiki_source_bindings WHERE installation_id=$2 AND wiki_version_id=$3`,[wikiVersionId,input.targetInstallationId,current.baseVersionId])
        const switched=await client.query(`UPDATE memory_wiki_heads SET active_version_id=$3,revision=$4,updated_at=NOW()
          WHERE installation_id=$1 AND wiki_id=$2 AND revision=$5`,[input.targetInstallationId,current.key.id,wikiVersionId,revision,current.baseRevision])
        if(switched.rowCount!==1)throw new WikiPublicationError('revision_conflict')
        await client.query(`INSERT INTO memory_wiki_audit_events(audit_id,installation_id,wiki_id,action,result,old_content_hash,new_content_hash,actor_scope_kind,actor_scope_id,head_revision)
          VALUES($1,$2,$3,'publish','success',$4,$5,$6,$7,$8)`,[randomUUID(),input.targetInstallationId,current.key.id,current.serverOnly.contentHash,contentHash,actor.owner_scope_kind,actor.owner_scope_id,revision])
        await client.query('COMMIT');return {wikiVersionId,revision}
      }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
    },
    async publish(input: PublishInput): Promise<{ wikiVersionId: string; revision: number }> {
      if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1
        || !Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0) {
        throw new WikiPublicationError('revision_conflict')
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const binding = await requireCurrentWikiPermission({
          client, grant: input.grant, targetInstallationId: input.targetInstallationId,
          permission: 'publish',
        })
        const buildResult = await client.query<{
          repository_id: string
          generation: string
          current_generation: string
          source_snapshot_id: string
          graph_version_id: string
          state: string
          commit_sha: string
          graph_coverage: WikiCoverage
          graph_state: string
          snapshot_state: string
          active_graph_version_id: string | null
          repository_tombstoned: boolean
          snapshot_tombstoned: boolean
          document: WikiCandidateDocumentV1
          candidate_hash: string
        }>(`
          SELECT w.repository_id::text, r.generation::text,
                 w.generation::text AS current_generation,
                 r.source_snapshot_id::text, r.graph_version_id::text, r.state,
                 s.commit_sha, g.coverage AS graph_coverage,
                 g.state AS graph_state, s.state AS snapshot_state,
                 gh.active_graph_version_id::text,
                 EXISTS (
                   SELECT 1 FROM memory_repository_tombstones rt
                   WHERE rt.installation_id = r.installation_id
                     AND rt.repository_id = w.repository_id
                 ) AS repository_tombstoned,
                 EXISTS (
                   SELECT 1 FROM memory_source_snapshot_tombstones st
                   WHERE st.installation_id = r.installation_id
                     AND st.snapshot_id = r.source_snapshot_id
                 ) AS snapshot_tombstoned,
                 c.document, c.content_hash AS candidate_hash
          FROM memory_wiki_build_runs r
          JOIN memory_wikis w
            ON w.installation_id = r.installation_id AND w.wiki_id = r.wiki_id
          JOIN memory_wiki_build_candidates c
            ON c.installation_id = r.installation_id AND c.run_id = r.run_id
          JOIN memory_source_snapshots s
            ON s.installation_id = r.installation_id AND s.snapshot_id = r.source_snapshot_id
          JOIN memory_code_graph_versions g
            ON g.installation_id = r.installation_id AND g.graph_version_id = r.graph_version_id
          LEFT JOIN memory_code_graph_heads gh
            ON gh.installation_id = r.installation_id AND gh.repository_id = w.repository_id
          WHERE r.installation_id = $1 AND r.wiki_id = $2 AND r.run_id = $3
          FOR UPDATE OF r, w, c
        `, [input.targetInstallationId, input.wikiId, input.runId])
        const build = buildResult.rows[0]
        if (!build) throw new WikiPublicationError('not_found')
        if (build.state !== 'candidate') throw new WikiPublicationError('state_conflict')
        if (Number(build.generation) !== input.expectedGeneration
          || Number(build.current_generation) !== input.expectedGeneration
          || build.active_graph_version_id !== build.graph_version_id
          || build.graph_state !== 'active' || build.snapshot_state !== 'active') {
          throw new WikiPublicationError('stale_generation')
        }
        if (build.repository_tombstoned || build.snapshot_tombstoned) {
          throw new WikiPublicationError('tombstoned')
        }

        const sourceResult = await client.query<{
          source_token: string
          ordinal: number
          source_kind: WikiBuildSource['sourceKind']
          stable_key: string
          source_ref_id: string
          source_snapshot_id: string
          commit_sha: string
          path: string | null
          content_hash: string
          excerpt: string | null
          graph_source_exists: boolean
        }>(`
          SELECT bs.source_token, bs.ordinal, bs.source_kind, bs.stable_key,
                 bs.source_ref_id::text, bs.source_snapshot_id::text,
                 bs.commit_sha, bs.path, bs.content_hash, bs.excerpt,
                 CASE
                   WHEN bs.source_kind IN ('file','symbol') THEN EXISTS (
                     SELECT 1 FROM memory_code_nodes n
                     WHERE n.installation_id = bs.installation_id
                       AND n.graph_version_id = $3 AND n.node_id = bs.source_ref_id
                       AND n.kind::text = bs.source_kind
                   )
                   WHEN bs.source_kind = 'claim_version' THEN EXISTS (
                     SELECT 1 FROM knowledge_versions v
                     WHERE v.installation_id = bs.installation_id
                       AND v.version_id = bs.source_ref_id
                   )
                   WHEN bs.source_kind = 'evidence' THEN EXISTS (
                     SELECT 1 FROM knowledge_evidence e
                     WHERE e.installation_id = bs.installation_id
                       AND e.evidence_id = bs.source_ref_id
                   )
                   ELSE FALSE
                 END AS graph_source_exists
          FROM memory_wiki_build_sources bs
          WHERE bs.installation_id = $1 AND bs.run_id = $2
          ORDER BY bs.ordinal
          FOR SHARE OF bs
        `, [input.targetInstallationId, input.runId, build.graph_version_id])
        if (sourceResult.rows.length === 0
          || sourceResult.rows.some(row => !row.graph_source_exists)) {
          throw new WikiPublicationError('source_missing')
        }
        const sources: WikiBuildSource[] = sourceResult.rows.map(row => ({
          sourceToken: row.source_token,
          ordinal: row.ordinal,
          sourceKind: row.source_kind,
          stableKey: row.stable_key,
          sourceRefId: row.source_ref_id,
          sourceSnapshotId: row.source_snapshot_id,
          commitSha: row.commit_sha,
          path: row.path,
          contentHash: row.content_hash,
          excerpt: row.excerpt,
        }))
        const verdict = validateWikiCandidate({
          document: build.document,
          sources,
          expectedSnapshotId: build.source_snapshot_id,
          expectedCommitSha: build.commit_sha,
          expectedCoverage: build.graph_coverage,
        })
        if (!verdict.ok || wikiCandidateContentHash(verdict.ok ? verdict.document : build.document)
          !== build.candidate_hash) {
          throw new WikiPublicationError('candidate_invalid')
        }
        const document = verdict.document

        const headResult = await client.query<{
          active_version_id: string
          revision: string
          content_hash: string
        }>(`
          SELECT h.active_version_id::text, h.revision::text, v.content_hash
          FROM memory_wiki_heads h
          JOIN memory_wiki_versions v
            ON v.installation_id = h.installation_id
           AND v.wiki_version_id = h.active_version_id
          WHERE h.installation_id = $1 AND h.repository_id = $2 AND h.wiki_id = $3
          FOR UPDATE OF h
        `, [input.targetInstallationId, build.repository_id, input.wikiId])
        const head = headResult.rows[0]
        const currentRevision = Number(head?.revision ?? 0)
        if (currentRevision !== input.expectedHeadRevision) {
          throw new WikiPublicationError('revision_conflict')
        }
        const overlays = await client.query<{
          section_key: string
          markdown: string
          content_hash: string
          locked: boolean
        }>(`
          SELECT h.section_key, v.markdown, v.content_hash, h.locked
          FROM memory_wiki_manual_section_heads h
          JOIN memory_wiki_manual_section_versions v
            ON v.installation_id = h.installation_id
           AND v.manual_version_id = h.current_version_id
          WHERE h.installation_id = $1 AND h.wiki_id = $2
          ORDER BY h.section_key
          FOR SHARE OF h, v
        `, [input.targetInstallationId, input.wikiId])
        const generatedKeys = new Set(
          document.pages.flatMap(page => page.sections.map(section => section.section_key)),
        )
        if (overlays.rows.some(row => generatedKeys.has(row.section_key))) {
          throw new WikiPublicationError('section_key_collision')
        }

        const wikiVersionId = randomUUID()
        const revision = currentRevision + 1
        const contentHash = createHash('sha256').update(canonicalJsonStringify({
          generated: document,
          overlays: overlays.rows.map(row => ({
            section_key: row.section_key,
            content_hash: row.content_hash,
            locked: row.locked,
          })),
        })).digest('hex')
        if (head) {
          await client.query(`
            UPDATE memory_wiki_versions SET state = 'superseded'
            WHERE installation_id = $1 AND wiki_version_id = $2 AND state = 'active'
          `, [input.targetInstallationId, head.active_version_id])
        }
        await client.query(`
          INSERT INTO memory_wiki_versions
            (wiki_version_id, installation_id, wiki_id, revision, source_snapshot_id,
             graph_version_id, build_run_id, state, content_hash)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        `, [wikiVersionId, input.targetInstallationId, input.wikiId, revision,
          build.source_snapshot_id, build.graph_version_id, input.runId, contentHash])

        const pages = new Map<string, string>()
        for (const [pagePosition, page] of document.pages.entries()) {
          const pageId = randomUUID()
          pages.set(page.page_key, pageId)
          await client.query(`
            INSERT INTO memory_wiki_pages
              (wiki_version_id, installation_id, page_id, page_key, title, position)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [wikiVersionId, input.targetInstallationId, pageId,
            page.page_key, page.title, pagePosition])
          for (const [sectionPosition, section] of page.sections.entries()) {
            const sectionId = randomUUID()
            await client.query(`
              INSERT INTO memory_wiki_sections
                (wiki_version_id, installation_id, section_id, page_id, section_key,
                 heading, markdown, authority, coverage, position)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'generated', $8, $9)
            `, [wikiVersionId, input.targetInstallationId, sectionId, pageId,
              section.section_key, section.heading, section.markdown,
              section.coverage, sectionPosition])
            for (const token of section.source_tokens) {
              const source = sources.find(candidate => candidate.sourceToken === token)!
              await client.query(`
                INSERT INTO memory_wiki_source_bindings
                  (wiki_version_id, installation_id, section_id, binding_id,
                   source_kind, source_token, source_snapshot_id, commit_sha)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              `, [wikiVersionId, input.targetInstallationId, sectionId, randomUUID(),
                source.sourceKind, source.sourceToken, source.sourceSnapshotId,
                source.commitSha])
            }
          }
        }
        const overlayPageId = pages.get('repository-overview') ?? [...pages.values()][0]!
        const basePosition = document.pages
          .find(page => pages.get(page.page_key) === overlayPageId)?.sections.length ?? 0
        for (const [index, overlay] of overlays.rows.entries()) {
          await client.query(`
            INSERT INTO memory_wiki_sections
              (wiki_version_id, installation_id, section_id, page_id, section_key,
               heading, markdown, authority, coverage, position)
            VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'complete', $8)
          `, [wikiVersionId, input.targetInstallationId, randomUUID(), overlayPageId,
            overlay.section_key, overlay.markdown, overlay.locked ? 'locked' : 'manual',
            basePosition + index])
        }

        let switched = 0
        if (head) {
          const result = await client.query(`
            UPDATE memory_wiki_heads
            SET active_version_id = $4, revision = $5, updated_at = NOW()
            WHERE installation_id = $1 AND repository_id = $2 AND wiki_id = $3
              AND revision = $6
          `, [input.targetInstallationId, build.repository_id, input.wikiId,
            wikiVersionId, revision, input.expectedHeadRevision])
          switched = result.rowCount ?? 0
        } else {
          const result = await client.query(`
            INSERT INTO memory_wiki_heads
              (installation_id, repository_id, wiki_id, active_version_id, revision)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (installation_id, repository_id) DO NOTHING
          `, [input.targetInstallationId, build.repository_id, input.wikiId,
            wikiVersionId, revision])
          switched = result.rowCount ?? 0
        }
        if (switched !== 1) throw new WikiPublicationError('revision_conflict')
        await client.query(`
          DELETE FROM memory_wiki_stale_marks
          WHERE installation_id = $1 AND wiki_id = $2
        `, [input.targetInstallationId, input.wikiId])
        await client.query(`
          UPDATE memory_wiki_build_runs
          SET state = 'published', completed_at = NOW()
          WHERE installation_id = $1 AND run_id = $2 AND state = 'candidate'
        `, [input.targetInstallationId, input.runId])
        await client.query(`
          INSERT INTO memory_wiki_audit_events
            (audit_id, installation_id, wiki_id, action, result,
             old_content_hash, new_content_hash, actor_scope_kind, actor_scope_id,
             head_revision)
          VALUES ($1, $2, $3, 'publish', 'success', $4, $5, $6, $7, $8)
        `, [randomUUID(), input.targetInstallationId, input.wikiId,
          head?.content_hash ?? null, contentHash, binding.owner_scope_kind,
          binding.owner_scope_id, revision])
        await client.query('COMMIT')
        options.metrics?.wikiPublications.inc({ result: 'published' })
        return { wikiVersionId, revision }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        const code = error instanceof WikiPublicationError ? error.code
          : error instanceof Error && error.message === 'wiki_forbidden' ? 'forbidden'
            : 'candidate_invalid'
        const result = code === 'forbidden' ? 'unauthorized'
          : code === 'stale_generation' ? 'stale_generation'
            : code === 'revision_conflict' || code === 'state_conflict'
                || code === 'section_key_collision' ? 'conflict'
              : 'rejected'
        options.metrics?.wikiPublications.inc({ result })
        remapError(error)
      } finally {
        client.release()
      }
    },
  }
}
