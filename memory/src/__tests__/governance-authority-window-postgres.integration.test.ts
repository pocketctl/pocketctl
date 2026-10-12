import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createScopeAuthorization} from '../governance/authorization.js'
import {createSkillPublicationFixture} from '../testing/skill-publication-fixture.js'
import {createSkillPublicationService} from '../skills/publication-service.js'
import {createSkillPolicyService,DEFAULT_SKILL_PUBLICATION_POLICY} from '../skills/policy-service.js'
import {createSkillRolloutService} from '../skills/rollout-service.js'
import {createSkillRollbackService} from '../skills/rollback-service.js'
import {createPublicationService} from '../governance/publication-service.js'
import {requireCurrentWikiPermission} from '../wiki/authorization.js'
import {createReviewPolicyRepository,DEFAULT_ORGANIZATION_REVIEW_POLICY,DEFAULT_TEAM_REVIEW_POLICY,loadEffectiveReviewPolicySnapshot} from '../governance/review-policy.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('time-bound authority and inherited policy fences',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 for(const boundary of ['expired','not_yet_valid'] as const){
  const invalid=async(member:string)=>pool.query(boundary==='expired'?"UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1":"UPDATE memory_scope_memberships SET valid_from=clock_timestamp()+interval '1 hour' WHERE membership_id=$1",[member])
  test(`shared scope validator rejects ${boundary} primary membership`,async()=>{
   const f=await governanceFixture(pool);await invalid(f.publisher)
   expect(await createScopeAuthorization(pool).validateV2Grant(f.grant(f.publisher,['read','publish']))).toBeNull()
  })
  test(`Claim publication rejects ${boundary} stored reviewer approval`,async()=>{
   const f=await governanceFixture(pool),proposal=await f.approved();await invalid(f.reviewer)
   await expect(createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'quorum_failed'})
   expect((await pool.query('SELECT 1 FROM memory_authority_records')).rowCount).toBe(0)
  })
  test(`Wiki authority rejects ${boundary} membership`,async()=>{
   const f=await governanceFixture(pool);await invalid(f.publisher)
   const client=await pool.connect()
   try{await client.query('BEGIN');await expect(requireCurrentWikiPermission({client,grant:f.grant(f.publisher,['read','contribute']),targetInstallationId:f.team,permission:'contribute'})).rejects.toThrow('wiki_forbidden')}finally{await client.query('ROLLBACK');client.release()}
  })
 }
 test('an unused expired secondary binding does not deny a valid primary scope',async()=>{
  const f=await governanceFixture(pool),grant=f.grant(f.publisher,['read','publish'])
  grant.primaryInstallationId=f.personal
  await pool.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[f.publisher])
  const validated=await createScopeAuthorization(pool).validateV2Grant(grant)
  expect(validated!.scopeBindings.map(b=>b.installation_id)).toEqual([f.personal])
 })
 test('scope validation cannot exchange equal-revision memberships between installations',async()=>{
  const f=await governanceFixture(pool),org=randomUUID(),orgMember=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'active',1)",[org,orgMember])
  const grant=f.grant(f.publisher,['read','publish'])
  grant.scopeBindings.find(b=>b.installation_id===f.team)!.membership_id=orgMember
  grant.scopeBindings.push({installation_id:org,owner_scope_kind:'organization',owner_scope_id:org,membership_id:f.publisher,membership_revision:'1',authorization_epoch:'1',permissions:['read','publish']})
  expect(await createScopeAuthorization(pool).validateV2Grant(grant)).toBeNull()
 })
 test('secondary publisher membership expiry while waiting rolls back fresh authority',async()=>{
  const f=await governanceFixture(pool),proposal=await f.approved(),grant=f.grant(f.publisher,['read','publish'])
  grant.primaryInstallationId=f.personal
  const locker=await pool.connect();let pending:Promise<unknown>|undefined
  let reached!:()=>void;const reachedLock=new Promise<void>(resolve=>{reached=resolve})
  const hooked={connect:async()=>{
   const client=await pool.connect()
   return new Proxy(client,{get(target,key){if(key==='query')return (...args:unknown[])=>{
    if(typeof args[0]==='string'&&args[0].includes('FROM memory_promotion_candidates')&&args[0].includes('FOR UPDATE'))reached()
    return Reflect.apply(target.query,target,args)
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  }} as unknown as pg.Pool
  try{
   const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
   await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[f.publisher,deadline])
   await locker.query('BEGIN');await locker.query('SELECT candidate_id FROM memory_promotion_candidates WHERE candidate_id=$1 FOR UPDATE',[proposal.candidate.candidate_id])
   pending=createPublicationService(hooked).publish({grant,targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
   const outcome=pending.then(value=>({value}),error=>({error}));await reachedLock
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);await locker.query('COMMIT')
   expect(await outcome).toMatchObject({error:{code:'forbidden'}})
   expect((await pool.query('SELECT 1 FROM memory_authority_records')).rowCount).toBe(0)
  }finally{await locker.query('ROLLBACK');locker.release();await pending?.catch(()=>undefined)}
 },10000)

 test('rollback failure cleanup cannot disable delivery using a revoked primary installation',async()=>{
  const f=await createSkillPublicationFixture(pool),next=await f.prepareVersion({skillId:f.reviewed.skillId,revision:f.reviewed.revision})
  await f.publication.execute(f.publisher,{...next.subject,expectedPublicationRevision:1,mode:'manual'})
  await pool.query('DELETE FROM memory_skill_versions WHERE installation_id=$1 AND version_id=$2',[f.installationId,f.reviewed.versionId])
  const primary=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[primary])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[primary])
  f.publisher.grant.primaryInstallationId=primary
  f.publisher.grant.scopeBindings.push({installation_id:primary,owner_scope_kind:'personal',owner_scope_id:primary,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']})
  const locker=await pool.connect();let pid:number|undefined,finished=false,pending:Promise<unknown>|undefined
  const hooked={connect:async()=>{const client=await pool.connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  try{
   await locker.query('BEGIN');await locker.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[primary])
   pending=createSkillRollbackService({...f.deps,pool:hooked}).execute(f.publisher,{skillId:next.skillId,targetVersionId:f.reviewed.versionId,expectedRevision:next.revision,expectedPublicationRevision:2})
   const outcome=pending.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(pid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked){blocked=true;break}
    if(finished)break
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   await locker.query('COMMIT')
   expect(await outcome).toMatchObject({error:{code:'not_found'}})
   expect((await pool.query('SELECT state,revision::int FROM memory_skill_publication_heads')).rows).toEqual([{state:'active',revision:2}])
   expect(blocked,'cleanup needs its own current primary authority fence').toBe(true)
  }finally{await locker.query('ROLLBACK');locker.release();await pending?.catch(()=>undefined)}
 },15000)
 async function parentFixture(){
  const f=await governanceFixture(pool),org=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
  await pool.query('UPDATE memory_owner_scopes SET parent_organization_id=$2 WHERE installation_id=$1',[f.team,org])
  await createReviewPolicyRepository(pool).ensurePolicySet(org,DEFAULT_ORGANIZATION_REVIEW_POLICY)
  await createReviewPolicyRepository(pool).ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
  return {...f,org}
 }
 for(const scope of ['team','parent'] as const){
  test(`review refuses a revision after the ${scope} policy head changes`,async()=>{
   const f=await parentFixture(),proposal=await f.proposed(),repo=createReviewPolicyRepository(pool)
   const installationId=scope==='team'?f.team:f.org,head=await repo.getHead(installationId)
   await repo.publishVersion({installationId,document:scope==='team'?DEFAULT_TEAM_REVIEW_POLICY:DEFAULT_ORGANIZATION_REVIEW_POLICY,createdByMembershipId:null,expectedRevision:head!.revision})
   await expect(createPublicationService(pool).decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})).rejects.toMatchObject({code:'policy_head_changed'})
   expect((await pool.query('SELECT 1 FROM memory_review_decisions')).rowCount).toBe(0)
   expect((await pool.query("SELECT 1 FROM memory_governance_events WHERE action='decision_recorded'")).rowCount).toBe(0)
  })
 }
 for(const cause of ['dissolved','revoked','tombstoned'] as const){
  test(`review refuses a revision after its parent is ${cause}`,async()=>{
   const f=await parentFixture(),proposal=await f.proposed()
   if(cause==='dissolved')await pool.query("UPDATE memory_owner_scopes SET state='dissolved' WHERE installation_id=$1",[f.org])
   if(cause==='revoked')await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.org])
   if(cause==='tombstoned')await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'fixture')",[f.org])
   await expect(createPublicationService(pool).decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})).rejects.toMatchObject({code:'forbidden'})
   expect((await pool.query('SELECT 1 FROM memory_review_decisions')).rowCount).toBe(0)
   expect((await pool.query("SELECT 1 FROM memory_governance_events WHERE action='decision_recorded'")).rowCount).toBe(0)
  })
 }
 for(const winner of ['policy','vote'] as const){
  test(`${winner} winning first serializes a concurrent policy update and review without rewriting audit history`,async()=>{
   const f=await parentFixture(),proposal=await f.proposed(),repo=createReviewPolicyRepository(pool),head=await repo.getHead(f.org)
   let reached!:()=>void,release!:()=>void,followerPid:number|undefined
   const firstWrite=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
   const leadingPool={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
    if(key==='query')return async(...args:unknown[])=>{
     const result=await Reflect.apply(target.query,target,args)
     if(typeof args[0]==='string'&&args[0].includes(winner==='policy'?'UPDATE memory_review_policy_heads':'INSERT INTO memory_review_decisions')){reached();await allowed}
     return result
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
   }})}} as unknown as pg.Pool
   const followingPool={connect:async()=>{const client=await pool.connect();followerPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
   const vote=(connectionPool:pg.Pool)=>createPublicationService(connectionPool).decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
   const policy=(connectionPool:pg.Pool)=>createReviewPolicyRepository(connectionPool).publishVersion({installationId:f.org,document:DEFAULT_ORGANIZATION_REVIEW_POLICY,createdByMembershipId:null,expectedRevision:head!.revision})
   const first=winner==='policy'?policy(leadingPool):vote(leadingPool),firstOutcome=first.then(value=>({value}),error=>({error}))
   let following:Promise<unknown>|undefined
   try{
    await Promise.race([firstWrite,firstOutcome.then(result=>{throw new Error('leading transaction exited before write barrier:'+JSON.stringify(result))})])
    following=winner==='policy'?vote(followingPool):policy(followingPool)
    const followingOutcome=following.then(value=>({value}),error=>({error}))
    let blocked=false
    for(let attempt=0;attempt<100;attempt++){
     if(followerPid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[followerPid])).rows[0].blocked){blocked=true;break}
     await new Promise(resolve=>setTimeout(resolve,10))
    }
    expect(blocked,'follower must wait on the current parent policy head').toBe(true)
    release();expect(await firstOutcome).toHaveProperty('value')
    if(winner==='policy'){
     expect(await followingOutcome).toMatchObject({error:{code:'policy_head_changed'}})
     expect((await pool.query('SELECT 1 FROM memory_review_decisions')).rowCount).toBe(0)
     expect((await pool.query("SELECT 1 FROM memory_governance_events WHERE action='decision_recorded'")).rowCount).toBe(0)
    }else{
     expect(await followingOutcome).toHaveProperty('value')
     expect((await pool.query('SELECT 1 FROM memory_review_decisions')).rowCount).toBe(1)
     expect((await pool.query("SELECT 1 FROM memory_governance_events WHERE action='decision_recorded'")).rowCount).toBe(1)
     await expect(createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'policy_head_changed'})
     expect((await pool.query('SELECT 1 FROM memory_review_decisions')).rowCount).toBe(1)
    }
   }finally{release();await first.catch(()=>undefined);await following?.catch(()=>undefined)}
  },10000)
 }
 for(const cause of ['dissolved','revoked','tombstoned'] as const){
  test(`inherited policy refuses an installed ${cause} parent scope`,async()=>{
   const f=await parentFixture()
   if(cause==='dissolved')await pool.query("UPDATE memory_owner_scopes SET state='dissolved' WHERE installation_id=$1",[f.org])
   if(cause==='revoked')await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.org])
   if(cause==='tombstoned')await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'fixture')",[f.org])
   const client=await pool.connect()
   try{await client.query('BEGIN');await expect(loadEffectiveReviewPolicySnapshot(client,f.team)).rejects.toThrow('review_policy_scope_stale')}finally{await client.query('ROLLBACK');client.release()}
  })
 }
 test('existing policy initialization cannot invert the administrative head/set lock order',async()=>{
  const f=await governanceFixture(pool),repo=createReviewPolicyRepository(pool)
  await repo.ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
  const head=await repo.getHead(f.team),locker=await pool.connect(),reader=await pool.connect()
  let pending:Promise<unknown>|undefined;let finished=false
  try{
   const pid=(await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   await locker.query('BEGIN');await locker.query('SET LOCAL lock_timeout=\'1500ms\'')
   await locker.query('SELECT policy_id FROM memory_review_policy_heads WHERE policy_id=$1 FOR UPDATE',[head!.policyId])
   await reader.query('BEGIN')
   pending=loadEffectiveReviewPolicySnapshot(reader,f.team,{ensure:true})
   const result=pending.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   for(let attempt=0;attempt<60;attempt++){
    if((await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked)break
    if(finished)throw new Error('policy reader did not wait for head')
    await new Promise(resolve=>setTimeout(resolve,20))
   }
   // This real FK key-share is the administrative version append. A reader
   // holding an unnecessary FOR UPDATE on the set creates a deadlock here.
   await locker.query('SELECT policy_id FROM memory_review_policy_sets WHERE policy_id=$1 FOR KEY SHARE',[head!.policyId])
   await locker.query('COMMIT');expect(await result).toHaveProperty('value')
  }finally{await locker.query('ROLLBACK');await pending?.catch(()=>undefined);await reader.query('ROLLBACK');locker.release();reader.release()}
 },10000)
 test('stored Claim reviewer expiry after quorum evaluation rolls back all publication writes',async()=>{
  const f=await governanceFixture(pool),proposal=await f.approved()
  let reached!:()=>void,release!:()=>void
  const reachedWrite=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const hooked={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,key){
   if(key==='query')return async(...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes('INSERT INTO memory_authority_records')){reached();await allowed}return Reflect.apply(target.query,target,args)}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})}} as unknown as pg.Pool
  const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
  await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[f.reviewer,deadline])
  const pending=createPublicationService(hooked).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  const outcome=pending.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([reachedWrite,outcome.then(result=>{throw new Error('publication exited before the authority barrier:'+JSON.stringify(result))})])
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);release()
   expect(await outcome).toMatchObject({error:{code:'quorum_failed'}})
   expect((await pool.query('SELECT 1 FROM memory_authority_records')).rowCount).toBe(0)
   expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1',[f.team])).rowCount).toBe(0)
  }finally{release();await pending.catch(()=>undefined)}
 },10000)
 test('Skill publication cannot count a reviewer that expires during case registry validation',async()=>{
  const f=await createSkillPublicationFixture(pool,{publish:false})
  let reached!:()=>void,release!:()=>void
  const reachedRegistry=new Promise<void>(resolve=>{reached=resolve}),allowed=new Promise<void>(resolve=>{release=resolve})
  const cases={loadCases:async(input:Parameters<typeof f.cases.loadCases>[0])=>{reached();await allowed;return f.cases.loadCases(input)}}
  const service=createSkillPublicationService({...f.deps,cases})
  const deadline=Number((await pool.query('SELECT extract(epoch FROM clock_timestamp())::float8 AS now')).rows[0].now)+1
  await pool.query('UPDATE memory_scope_memberships SET valid_until=to_timestamp($2) WHERE membership_id=$1',[f.reviewer.membershipId,deadline])
  const pending=service.execute(f.publisher,f.publishRequest),outcome=pending.then(value=>({value}),error=>({error}))
  try{
   await Promise.race([reachedRegistry,outcome.then(result=>{throw new Error('publication exited before registry barrier:'+JSON.stringify(result))})])
   await pool.query('SELECT pg_sleep(GREATEST(0,$1-extract(epoch FROM clock_timestamp()))::float8)',[deadline+0.02]);release()
   expect(await outcome).toMatchObject({error:{code:'review_required'}})
   expect((await pool.query('SELECT 1 FROM memory_skill_publication_events')).rowCount).toBe(0)
  }finally{release();await pending.catch(()=>undefined)}
 },10000)

 test.each(['publication','policy','rollout'] as const)('Skill %s waits for a primary installation revocation committed before authority admission',async operation=>{
  const f=await createSkillPublicationFixture(pool,{publish:false}),primary=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[primary])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$1)",[primary])
  const identity=operation==='policy'?f.policyAdmin:f.publisher
  identity.grant.primaryInstallationId=primary
  identity.grant.scopeBindings.push({installation_id:primary,owner_scope_kind:'personal',owner_scope_id:primary,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']})
  const policyRevision=operation==='policy'?(await createSkillPolicyService({pool}).getPolicy(identity)).revision:0
  const locker=await pool.connect();let pid:number|undefined,finished=false,pending:Promise<unknown>|undefined
  const hooked={connect:async()=>{const client=await pool.connect();pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;return client}} as unknown as pg.Pool
  try{
   await locker.query('BEGIN');await locker.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[primary])
   pending=operation==='publication'?createSkillPublicationService({...f.deps,pool:hooked}).execute(identity,f.publishRequest)
    :operation==='policy'?createSkillPolicyService({pool:hooked}).execute(identity,{expectedRevision:policyRevision,policy:DEFAULT_SKILL_PUBLICATION_POLICY})
    :createSkillRolloutService({...f.deps,pool:hooked}).configure(identity,{skillId:f.reviewed.skillId,expectedRevision:0,state:'disabled',basisPoints:0})
   const outcome=pending.then(value=>{finished=true;return {value}},error=>{finished=true;return {error}})
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    if(pid&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked){blocked=true;break}
    if(finished)break
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   await locker.query('COMMIT')
   expect(await outcome).toMatchObject({error:{code:'forbidden'}})
   expect(blocked,'source admission must wait for the primary authority transaction').toBe(true)
   const table=operation==='publication'?'memory_skill_publication_events':operation==='policy'?'memory_skill_publication_policy_heads':'memory_skill_rollouts'
   expect((await pool.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0)
  }finally{await locker.query('ROLLBACK');locker.release();await pending?.catch(()=>undefined)}
 },10000)

 test('a parent tombstone without a Memory installation cannot revive the default policy bridge',async()=>{
  const f=await governanceFixture(pool),org=randomUUID()
  await pool.query('UPDATE memory_owner_scopes SET parent_organization_id=$2 WHERE installation_id=$1',[f.team,org])
  await createReviewPolicyRepository(pool).ensurePolicySet(f.team,DEFAULT_TEAM_REVIEW_POLICY)
  await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'fixture')",[org])
  const client=await pool.connect()
  try{await client.query('BEGIN');await expect(loadEffectiveReviewPolicySnapshot(client,f.team)).rejects.toThrow('review_policy_scope_stale')}finally{await client.query('ROLLBACK');client.release()}
 })

})
