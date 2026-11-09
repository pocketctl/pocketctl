import { TABLE_POLICY } from './table-policy.js'
import {JSON_COLUMN_POLICY} from './json-reference-policy.js'
export const ACTIONS=['migrate-as-is','transform','retire-after-gate','derived-rebuild','audit-archive','retain-relay'] as const
export type Action=typeof ACTIONS[number]
export interface CatalogObject {key:string; kind:string; schema:string; name:string; definitionHash:string; [key:string]:unknown}
export type ObjectPlan=Record<string,{action:Action;definitionHash:string}>
export function classifyObject(object:CatalogObject,plan:ObjectPlan) {
  const entry=Object.hasOwn(plan,object.key)?plan[object.key]:undefined
  let suggestion:string|undefined
  if(object.kind==='table'&&object.schema==='public'&&Object.hasOwn(TABLE_POLICY,object.name))suggestion=TABLE_POLICY[object.name]
  if(object.kind==='json-column'&&['public','memory'].includes(object.schema)&&Object.hasOwn(JSON_COLUMN_POLICY,object.name))suggestion=JSON_COLUMN_POLICY[object.name].action
  const action:string=entry?.action??suggestion??'unclassified'
  const reasons:string[]=[]
  if(!entry)reasons.push('object_review_required')
  if(entry && (!ACTIONS.includes(entry.action) || entry.definitionHash!==object.definitionHash))reasons.push('object_definition_or_action_changed')
  if(action==='unclassified')reasons.push('unrecognized_object')
  return {action,blocked:reasons.length>0,reasons}
}
export function parseObjectPlan(value: unknown): ObjectPlan {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid_object_plan')
  const plan: ObjectPlan=Object.create(null)
  for(const [key,entry] of Object.entries(value)){
    if(!entry || typeof entry!=='object')throw new Error('invalid_object_plan')
    const e=entry as Record<string,unknown>
    if(!ACTIONS.includes(e.action as Action) || typeof e.definitionHash!=='string' || !/^[a-f0-9]{64}$/.test(e.definitionHash))throw new Error('invalid_object_plan')
    plan[key]={action:e.action as Action,definitionHash:e.definitionHash}
  }
  return plan
}
