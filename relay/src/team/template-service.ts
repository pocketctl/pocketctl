import type pg from 'pg'
import {randomUUID} from 'node:crypto'
import {requireTeamAccess} from './access.js'
import {boundedText,positiveRevision,stableDigest} from './delivery-contract.js'
import {createInitialTaskSpec} from './delivery-service.js'
import {TeamPlanService} from './plan-service.js'
import {TeamRepositoryError} from './repository.js'
import {TeamTemplateRepository} from './template-repository.js'
import {bindTemplate,strictObject,validateTemplate,type TeamTemplate,type TemplateBindings} from './template-contract.js'

export class TeamTemplateService {
 private readonly repository=new TeamTemplateRepository()
 constructor(private readonly pool:pg.Pool,private readonly enabled:(team:string)=>boolean=()=>false){}
 private async transaction<T>(run:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');const result=await run(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
 }
 private async access(c:pg.PoolClient,team:string,actor:number,mode:'read'|'create'|'admin'='read'){
  boundedText(team,'team',128);await requireTeamAccess(c,actor,true)
  const current=(await c.query("SELECT 1 FROM collaboration_teams WHERE team_id=$1 AND state='active' FOR SHARE",[team])).rows[0]
  const member=(await c.query("SELECT role FROM collaboration_team_memberships WHERE team_id=$1 AND user_id=$2 AND state='active' FOR SHARE",[team,actor])).rows[0]
  if(!current||!member)throw new TeamRepositoryError('team_not_found','team not found')
  if(mode==='admin'&&member.role!=='admin'||mode==='create'&&member.role==='viewer')throw new TeamRepositoryError('team_access_denied','template operation requires current writable authority')
  return member
 }
 private writable(team:string){if(!this.enabled(team))throw new TeamRepositoryError('team_feature_disabled','templates disabled for team')}
 private async receipt(c:pg.PoolClient,actor:number,operation:string,id:string){return (await c.query('SELECT request_hash,response FROM collaboration_team_idempotency WHERE user_id=$1 AND operation=$2 AND request_id=$3',[actor,operation,id])).rows[0]}
 private async record(c:pg.PoolClient,actor:number,operation:string,id:string,hash:string,response:unknown){await c.query('INSERT INTO collaboration_team_idempotency(user_id,operation,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',[actor,operation,id,hash,JSON.stringify(response)])}
 async list(team:string,actor:number,after=''){
  if(after)boundedText(after,'cursor',128)
  return this.transaction(async c=>{const member=await this.access(c,team,actor);return {team_id:team,writes_enabled:this.enabled(team),can_manage:this.enabled(team)&&member.role==='admin',can_create:this.enabled(team)&&member.role!=='viewer',...await this.repository.list(c,team,after)}})
 }
 async get(team:string,id:string,actor:number,revision?:number){
  boundedText(id,'template ID',128);if(revision!==undefined){positiveRevision(revision);if(revision>100)throw new TeamRepositoryError('invalid_request','template revision exceeds 100')}
  return this.transaction(async c=>{await this.access(c,team,actor);const row=await this.repository.read(c,team,id,revision);if(!row)throw new TeamRepositoryError('team_not_found','template not found');return row})
 }
 async save(team:string,id:string,actor:number,input:{request_id:string;expected_revision:number;definition:TeamTemplate}){
  boundedText(id,'template ID',128);strictObject(input,['request_id','expected_revision','definition']);boundedText(input.request_id,'request',128)
  if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0||input.expected_revision>=100)throw new TeamRepositoryError('invalid_request','invalid template revision')
  validateTemplate(input.definition);const hash=stableDigest(input),operation=`team.template.save:${team}:${id}`
  return this.transaction(async c=>{
   await this.access(c,team,actor,'admin');this.writable(team)
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`team-template:${team}:${id}`])
   const prior=await this.receipt(c,actor,operation,input.request_id)
   if(prior){if(prior.request_hash!==hash)throw new TeamRepositoryError('idempotency_conflict','request content changed');return prior.response}
   const head=await this.repository.read(c,team,id)
   if((head?.revision??0)!==input.expected_revision)throw new TeamRepositoryError('revision_conflict','template version changed',head?.revision??0)
   const revision=input.expected_revision+1,contentHash=stableDigest(input.definition)
   await c.query('INSERT INTO team_template_revisions(team_id,template_id,revision,definition,content_hash,created_by_user_id) VALUES($1,$2,$3,$4::jsonb,$5,$6)',[team,id,revision,JSON.stringify(input.definition),contentHash,actor])
   await c.query('INSERT INTO team_template_heads(team_id,template_id,revision) VALUES($1,$2,$3) ON CONFLICT(team_id,template_id) DO UPDATE SET revision=EXCLUDED.revision',[team,id,revision])
   const response={team_id:team,template_id:id,revision,content_hash:contentHash}
   await this.record(c,actor,operation,input.request_id,hash,response);return response
  })
 }
 async createTask(team:string,actor:number,input:{request_id:string;template_id:string;template_revision:number;team_session_id:string;context_version:number;role_bindings:TemplateBindings;goal?:string;acceptance?:string}){
  strictObject(input,['request_id','template_id','template_revision','team_session_id','context_version','role_bindings','goal','acceptance'])
  for(const key of ['request_id','template_id','team_session_id'] as const)boundedText(input[key],key,128)
  positiveRevision(input.template_revision);if(input.template_revision>100)throw new TeamRepositoryError('invalid_request','template revision exceeds 100')
  if(!Number.isSafeInteger(input.context_version)||input.context_version<0)throw new TeamRepositoryError('invalid_request','invalid Context version')
  if(input.goal!==undefined)boundedText(input.goal,'goal',32000)
  if(input.acceptance!==undefined)boundedText(input.acceptance,'acceptance',16000)
  const operation=`team.template.create-task:${team}`,hash=stableDigest(input)
  return this.transaction(async c=>{
   await this.access(c,team,actor,'create');this.writable(team)
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${operation}:${actor}:${input.request_id}`])
   const session=(await c.query(`SELECT s.* FROM collaboration_sessions s JOIN collaboration_session_participants p USING(team_session_id) WHERE s.team_session_id=$1 AND s.team_id=$2 AND s.state='active' AND p.user_id=$3 AND p.state='active' FOR UPDATE OF s FOR SHARE OF p`,[input.team_session_id,team,actor])).rows[0]
   if(!session)throw new TeamRepositoryError('team_not_found','active shared session not found')
   const prior=await this.receipt(c,actor,operation,input.request_id)
   if(prior){if(prior.request_hash!==hash)throw new TeamRepositoryError('idempotency_conflict','request content changed');await this.readableTask(c,team,prior.response.task_id);return prior.response}
   const template=await this.repository.read(c,team,input.template_id,input.template_revision)
   if(!template)throw new TeamRepositoryError('team_not_found','template version not found')
   const steps=bindTemplate(template.definition,input.role_bindings),primary=steps.find(s=>s.required)!,task=`ctk_${randomUUID()}`
   const goal=input.goal??template.definition.goal,acceptance=input.acceptance??template.definition.acceptance
   await c.query('INSERT INTO team_tasks(task_id,team_id,creator_user_id,title,background) VALUES($1,$2,$3,$4,$5)',[task,team,actor,goal.split('\n')[0].slice(0,240),goal+'\n\n交付与验收：\n'+acceptance])
   await createInitialTaskSpec(c,task,actor,goal,acceptance,primary.review_policy)
   await c.query('INSERT INTO team_task_holders(task_id,user_id) VALUES($1,$2)',[task,actor])
   await c.query('INSERT INTO team_task_template_sources(task_id,team_id,template_id,template_revision,team_session_id,snapshot,content_hash,role_bindings) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',[task,team,input.template_id,input.template_revision,input.team_session_id,JSON.stringify(template.definition),template.content_hash,JSON.stringify(input.role_bindings)])
   const plan=await new TeamPlanService(this.pool,{writesEnabledForTeam:this.enabled}).saveDraftInTransaction(c,task,actor,{request_id:input.request_id,expected_revision:0,team_session_id:input.team_session_id,context_version:input.context_version,spec_revision:1,steps})
   const response={task_id:task,team_id:team,team_session_id:input.team_session_id,template_id:input.template_id,template_revision:input.template_revision,template_hash:template.content_hash,plan_revision:plan.revision,plan_hash:plan.plan_hash,execution_enabled:false,call_ids:[]}
   await this.record(c,actor,operation,input.request_id,hash,response);return response
  })
 }
 private async readableTask(c:pg.PoolClient,team:string,task:string){if(!(await c.query("SELECT 1 FROM team_tasks WHERE task_id=$1 AND team_id=$2 AND state<>'deleted' FOR SHARE",[task,team])).rows[0])throw new TeamRepositoryError('team_not_found','task not found')}
 async taskSource(team:string,task:string,actor:number){
  boundedText(task,'task ID',128)
  return this.transaction(async c=>{await this.access(c,team,actor);await this.readableTask(c,team,task);return {task_id:task,source:(await c.query('SELECT template_id,template_revision,snapshot,content_hash,role_bindings FROM team_task_template_sources WHERE task_id=$1 AND team_id=$2',[task,team])).rows[0]??null}})
 }
 async lookup(team:string,actor:number,request:string,templateId?:string){
  boundedText(request,'request',128);if(templateId)boundedText(templateId,'template ID',128)
  return this.transaction(async c=>{
   await this.access(c,team,actor)
   const operation=templateId?`team.template.save:${team}:${templateId}`:`team.template.create-task:${team}`,prior=await this.receipt(c,actor,operation,request)
   if(prior&&!templateId){await this.readableTask(c,team,prior.response.task_id);if(!(await c.query("SELECT 1 FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2 AND state='active'",[prior.response.team_session_id,actor])).rows[0])throw new TeamRepositoryError('team_not_found','session not found')}
   return {team_id:team,actor_user_id:actor,request_id:request,operation:templateId?'save_template':'create_template_task',found:!!prior,response:prior?.response??null}
  })
 }
}
