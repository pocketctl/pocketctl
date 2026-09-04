import type { GitConnection } from './repository.js'
import type { RepositoryFile } from './types.js'
import { z } from 'zod'
import { createHmac,timingSafeEqual } from 'node:crypto'
import { parseStrictJson } from './strict-json.js'
import type { GitTrigger } from './inbox-service.js'

/** Called by the transport route using server-owned target/secret registration.
 * Even a valid signature only permits re-reading a change number; Gitee's MAC
 * does not authenticate its body at all. No merge/content/author fact escapes. */
export function verifyGitWebhook(input:{rawBody:Uint8Array;signature:string;eventType:string;eventId:string;timestamp?:string},
  registration:{provider:'github'|'gitee';providerRepositoryId:string;secret:string;eventType:string}):GitTrigger {
  try {
    if(input.rawBody.byteLength>1_048_576||!registration.secret||input.eventType!==registration.eventType
      ||!/^[A-Za-z0-9._:-]{1,256}$/.test(input.eventId))throw new Error()
    let expected:string
    if(registration.provider==='github')expected='sha256='+createHmac('sha256',registration.secret).update(input.rawBody).digest('hex')
    else {
      if(!input.timestamp||!/^\d{13}$/.test(input.timestamp)||Math.abs(Date.now()-Number(input.timestamp))>3_600_000)throw new Error()
      expected=encodeURIComponent(createHmac('sha256',registration.secret).update(input.timestamp+'\n'+registration.secret).digest('base64'))
    }
    const wanted=Buffer.from(expected),received=Buffer.from(input.signature)
    if(wanted.byteLength!==received.byteLength||!timingSafeEqual(wanted,received))throw new Error()
    const body=z.object({repository:z.object({id:z.union([z.string(),z.number().int().safe()])}),pull_request:z.object({number:z.union([z.string(),z.number().int().safe()])})})
      .parse(parseStrictJson(input.rawBody))
    if(String(body.repository.id)!==registration.providerRepositoryId||!/^[1-9][0-9]{0,14}$/.test(String(body.pull_request.number)))throw new Error()
    return {source:'webhook',eventId:input.eventId,changeNumber:String(body.pull_request.number)}
  }catch{throw new GitReadError('webhook_invalid')}
}

/** One request means exactly one HTTP attempt. Adapters MUST NOT retry, page or
 * redirect internally. Runtime composition supplies separately consented reads;
 * no write operation or credential is available through this port. */
export type GitReadRequest={operation:'repository'}|{operation:'merge';number:string}|{operation:'commit';sha:string}
  |{operation:'tree';commit:string;tree:string;cursor:string|null}|{operation:'poll';cursor:string|null}
export interface GitReadResponse {status:number;body?:unknown;retryAfterMs?:number
  /** Concrete HTTP adapters report bounded decoded response bytes; fixture adapters may
   * omit this, in which case only decoded tree content bytes are measured. */
  receivedBytes?:number}
export interface GitReadCapability {
  kind:'fixture'|'live'
  target:{provider:GitConnection['provider'];providerRepositoryId:string;branch:string;origin:string}
  request(request:GitReadRequest,signal:AbortSignal):Promise<GitReadResponse>
}
export interface GitReadRegistry {resolve(connection:GitConnection):Promise<GitReadCapability|null>}
export class GitReadError extends Error {
  constructor(readonly code:string,readonly retryable=false,readonly retryAfterMs=1000,readonly receivedBytes=0){super(code)}
}
const sha=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const text=z.string().min(1).max(256)
export const MergeRead=z.object({providerRepositoryId:text,number:z.string().regex(/^[1-9][0-9]{0,14}$/),baseBranch:text,
  merged:z.literal(true),mergeCommit:sha,exportId:z.uuid(),actorId:text.nullable()}).strict()
export const MergeObservation=z.discriminatedUnion('merged',[MergeRead,MergeRead.omit({mergeCommit:true}).extend({merged:z.literal(false)})])
export const CommitRead=z.object({sha,tree:sha}).strict()
export const TreeRead=z.object({commit:sha,tree:sha,files:z.array(z.object({path:z.string().max(512),mode:z.literal('100644'),bytes:z.instanceof(Uint8Array)}).strict()).max(256),
  nextCursor:z.string().min(1).max(1024).nullable()}).strict()
export const PollRead=z.object({providerRepositoryId:text,branch:text,changes:z.array(z.object({number:z.string().regex(/^[1-9][0-9]{0,14}$/),exportId:z.uuid().optional()}).strict()).max(128),
  nextCursor:z.string().min(1).max(1024).nullable()}).strict()
export type VerifiedGitMerge=z.infer<typeof MergeRead>&{tree:string;files:RepositoryFile[]}
export function parseGitRead<T>(schema:z.ZodType<T>,value:unknown):T {
  const parsed=schema.safeParse(value);if(!parsed.success)throw new GitReadError('provider_unverifiable');return parsed.data
}
export function assertGitReadTarget(c:GitConnection,capability:GitReadCapability,mode:'shadow'|'enabled') {
  const t=capability.target
  let origin:URL;try{origin=new URL(t.origin)}catch{throw new GitReadError('provider_unavailable')}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==t.origin||t.provider!==c.provider
    ||t.providerRepositoryId!==c.providerRepositoryId||t.branch!==c.targetBranch
    ||t.origin!==(c.provider==='github'?'https://api.github.com':c.provider==='gitee'?'https://gitee.com':null))throw new GitReadError('provider_unavailable')
  if(mode==='shadow'&&capability.kind!=='fixture')throw new GitReadError('read_not_authorized')
}
