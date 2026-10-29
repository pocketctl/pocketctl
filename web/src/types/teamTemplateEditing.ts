import {templateHash,validTemplate,validTemplateVersion,type TeamTemplate,type TemplateVersion} from './teamTemplate'
export interface TemplateSaveInput {request_id:string;expected_revision:number;definition:TeamTemplate}
export interface TemplateSaveOperation {team:string;template:string;actor:number;input:TemplateSaveInput}
export interface TemplateSaveResult {team_id:string;template_id:string;revision:number;content_hash:string}
export interface TemplateSaveReceipt {team_id:string;actor_user_id:number;request_id:string;operation:'save_template';found:boolean;response:TemplateSaveResult|null}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0')
export function validTemplateSave(value:unknown):value is TemplateSaveOperation {
 const op=value as TemplateSaveOperation,i=op?.input
 return !!op&&text(op.team,128)&&text(op.template,128)&&Number.isSafeInteger(op.actor)&&op.actor>0&&!!i&&text(i.request_id,128)&&Number.isSafeInteger(i.expected_revision)&&i.expected_revision>=0&&i.expected_revision<100&&validTemplate(i.definition)
}
export function matchesTemplateSave(op:TemplateSaveOperation,r:TemplateSaveResult):boolean {return !!r&&r.team_id===op.team&&r.template_id===op.template&&r.revision===op.input.expected_revision+1&&templateHash(r.content_hash)}
export function matchesTemplateSaveReceipt(op:TemplateSaveOperation,r:TemplateSaveReceipt):boolean {return !!r&&r.team_id===op.team&&r.actor_user_id===op.actor&&r.request_id===op.input.request_id&&r.operation==='save_template'&&typeof r.found==='boolean'&&(r.found?!!r.response&&matchesTemplateSave(op,r.response):r.response===null)}
// Equality only: independent of object insertion order or server digest collation.
export function templateCanonical(value:unknown):string {
 const order=(v:unknown):unknown=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,order(x)])):v
 return JSON.stringify(order(value))
}
export function matchesSavedTemplate(op:TemplateSaveOperation,r:TemplateSaveResult,v:TemplateVersion):boolean {return matchesTemplateSave(op,r)&&validTemplateVersion(v)&&v.team_id===op.team&&v.template_id===op.template&&v.revision===r.revision&&v.content_hash===r.content_hash&&templateCanonical(v.definition)===templateCanonical(op.input.definition)}
export function blankTemplate():TeamTemplate {return {name:'',goal:'',acceptance:'',roles:[{role_id:'worker',label:'执行者',kind:'agent'},{role_id:'reviewer',label:'验收人',kind:'reviewer'}],steps:[]}}
