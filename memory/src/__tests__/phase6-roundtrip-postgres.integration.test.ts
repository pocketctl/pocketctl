import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitSyncWorker } from '../git-sync/worker.js'
import { createGitImportService } from '../git-sync/import-service.js'
import { createJobRepository } from '../jobs/repository.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { createSkillPublicationService } from '../skills/publication-service.js'
import { createLocalGitFixture } from '../testing/phase6-local-git-fixture.js'
import { gitClaimFixture } from '../testing/phase6-db-fixture.js'
import { gitImportFixture } from '../testing/phase6-import-fixture.js'
import { prepareClaimRevision } from '../governance/revision-service.js'
import { lockImportProposal, prepareGovernedImport, requireImportQuorum } from '../git-sync/governance-adapter.js'

const url = process.env.MEMORY_TEST_DATABASE_URL
const db = url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

db('Phase 6 four-kind real local Git engineering roundtrip', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 10 })
    await assertMemoryTestDatabase(pool, url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await applyMemorySchema(pool)
  }, 60_000)
  beforeEach(async () => { await pool.query('TRUNCATE memory_installations,memory_jobs CASCADE') })
  afterAll(async () => { await pool?.end() })

  // Catches lost real-file edits, worker bypass, governance bypass, missing typed
  // domain links, wrong merge identity and accidental Skill publication.
  test('merged file edits traverse worker/current review into four exact domain versions and retry without duplicates', async () => {
    const repo = await createLocalGitFixture()
    try {
      const f = await gitExportFixture(pool)
      // This positive case promises the old Skill Active stays valid. Its Claim
      // is independent of the Skill source; the dependent case below exercises
      // the required source invalidation instead of preserving stale Active.
      const claim = await gitClaimFixture(pool, f)
      await pool.query('UPDATE knowledge_versions SET source_promotion_candidate_id=gen_random_uuid() WHERE version_id=$1', [claim.versionId])
      await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility,locator,source_evidence_hash,contributor_membership_id)
        SELECT gen_random_uuid(),installation_id,$1,episode_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility,locator,source_evidence_hash,contributor_membership_id
        FROM knowledge_evidence WHERE version_id=$2`, [claim.versionId, f.rule.versionId])
      await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
        SELECT gen_random_uuid(),installation_id,$1,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash
        FROM memory_authority_records WHERE version_id=$2`, [claim.versionId, f.rule.versionId])
      f.keys[0] = { kind: 'claim', id: claim.claimId }
      await expect(createSkillPublicationService({ pool, context: f.skill.context, cases: f.skill.cases })
        .execute(f.skill.publisher, { ...f.skill.publishRequest, expectedPublicationRevision: 1 })).rejects.toThrow('product_gate_closed')
      await pool.query('UPDATE memory_wiki_heads SET revision=1 WHERE wiki_id=$1', [f.wiki.wikiId])
      await pool.query('UPDATE memory_wiki_manual_section_heads SET lock_version=1 WHERE wiki_id=$1', [f.wiki.wikiId])
      const author = await f.skill.actor(['contributor', 'reviewer'], ['read', 'contribute', 'review'])
      await pool.query(`INSERT INTO memory_git_actor_mappings(installation_id,connection_id,provider_actor_id,membership_id,membership_revision,authorization_epoch)
        VALUES($1,$2,'synthetic-local-edit-author',$3,1,1)`, [f.installationId, f.connectionId, author.membershipId])
      const deps = { pool, keys: attestationFixture().registry, skill: { context: f.skill.context, cases: f.skill.cases },
        config: loadGitSyncConfig({ MEMORY_GIT_SYNC_MODE: 'shadow' }), scopeMode: async () => 'enabled' as const }
      const bundle = await createGitExportService(deps).export(f.grant, {
        installationId: f.installationId, connectionId: f.connectionId, expectedGeneration: '1',
        baseCommit: repo.baseCommit, purpose: 'external_export', assets: f.keys,
      })
      const merged = await repo.editAndMerge(bundle)
      expect(merged.parents).toHaveLength(2)
      expect(merged.parents[0]).toBe(repo.baseCommit)
      expect(merged.mergeCommit).not.toBe(merged.parents[1])
      expect(await repo.remotes()).toEqual([])
      const capability = repo.readCapability(bundle.exportId, 'synthetic-local-edit-author')
      const subject = { installationId: f.installationId, connectionId: f.connectionId,
        expectedGeneration: '1', exportId: bundle.exportId }
      const inbox = createGitInboxService(deps)
      await inbox.enroll(f.grant, subject)
      const queued = await inbox.receive(subject, { source: 'webhook', eventId: 'local-merged-1', changeNumber: '7' })
      const jobs = createJobRepository(pool)
      async function consume() {
        const [job] = await jobs.claimJobs({ workerId: 'local-roundtrip', limit: 1, leaseMs: 30_000 })
        expect(job).toBeDefined()
        expect(job.job_type).toBe('git_ingest')
        await createGitSyncWorker({ ...deps, reads: { resolve: async () => capability } }).handle(job,
          new AbortController().signal, { fence: { jobId: job.job_id, claimedBy: 'local-roundtrip', claimEpoch: job.claim_epoch } })
      }
      await consume()
      const proposals = (await pool.query(`SELECT proposal_id,proposed_document->'key'->>'kind' asset_kind,state,revision::text,run_id,provider_actor_id
        FROM memory_git_import_proposals ORDER BY asset_kind`)).rows
      expect(proposals.map(p => p.asset_kind)).toEqual(['claim', 'rule', 'skill', 'wiki'])
      for (const p of proposals) expect(p).toMatchObject({ state: 'awaiting_review', revision: '1',
        run_id: queued.runId, provider_actor_id: 'synthetic-local-edit-author' })
      expect((await pool.query('SELECT merge_commit,tree_sha,http_attempts,state FROM memory_git_runs WHERE run_id=$1', [queued.runId])).rows)
        .toEqual([{ merge_commit: merged.mergeCommit, tree_sha: merged.tree, http_attempts: 3, state: 'planned' }])
      const request = (p: typeof proposals[number]) => ({ ...subject, proposalId: p.proposal_id, expectedRevision: p.revision })
      const closed = createGitImportService(deps)
      await expect(closed.apply(f.skill.publisher.grant, request(proposals[0]))).rejects.toThrow('git_feature_disabled')
      await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1", [f.connectionId])
      const imports = createGitImportService({ ...deps, applicationMode: async () => 'enabled' as const })
      await expect(imports.review(author.grant, { ...request(proposals[0]), decision: 'approve' })).rejects.toThrow('git_self_review_denied')
      await expect(imports.apply(f.skill.publisher.grant, request(proposals[0]))).rejects.toThrow('git_quorum_failed')
      const outcomes = new Map<string, Awaited<ReturnType<typeof imports.apply>>>()
      for (const kind of ['skill', 'wiki', 'rule', 'claim']) {
        const p = proposals.find(p => p.asset_kind === kind)!
        await imports.review(f.skill.reviewer.grant, { ...request(p), decision: 'approve' })
        const result = await imports.apply(f.skill.publisher.grant, request(p))
        outcomes.set(kind, result)
        expect(result.outcome).toBe(kind === 'skill' ? 'draft_appended' : 'published')
        expect(await imports.apply(f.skill.publisher.grant, request(p))).toEqual(result)
        if (kind === 'skill') {
          await expect(f.skill.publication.execute(f.skill.publisher, { ...f.skill.publishRequest,
            versionId: result.versionId, expectedRevision: f.skill.reviewed.revision + 1,
            expectedPublicationRevision: 1 })).rejects.toThrow('review_required')
          expect((await pool.query('SELECT count(*)::int n FROM memory_skill_replay_runs WHERE version_id=$1', [result.versionId])).rows[0].n).toBe(0)
        }
      }
      const claims = (await pool.query(`SELECT c.claim_id,v.version_id,v.version_number,v.statement
        FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id
        WHERE c.claim_id=ANY($1::uuid[]) ORDER BY v.statement`, [[f.keys[0].id, f.rule.claimId]])).rows
      expect(claims).toEqual([
        { claim_id: f.keys[0].id, version_id: outcomes.get('claim')!.versionId, version_number: 2, statement: 'Local Git claim revision' },
        { claim_id: f.rule.claimId, version_id: outcomes.get('rule')!.versionId, version_number: 2, statement: 'Local Git rule revision' },
      ])
      for (const kind of ['claim', 'rule']) {
        expect((await pool.query(`SELECT excerpt,visibility,source_evidence_hash,locator FROM knowledge_evidence WHERE version_id=$1`, [outcomes.get(kind)!.versionId])).rows)
          .toEqual([{ excerpt: 'tests passed', visibility: 'shared', source_evidence_hash: 'b'.repeat(64), locator: { privatePath: '/private/source' } }])
      }
      expect((await pool.query('SELECT structured_content,confidence::text,branch,freshness_at FROM knowledge_versions WHERE version_id=$1', [outcomes.get('rule')!.versionId])).rows[0])
        .toEqual({ structured_content: { value: null, flags: ['strict'], retries: 7 }, confidence: '0.8723', branch: 'private-branch', freshness_at: new Date('2026-01-02T03:04:05Z') })
      expect((await pool.query(`SELECT s.markdown,s.authority,v.build_run_id FROM memory_wiki_heads h
        JOIN memory_wiki_versions v ON v.wiki_version_id=h.active_version_id
        JOIN memory_wiki_sections s ON s.wiki_version_id=v.wiki_version_id
        WHERE h.wiki_id=$1 AND s.section_key='generated'`, [f.wiki.wikiId])).rows)
        .toEqual([{ markdown: 'Local Git Wiki paragraph', authority: 'manual', build_run_id: f.runId }])
      expect((await pool.query('SELECT count(*)::int n FROM memory_wiki_source_bindings WHERE wiki_version_id=$1', [outcomes.get('wiki')!.versionId])).rows[0].n).toBe(1)
      expect((await pool.query(`SELECT h.state,h.current_version_id,v.author_id,v.document->>'title' title,p.current_version_id publication
        FROM memory_skill_heads h JOIN memory_skill_versions v ON v.version_id=h.current_version_id
        JOIN memory_skill_publication_heads p ON p.installation_id=h.installation_id AND p.skill_id=h.skill_id WHERE h.skill_id=$1`, [f.skill.reviewed.skillId])).rows)
        .toEqual([{ state: 'draft', current_version_id: outcomes.get('skill')!.versionId, author_id: author.membershipId,
          title: 'Local Git Skill draft', publication: f.skill.reviewed.versionId }])
      const links = (await pool.query(`SELECT l.kind,l.version_id,l.claim_version_id,l.wiki_version_id,l.skill_version_id,l.commit_sha,l.tree_sha,o.outcome
        FROM memory_git_revision_links l JOIN memory_git_import_outcomes o USING(link_id) ORDER BY l.kind`)).rows
      expect(links).toHaveLength(4)
      for (const link of links) {
        expect(link.version_id).toBe(outcomes.get(link.kind)!.versionId)
        expect(link).toMatchObject({ commit_sha: merged.mergeCommit, tree_sha: merged.tree,
          claim_version_id: ['claim', 'rule'].includes(link.kind) ? link.version_id : null,
          wiki_version_id: link.kind === 'wiki' ? link.version_id : null,
          skill_version_id: link.kind === 'skill' ? link.version_id : null })
      }
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_confirmed_bases')).rows[0].n).toBe(4)
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_proposal_runs WHERE run_id=$1', [queued.runId])).rows[0].n).toBe(4)
      // Index jobs are real downstream work, but this fixture runs only the Git
      // consumer. Keep indexing pending so it cannot occupy that consumer claim.
      await pool.query("UPDATE memory_jobs SET available_at=NOW()+interval '1 hour' WHERE job_type='index_shared_claim'")
      await inbox.receive(subject, { source: 'poll', eventId: 'local-poll-same-merge', changeNumber: '8' })
      await consume()
      expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(4)
      expect((await pool.query("SELECT canonical_run_id,eligible,unfinished FROM memory_git_run_receipts WHERE state='duplicate'")).rows)
        .toEqual([{ canonical_run_id: queued.runId, eligible: false, unfinished: false }])
      expect(loadGitSyncConfig({})).toMatchObject({ mode: 'off', writeMode: 'off' })
      expect(() => loadGitSyncConfig({ MEMORY_GIT_WRITE_MODE: 'enabled' })).toThrow()
      console.info('LOCAL_GIT_ROUNDTRIP', JSON.stringify({ kinds: ['claim', 'rule', 'wiki', 'skill'],
        mergeCommit: merged.mergeCommit, tree: merged.tree, parents: merged.parents, links: links.length,
        skillOutcome: 'draft_appended', oldActiveRetained: true, productionGate: 'closed', externalDataPlaneCalls: 0 }))
    } finally { await repo.close() }
  }, 60_000)

  // A Claim head advance legitimately invalidates a dependent Skill archive.
  // The approved Claim must nevertheless commit with exact retained provenance;
  // an FK failure/rollback here is the cross-domain defect found by Task 11.
  test('source-dependent Claim commits its governed version while clearing stale Skill and retaining its exact Git outcome', async () => {
    const s = await gitImportFixture(pool, ['claim', 'skill'])
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1", [s.f.connectionId])
    const imports = createGitImportService({ ...s.deps, applicationMode: async () => 'enabled' as const })
    const { proposals } = await s.plan(s.edit(s.bundle.files, v => { if (v.key?.kind === 'claim') v.editable.statement = 'Revised Skill source Claim' }))
    const p = proposals.find(p => p.key.kind === 'claim')!
    const input = { installationId: s.f.installationId, connectionId: s.f.connectionId, expectedGeneration: '1',
      exportId: s.bundle.exportId, proposalId: p.proposalId, expectedRevision: '1' }
    await imports.review(s.f.skill.reviewer.grant, { ...input, decision: 'approve' })
    const result = await imports.apply(s.f.skill.publisher.grant, input)
    expect(result.outcome).toBe('published')
    expect((await pool.query(`SELECT c.revision::text,v.version_id,v.version_number,v.statement FROM knowledge_claims c
      JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1`, [s.f.keys[0].id])).rows)
      .toEqual([{ revision: '2', version_id: result.versionId, version_number: 2, statement: 'Revised Skill source Claim' }])
    expect((await pool.query('SELECT count(*)::int n FROM memory_skill_versions WHERE skill_id=$1', [s.f.skill.reviewed.skillId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_skill_publication_heads WHERE skill_id=$1', [s.f.skill.reviewed.skillId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT generation::text FROM memory_git_connections WHERE connection_id=$1', [s.f.connectionId])).rows).toEqual([{ generation: '2' }])
    expect((await pool.query(`SELECT proposal_id,export_id,proposal_revision::text,generation::text,commit_sha,link_id,version_id,asset_id,outcome
      FROM memory_git_retained_outcomes WHERE proposal_id=$1`, [p.proposalId])).rows).toEqual([{ proposal_id: p.proposalId,
      export_id: s.bundle.exportId, proposal_revision: '1', generation: '1', commit_sha: s.request.headCommit,
      link_id: result.linkId, version_id: result.versionId, asset_id: s.f.keys[0].id, outcome: 'published' }])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_snapshots')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_proposals')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_claim_authority WHERE version_id=$1', [result.versionId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_evidence WHERE version_id=$1', [result.versionId])).rows[0].n).toBe(1)
    expect(await imports.apply(s.f.skill.publisher.grant, { ...input, expectedGeneration: '2' })).toEqual(result)
    await expect(s.service.plan(s.f.grant, { ...s.request, expectedGeneration: '2' })).rejects.toThrow('git_export_unregistered')
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1', [s.f.keys[0].id])).rows[0].n).toBe(2)
  })

  test.each(['unauthorized', 'author', 'source_clock', 'mode', 'target', 'target_id', 'credential_ref', 'write_mode', 'generation'] as const)('source-dependent Claim %s fence rolls back version, Skill invalidation and retained outcome', async failure => {
    const s = await gitImportFixture(pool, ['claim', 'skill'])
    await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1", [s.f.connectionId])
    const imports = createGitImportService({ ...s.deps, applicationMode: async () => 'enabled' as const })
    const { proposals } = await s.plan(s.edit(s.bundle.files, v => { if (v.key?.kind === 'claim') v.editable.statement = 'Must roll back' }))
    const p = proposals.find(p => p.key.kind === 'claim')!
    const input = { installationId: s.f.installationId, connectionId: s.f.connectionId, expectedGeneration: '1',
      exportId: s.bundle.exportId, proposalId: p.proposalId, expectedRevision: '1' }
    await imports.review(s.f.skill.reviewer.grant, { ...input, decision: 'approve' })
    if (failure !== 'unauthorized') {
      const sql = failure === 'author'
        ? `UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id='${s.originalAuthor.membershipId}'`
        : failure === 'source_clock' ? `UPDATE knowledge_versions SET valid_until=clock_timestamp()-interval '1 second' WHERE version_id='${s.bundle.assets.find(a => a.asset.key.kind === 'claim')!.asset.baseVersionId}'`
        : failure === 'mode' ? `UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id='${s.f.connectionId}'`
        : failure === 'target' ? `UPDATE memory_git_connections SET target_branch='unexpected' WHERE connection_id='${s.f.connectionId}'`
        : failure === 'target_id' ? `UPDATE memory_git_connections SET target_id='unexpected' WHERE connection_id='${s.f.connectionId}'`
        : failure === 'credential_ref' ? `UPDATE memory_git_connections SET credential_ref='unexpected' WHERE connection_id='${s.f.connectionId}'`
        : failure === 'write_mode' ? `UPDATE memory_git_connections SET write_mode='shadow' WHERE connection_id='${s.f.connectionId}'`
        : `UPDATE memory_git_connections SET generation=generation+1 WHERE connection_id='${s.f.connectionId}'`
      await pool.query(`CREATE FUNCTION fixture_claim_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${sql}; RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER z_fixture_claim_activation_failure AFTER UPDATE OF current_version_id ON knowledge_claims
        FOR EACH ROW WHEN (NEW.current_version_id IS DISTINCT FROM OLD.current_version_id) EXECUTE FUNCTION fixture_claim_activation_failure()`)
    }
    try {
      await expect(imports.apply(failure === 'unauthorized' ? s.f.skill.reader.grant : s.f.skill.publisher.grant, input)).rejects.toThrow(
        failure === 'unauthorized' ? 'git_forbidden' : failure === 'author' ? 'git_authorization_stale' : failure === 'generation' ? 'git_generation_conflict' : 'git_source_stale')
    } finally {
      if (failure !== 'unauthorized') await pool.query('DROP TRIGGER z_fixture_claim_activation_failure ON knowledge_claims; DROP FUNCTION fixture_claim_activation_failure()')
    }
    expect((await pool.query('SELECT revision::text FROM knowledge_claims WHERE claim_id=$1', [s.f.keys[0].id])).rows).toEqual([{ revision: '1' }])
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1', [s.f.keys[0].id])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT state,current_version_id FROM memory_skill_publication_heads WHERE skill_id=$1', [s.f.skill.reviewed.skillId])).rows)
      .toEqual([{ state: 'active', current_version_id: s.f.skill.reviewed.versionId }])
    expect((await pool.query('SELECT generation::text,target_branch,sync_mode FROM memory_git_connections WHERE connection_id=$1', [s.f.connectionId])).rows)
      .toEqual([{ generation: '1', target_branch: 'main', sync_mode: 'enabled' }])
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_retained_outcomes')).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM memory_git_import_outcomes')).rows[0].n).toBe(0)
  })

  test.each(['forged', 'reused', 'cross_transaction'] as const)('Claim activation rejects %s capability without another domain head change', async mode => {
    const s = await gitImportFixture(pool, ['rule'])
    const { proposals: [p] } = await s.plan()
    const imports = createGitImportService({ ...s.deps, applicationMode: async () => 'enabled' as const })
    const subject = { installationId: s.f.installationId, connectionId: s.f.connectionId, expectedGeneration: '1', exportId: s.bundle.exportId }
    const input = { ...subject, proposalId: p.proposalId, expectedRevision: '1' }
    await imports.review(s.f.skill.reviewer.grant, { ...input, decision: 'approve' })
    let escaped: (() => Promise<void>) | undefined
    await expect(createGitExportService(s.deps).withApplyBase(s.f.skill.publisher.grant, subject, async context => {
      const row = await lockImportProposal(context, input)
      const governed = await prepareGovernedImport(context, row, true)
      await requireImportQuorum(context, governed)
      if (mode === 'forged') {
        await expect(prepareClaimRevision(context.client, { grant: s.f.skill.publisher.grant,
          installationId: s.f.installationId, governed: structuredClone(governed) })).rejects.toThrow('git_governance_required')
      } else {
        const prepared = await prepareClaimRevision(context.client, { grant: s.f.skill.publisher.grant, installationId: s.f.installationId, governed })
        if (mode === 'reused') {
          await prepared.activate()
          await expect(prepared.activate()).rejects.toThrow('git_governance_required')
          expect((await context.client.query('SELECT revision::text FROM knowledge_claims WHERE claim_id=$1', [s.f.rule.claimId])).rows[0].revision).toBe('2')
        } else escaped = prepared.activate
      }
      throw new Error('fixture_rollback_prepared_revision')
    })).rejects.toThrow('fixture_rollback_prepared_revision')
    if (escaped) await expect(escaped()).rejects.toThrow('git_governance_required')
    expect((await pool.query('SELECT revision::text FROM knowledge_claims WHERE claim_id=$1', [s.f.rule.claimId])).rows[0].revision).toBe('1')
    expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1', [s.f.rule.claimId])).rows[0].n).toBe(1)
  })
})
