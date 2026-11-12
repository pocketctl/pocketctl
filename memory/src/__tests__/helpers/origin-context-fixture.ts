import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { vi } from 'vitest'
import { registerContextRoutes } from '../../api/context-routes.js'
import { registerReadRoutes } from '../../api/read-routes.js'
import { createCorsHostPolicy } from '../../auth/cors-host-policy.js'
import { createGrantGuard } from '../../auth/grant-guard.js'
import { createFeedbackService } from '../../context/feedback-service.js'
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
export async function originContextFixture(pool:pg.Pool,installationId:string,options:{authorityGrant?:PackAuthorityGrant;sceneId?:string;query?:string;repositoryId?:string;commitSha?:string}={}){
 const sessionId='origin-context-session',clientRequestId='origin-context-request'
 await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installationId,sessionId])
 const settings=createContextSettingsRepository(pool)
 await settings.upsert({installationId,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
 const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-context'})
 const lifecycleMode=options.sceneId?'enabled' as const:undefined
 const loadouts=createLoadoutRepository(pool),packs=createPackRepository(pool)
 const compiler=createContextCompiler({pool,lifecycleMode,retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts,settings,packs,generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
 const admission=createAdmissionService({pool,lifecycleMode,nonceHmacKey:Buffer.alloc(32,7)})
 const claim=(await pool.query('SELECT claim_id::text,current_version_id::text,owner_scope_id::text FROM knowledge_claims WHERE installation_id=$1 ORDER BY claim_id LIMIT 1',[installationId])).rows[0]
 const selectedScopeGrant=options.authorityGrant&&'scopeBindings' in options.authorityGrant?options.authorityGrant:undefined
 const compile=(requestId=clientRequestId)=>compiler.compile({installationId,sessionId,clientRequestId:requestId,agent:'codex',authorityGrant:options.authorityGrant,selectedScopeGrant,adapterCapability:'native_hidden_v1',sceneId:options.sceneId,repositoryId:options.repositoryId,commitSha:options.commitSha,query:options.query??'Transactional fixture',selectedReferences:options.sceneId?[]:[{source_kind:'memory_claim',source_id:claim.claim_id,source_version:claim.current_version_id,owner_scope_id:claim.owner_scope_id,installation_id:installationId}],requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)}})
 const admit=(packId:string,requestId=clientRequestId)=>admission.admit({installationId,sessionId,clientRequestId:requestId,packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',authorityGrant:options.authorityGrant,sharedGrantAuthorized:true,selectedScopeGrant})
 const consume=(packId:string,injectionId:string,nonce:string)=>admission.consume({installationId,sessionId,packId,injectionId,nonce,authorityGrant:options.authorityGrant,selectedScopeGrant})
 return{compiler,admission,compile,admit,consume,sessionId,loadouts,settings,packs}
}

export async function contextDeliveryClient(
  pool: pg.Pool,
  context: Awaited<ReturnType<typeof originContextFixture>>,
  installationId: string,
) {
  const relay = 'https://relay.context-fixture.test'
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'context-fixture' }
  const guard = createGrantGuard({
    pool, relayUrl: relay, relayIssuer: relay,
    fetchImpl: async () => Response.json({ keys: [jwk] }),
  })
  await guard.warmSigningKeys()
  const app = Fastify()
  const policy = createCorsHostPolicy({ allowedOrigins: [], allowedHosts: ['127.0.0.1'], isProduction: true })
  registerReadRoutes(app, { pool, guard, policy, recallEmbeddingTimeoutMs: 100, cursorSigningKey: 'origin-context' })
  let beforeConsume: (() => Promise<void>) | undefined
  registerContextRoutes(app, {
    ...context, pool, guard, feedback: createFeedbackService({ pool }), policy,
    admission: { ...context.admission, consume: async input => {
      const before = beforeConsume
      beforeConsume = undefined
      await before?.()
      return context.admission.consume(input)
    } },
    requestKey: { keyId: 'fixture', hmacKey: Buffer.alloc(32, 3) },
  })
  const url = await app.listen({ host: '127.0.0.1', port: 0 })
  const issueGrant = (configVersion = '1', service = 'memory.context') => jwt.sign({
    token_type: 'extension_capability', installation_id: installationId, provider_id: 'pocketctl-memory',
    services: [service], config_version: configVersion,
    ...(service === 'memory.context' ? { caller_type: 'daemon', session_id: context.sessionId } : { caller_type: 'web' }),
  }, keys.privateKey, {
    algorithm: 'RS256', keyid: jwk.kid, issuer: relay, audience: 'pocketctl-memory',
    subject: 'user:1', expiresIn: 120, jwtid: randomUUID(),
  })
  return {
    url: url + '/api/v1/memory/context', issueGrant, close: () => app.close(),
    beforeNextConsume: (action: () => Promise<void>) => { beforeConsume = action },
  }
}

type QueryTiming={statement:string;ms:number}
type PhaseTiming={name:string;ms:number;queries:QueryTiming[]}

/** Measure actual statements, with an optional fixed delay per database response. */
export async function measureContextDelivery(
  run:(phase:<T>(name:string,action:()=>Promise<T>)=>Promise<T>)=>Promise<void>,
  responseDelayMs:number,
):Promise<{ms:number;phases:PhaseTiming[]}>{
  const original=pg.Client.prototype.query as (...args:any[])=>any
  const phases:PhaseTiming[]=[]
  let queries:QueryTiming[]|undefined
  const probe=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:any[]){
    const observed=queries
    if(!observed)return original.apply(this,args)
    const statement=String(typeof args[0]==='string'?args[0]:args[0]?.text??'')
      .replace(/\s+/g,' ').trim().slice(0,110)
    const started=performance.now()
    const record=()=>observed.push({statement,ms:Math.round(performance.now()-started)})
    const callback=args.at(-1)
    if(typeof callback==='function'){
      args[args.length-1]=(...results:unknown[])=>{
        record()
        if(responseDelayMs>0)void delay(responseDelayMs).then(()=>callback(...results))
        else callback(...results)
      }
      return original.apply(this,args)
    }
    return original.apply(this,args).then(async(result:unknown)=>{
      record()
      if(responseDelayMs>0)await delay(responseDelayMs)
      return result
    })
  })
  const started=performance.now()
  try{
    await run(async(name,action)=>{
      const statements:QueryTiming[]=[]
      queries=statements
      const start=performance.now()
      try{return await action()}finally{
        phases.push({name,ms:Math.round(performance.now()-start),queries:statements})
        queries=undefined
      }
    })
  }finally{probe.mockRestore()}
  return{ms:Math.round(performance.now()-started),phases}
}
