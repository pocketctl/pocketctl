import type {FastifyInstance} from 'fastify'
import type {TeamInteractionService} from './interaction-service.js'
import {TeamRepositoryError} from './repository.js'
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function registerTeamInteractionRoutes(app:FastifyInstance,deps:{service:TeamInteractionService;enabled:()=>boolean;verifyAccessToken:(token:string)=>Promise<{userId:number}|null>}){
 for(const action of [false,true])app[action?'post':'get'](`/api/team/sessions/:sessionId/interactions${action?'/:itemId/actions':''}`,async(req,reply)=>{
  reply.header('Cache-Control','no-store, private')
  const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):''
  const actor=token?await deps.verifyAccessToken(token):null
  if(!actor)return reply.code(401).send({error:{code:'invalid_token',message:'Authorization required',retryable:false}})
  if(!deps.enabled())return reply.code(503).send({error:{code:'team_feature_disabled',message:'Team private interactions unavailable',retryable:true}})
  const params=req.params as {sessionId:string;itemId?:string}
  try{
   if(!action)return await deps.service.list(params.sessionId,actor.userId)
   const b=req.body as any,key=req.headers['idempotency-key']
   if(!params.itemId||!uuid.test(params.itemId)||typeof key!=='string'||!uuid.test(key)||!b||!Number.isSafeInteger(b.expected_revision)||!['once','reject'].includes(b.action_id)||['owner_user_id','actor_user_id','user_id'].some(k=>k in b)) return reply.code(400).send({error:{code:'invalid_request',message:'Invalid interaction action',retryable:false}})
   const result=await deps.service.submit({sessionId:params.sessionId,userId:actor.userId,itemId:params.itemId,idempotencyKey:key,expectedRevision:b.expected_revision,action:b.action_id})
   reply.code(result.outcome==='error'?409:result.outcome==='resolved_elsewhere'?200:202);return result
  }catch(e){if(!(e instanceof TeamRepositoryError))throw e;reply.code(e.code==='team_access_denied'?403:404);return {error:{code:e.code,message:'Interaction unavailable',retryable:false}}}
 })
}
