import type {FastifyInstance,FastifyRequest} from 'fastify'
import type {TeamTemplateService} from './template-service.js'
import {TeamRepositoryError} from './repository.js'
export function registerTeamTemplateRoutes(app:FastifyInstance,deps:{service:TeamTemplateService;verifyAccessToken(token:string):Promise<{userId:number}|null>;getDatabaseReady():boolean}){
 const route=(run:(req:FastifyRequest,actor:number,p:Record<string,string>)=>Promise<unknown>)=>async(req:FastifyRequest,reply:any)=>{
  reply.header('Cache-Control','no-store')
  const actor=req.headers.authorization?.startsWith('Bearer ')?await deps.verifyAccessToken(req.headers.authorization.slice(7).trim()):null
  if(!actor)return reply.code(401).send({error:{code:'authorization_required'}})
  if(!deps.getDatabaseReady())return reply.code(503).send({error:{code:'database_unavailable'}})
  try{const p=req.params as Record<string,string>;if(Object.values(p).some(v=>!v||v.length>128))throw new TeamRepositoryError('invalid_request','invalid resource ID');return await run(req,actor.userId,p)}catch(e){if(!(e instanceof TeamRepositoryError))throw e;return reply.code(e.code==='invalid_request'?400:e.code==='team_not_found'?404:['team_access_denied','reviewer_required','participant_required','creator_required'].includes(e.code)?403:e.code==='team_feature_disabled'?503:409).send({error:{code:e.code,message:e.message,...e.currentRevision!==undefined?{current_revision:e.currentRevision}:{}}})}
 }
 const query=(req:FastifyRequest,keys:string[])=>{const q=req.query as Record<string,string>;if(Object.keys(q).some(k=>!keys.includes(k))||Object.values(q).some(v=>typeof v!=='string'))throw new TeamRepositoryError('invalid_request','invalid template query');return q}
 const base='/api/teams/:teamId/templates'
 app.get(base,route((r,a,p)=>deps.service.list(p.teamId,a,query(r,['after']).after)))
 app.get(`${base}/:templateId`,route((r,a,p)=>{const q=query(r,['revision']);if(q.revision!==undefined&&!/^[1-9]\d*$/.test(q.revision))throw new TeamRepositoryError('invalid_request','invalid template revision');return deps.service.get(p.teamId,p.templateId,a,q.revision===undefined?undefined:Number(q.revision))}))
 app.post(`${base}/:templateId`,{bodyLimit:132*1024},route((r,a,p)=>{query(r,[]);return deps.service.save(p.teamId,p.templateId,a,r.body as any)}))
 app.post('/api/teams/:teamId/template-tasks',{bodyLimit:64*1024},route((r,a,p)=>{query(r,[]);return deps.service.createTask(p.teamId,a,r.body as any)}))
 app.get('/api/teams/:teamId/template-tasks/receipt-lookup/:requestId',route((r,a,p)=>{query(r,[]);return deps.service.lookup(p.teamId,a,p.requestId)}))
 app.get(`${base}/:templateId/receipt-lookup/:requestId`,route((r,a,p)=>{query(r,[]);return deps.service.lookup(p.teamId,a,p.requestId,p.templateId)}))
 app.get('/api/teams/:teamId/tasks/:taskId/template-source',route((r,a,p)=>{query(r,[]);return deps.service.taskSource(p.teamId,p.taskId,a)}))
}
