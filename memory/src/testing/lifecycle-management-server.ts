/** Disposable local UI acceptance server. Synthetic Relay authorization only;
 * business reads/writes use actual management services and isolated PostgreSQL. */
import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {assertMemoryTestDatabase} from './test-db.js'
import {applyMemorySchema} from '../schema.js'
import {lifecyclePipelineFixture} from './lifecycle-pipeline-fixture.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {registerReadRoutes} from '../api/read-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {GrantGuard} from '../auth/grant-guard.js'
if(process.env.MEMORY_LIFECYCLE_UI_TEST!=='1')throw Error('explicit disposable UI test opt-in required')
const url=process.env.MEMORY_TEST_DATABASE_URL!
const pool=new pg.Pool({connectionString:url,max:5})
await assertMemoryTestDatabase(pool,url);await applyMemorySchema(pool)
const pipeline=lifecyclePipelineFixture(pool),f=await pipeline.fixture(),a=Fastify(),origin='http://127.0.0.1:19431'
const headers={authorization:'Bearer local-lifecycle-fixture','idempotency-key':randomUUID()}
registerManageRoutes(a,{pool,lifecycleMode:'enabled',guard:{guard:async({authorization})=>{if(authorization!==headers.authorization)throw Error('fixture grant required');return{installationId:f.personal,callerType:'web',configVersion:'1',expiresAt:Date.now()/1000+600}}} as GrantGuard,
 policy:createCorsHostPolicy({allowedHosts:['127.0.0.1:19432','localhost'],allowedOrigins:[origin],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[{version:'ui-fixture',key:'disposable-local-lifecycle-ui-fixture-key'.repeat(3)}]})
const readGrant=async({authorization}:{authorization?:string})=>{if(authorization!==headers.authorization)throw Error('fixture grant required');return{version:'v2' as const,installationId:f.personal,primaryInstallationId:f.personal,callerType:'web',configVersion:'1',expiresAt:Date.now()/1000+600,scopeBindings:[{installation_id:f.personal,owner_scope_kind:'personal' as const,owner_scope_id:f.personal,membership_id:null,membership_revision:'0',authorization_epoch:'1',permissions:['read']}]}}
registerReadRoutes(a,{pool,lifecycleMode:'enabled',guard:{guard:readGrant,guardV2:readGrant,guardMcp:readGrant} as unknown as GrantGuard,policy:createCorsHostPolicy({allowedHosts:['127.0.0.1:19432','localhost'],allowedOrigins:[origin],isProduction:false}),recallEmbeddingTimeoutMs:100,cursorSigningKey:'local-lifecycle-test-cursor-key',sharedScopesEnabled:true})
const installation={installation_id:f.personal,provider_id:'pocketctl-memory',status:'active',config_version:'1',enabled_services:['memory.manage','memory.search'],granted_scopes:[],subscriptions:[]}
a.get('/api/extensions/v1/installations',async()=>({installations:[installation]}))
a.post('/api/extensions/v1/grants',async()=>({grant:'local-lifecycle-fixture',expires_in:600,provider_public_origin:origin}))
a.post('/api/extensions/v2/grants',async()=>({grant:'local-lifecycle-fixture',expires_in:600,provider_public_origin:origin}))
a.addHook('preHandler',async(req,reply)=>{if(req.url.startsWith('/api/v1/')&&req.headers.authorization!==headers.authorization)return reply.code(401).send({error:{code:'unauthorized',message:'fixture grant required'}})})
a.get('/__fixture',async()=>({installationId:f.personal,claimId:f.claim}))
a.post<{Params:{mode:string}}>('/__fixture/policy/:mode',async(req,reply)=>{if(!['off','shadow','enabled'].includes(req.params.mode))return reply.code(400).send({});await pool.query('UPDATE memory_curation_policies SET mode=$2 WHERE installation_id=$1',[f.personal,req.params.mode]);return{mode:req.params.mode}})
await pipeline.ingest(f,'trains');await pipeline.ingest(f,'buses',f.other)
await pool.query("UPDATE memory_spaces SET name='City travel' WHERE installation_id=$1 AND space_id=$2",[f.personal,f.other])
await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode,storage_tier,cold_since) VALUES($1,$2,'constraint','verified','cold',clock_timestamp())",[f.personal,f.claim])
await pool.query(`INSERT INTO memory_task_bundles(installation_id,task_key,session_id,source_digest,watermark,state,reason_code) VALUES($1,'ui-test-task','ui-test-session',decode(repeat('ab',32),'hex'),1,'deferred_semantic','insufficient_evidence')`,[f.personal])
const manual=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers,payload:{statement:'Lifecycle UI fixture: keep task evidence and current versions distinct.',claim_type:'work_method',confirmed:true}})
if(manual.statusCode!==200)throw Error('manual fixture creation failed')
await pool.query("INSERT INTO memory_claim_lifecycle(installation_id,claim_id,kind,assertion_mode) VALUES($1,$2,'method','user_asserted') ON CONFLICT DO NOTHING",[f.personal,manual.json().claim_id])
await a.listen({host:'127.0.0.1',port:19432})
console.log('lifecycle UI fixture listening on loopback 19432; real API/DB, synthetic authorization and source records')
async function shutdown(){await a.close();await pool.query('DELETE FROM knowledge_claims WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.query('DELETE FROM memory_installations WHERE installation_id=ANY($1::uuid[])',[[f.personal,f.team]]);await pool.end();process.exit(0)}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown())
