import {z} from 'zod'
import {createHash} from 'node:crypto'
export const automationPolicySchema=z.object({
 mode:z.enum(['off','shadow','assist']).default('off'),
 model:z.string().min(1).max(200),promptVersion:z.string().min(1).max(100),
 evaluatorVersion:z.literal('review-v1').default('review-v1'),
 originPolicy:z.literal('owned-sanitized-evidence-v1').default('owned-sanitized-evidence-v1'),
 personalAutoAccept:z.boolean().default(false),delegatedPublish:z.boolean().default(false),
}).strict()
export type AutomationPolicy=z.infer<typeof automationPolicySchema>
export function automationHash(value:unknown):string{
 function stable(v:any):any{if(v instanceof Date)return v.toISOString();if(Buffer.isBuffer(v))return v.toString('hex');return Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v}
 return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}
