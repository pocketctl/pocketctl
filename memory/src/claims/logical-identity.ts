import {createHash} from 'node:crypto'
import {z} from 'zod'
import {canonicalBundleJSON} from '../governance/revision-bundle.js'

/** Values, timestamps and model-generated text are deliberately excluded.
 * IDs and predicate aliases must already have been resolved by trusted services. */
export const logicalIdentitySchema = z.object({
 installationId:z.uuid(), spaceId:z.uuid(), subjectEntityId:z.uuid(),
 predicateId:z.string().regex(/^[a-z][a-z0-9_.]{0,119}$/),
 variant:z.unknown().superRefine((v,ctx)=>{
  if(v&&typeof v==='object'&&Object.keys(v).some(k=>['constructor','prototype','__proto__'].includes(k)))ctx.addIssue({code:'custom',message:'invalid variant key'})
 }).pipe(z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),z.string().min(1).max(200))).default({}),
 cardinality:z.enum(['single','set','event']),
 memberKey:z.string().min(1).max(200).optional(),
}).strict().superRefine((v,ctx)=>{
 if((v.cardinality==='single')===(v.memberKey!==undefined))ctx.addIssue({code:'custom',message:'member identity required only for set/event'})
 if(Object.keys(v.variant).some(k=>['constructor','prototype','__proto__'].includes(k)))ctx.addIssue({code:'custom',message:'invalid variant key'})
 if(Object.keys(v.variant).length>16)ctx.addIssue({code:'custom',message:'too many applicability dimensions'})
})
export type LogicalIdentity = Omit<z.output<typeof logicalIdentitySchema>,'variant'> & {variant?:Record<string,string>}
export function logicalIdentity(input:LogicalIdentity):string {
 const v=logicalIdentitySchema.parse(input)
 return createHash('sha256').update(canonicalBundleJSON(['memory-logical-v1',v.installationId.toLowerCase(),v.spaceId.toLowerCase(),v.subjectEntityId.toLowerCase(),v.predicateId,v.variant,v.cardinality,v.memberKey??null])).digest('hex')
}
