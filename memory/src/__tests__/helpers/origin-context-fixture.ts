import type pg from 'pg'
import {createContextCompiler} from '../../context/compiler.js'
import {createAdmissionService} from '../../context/admission-service.js'
import {createContextRetrieval} from '../../context/retrieval.js'
import {createScopeResolver} from '../../context/scope-resolver.js'
import {createLoadoutRepository} from '../../context/loadout-repository.js'
import {createContextSettingsRepository} from '../../context/settings-repository.js'
import {createPackRepository,type PackAuthorityGrant} from '../../context/pack-repository.js'
import {createGenerationRunRepository} from '../../generation/repository.js'
import {createPolicyRepository} from '../../policies/repository.js'
import {createPolicyResolver} from '../../policies/resolver.js'
import {createSearchService} from '../../retrieval/search-service.js'
import {createTrajectoryRepository} from '../../context/trajectory-repository.js'
export async function originContextFixture(pool:pg.Pool,installationId:string,options:{authorityGrant?:PackAuthorityGrant;sceneId?:string;query?:string}={}){
 const sessionId='origin-context-session',clientRequestId='origin-context-request'
 await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installationId,sessionId])
 const settings=createContextSettingsRepository(pool)
 await settings.upsert({installationId,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
 const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-context'})
 const lifecycleMode=options.sceneId?'enabled' as const:undefined
 const compiler=createContextCompiler({pool,lifecycleMode,retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings,packs:createPackRepository(pool),generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
 const admission=createAdmissionService({pool,lifecycleMode,nonceHmacKey:Buffer.alloc(32,7)})
 const claim=(await pool.query('SELECT claim_id::text,current_version_id::text,owner_scope_id::text FROM knowledge_claims WHERE installation_id=$1 ORDER BY claim_id LIMIT 1',[installationId])).rows[0]
 const selectedScopeGrant=options.authorityGrant&&'scopeBindings' in options.authorityGrant?options.authorityGrant:undefined
 const compile=(requestId=clientRequestId)=>compiler.compile({installationId,sessionId,clientRequestId:requestId,agent:'codex',authorityGrant:options.authorityGrant,selectedScopeGrant,adapterCapability:'native_hidden_v1',sceneId:options.sceneId,query:options.query??'Transactional fixture',selectedReferences:options.sceneId?[]:[{source_kind:'memory_claim',source_id:claim.claim_id,source_version:claim.current_version_id,owner_scope_id:claim.owner_scope_id,installation_id:installationId}],requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)}})
 const admit=(packId:string,requestId=clientRequestId)=>admission.admit({installationId,sessionId,clientRequestId:requestId,packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',authorityGrant:options.authorityGrant,sharedGrantAuthorized:true,selectedScopeGrant})
 const consume=(packId:string,injectionId:string,nonce:string)=>admission.consume({installationId,sessionId,packId,injectionId,nonce,authorityGrant:options.authorityGrant,selectedScopeGrant})
 return{compiler,admission,compile,admit,consume,sessionId}
}
