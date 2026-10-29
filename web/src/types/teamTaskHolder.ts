import type {TeamTask} from './team'
import type {TeamTaskHolderInput,TeamTaskHolderReceipt} from '../services/teamClient'
export interface HolderOperation {team:string;task:string;actor:number;active:boolean;input:TeamTaskHolderInput}
const object=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v===v.trim()&&!v.includes('\0')
export function validHolderOperation(v:unknown):v is HolderOperation {
 if(!object(v,['team','task','actor','active','input'])||!text(v.team,256)||!text(v.task,256)||!Number.isSafeInteger(v.actor)||Number(v.actor)<1||typeof v.active!=='boolean')return false
 const i=v.input
 return object(i,['request_id','expected_revision'])&&text(i.request_id,128)&&Number.isSafeInteger(i.expected_revision)&&Number(i.expected_revision)>0
}
export function matchesHolderResult(op:HolderOperation,t:TeamTask):boolean {
 return validHolderOperation(op)&&!!t&&t.id===op.task&&t.team_id===op.team&&t.revision===op.input.expected_revision+1&&Array.isArray(t.holder_user_ids)&&t.holder_user_ids.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(t.holder_user_ids).size===t.holder_user_ids.length&&t.holder_user_ids.includes(op.actor)===op.active
}
export function matchesHolderReceipt(op:HolderOperation,r:TeamTaskHolderReceipt):boolean {
 return validHolderOperation(op)&&!!r&&r.task_id===op.task&&r.actor_user_id===op.actor&&r.request_id===op.input.request_id&&typeof r.found==='boolean'&&(r.found?!!r.response&&matchesHolderResult(op,r.response):r.response===null)
}
