import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { attestationFixture } from '../testing/phase6-attestation-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitProposalService } from '../git-sync/proposal-service.js'
import { changeMetadata } from '../testing/phase6-fixtures.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
db('Phase 6 immutable governed import provenance',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!)
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  test('a material resolution durably records its own author separately from the requester',async()=>{
    const f=await gitExportFixture(pool),deps={pool,keys:attestationFixture().registry,skill:{context:f.skill.context,cases:f.skill.cases}}
    const bundle=await createGitExportService(deps).export(f.grant,{installationId:f.installationId,connectionId:f.connectionId,
      expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export',assets:[{kind:'rule',id:f.rule.claimId}]})
    const service=createGitProposalService(deps),files=bundle.files.map(file=>file.path.endsWith('/manifest.yaml')?file:
      changeMetadata([file],v=>{if(v.key)v.editable.statement='Git-authored edit'})[0])
    const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',exportId:bundle.exportId,headCommit:'b'.repeat(40),files}
    const [proposal]=await service.plan(f.grant,request)
    const resolver=await f.skill.actor(['scope_administrator'],['read','contribute','review','publish'])
    await service.resolve(resolver.grant,{...request,proposalId:proposal.proposalId,expectedRevision:'1',expectedInputs:proposal.inputs,
      resolution:{path:bundle.assets[0].asset.path,deleted:false,editable:{...bundle.assets[0].asset.editable,statement:'Resolver-authored edit'}}})
    // Removing the resolution append must lose this immutable actor even though
    // the mutable proposal requester still changes successfully.
    const exists=(await pool.query("SELECT to_regclass('memory_git_resolution_authors') AS name")).rows[0].name
    const rows=exists?(await pool.query('SELECT proposal_revision::text,resolver_membership_id FROM memory_git_resolution_authors WHERE proposal_id=$1',[proposal.proposalId])).rows:[]
    expect(rows).toEqual([{proposal_revision:'2',resolver_membership_id:resolver.membershipId}])
  })
})
