import { createHash } from 'node:crypto'
import { z } from 'zod'
import { GitReadError,type GitReadResponse } from './provider.js'
import type { FixedGitTarget } from './read-adapter.js'
import type { GitWriteRequest } from './write-protocol.js'
import { gitTreeHash } from './git-objects.js'

export type GitRecognitionRequest=Extract<GitWriteRequest,{action:'repository'|'branch'|'commit'|'tree'|'pulls'}>
export interface GitRemoteMetadata {
  oldRunId:string;installationId:string;connectionId:string;exportId:string;provider:'github'|'gitee';target:FixedGitTarget
  branch:string;commit:string;tree:string;descriptionHash:string
}
export interface GitRemoteRecognition {branch:string;commit:string;tree:string;pullNumber:string}
const sha=z.string().regex(/^[a-f0-9]{40}$/),uuid=z.uuid()
/** Internal lifecycle handoff. Metadata must come from server persistence before
 * cascade, never request JSON. Caller owns a NEW currently authorized run, the
 * dispatcher session gate, explicit target read consent, and the shared durable
 * request executor. record must commit under that same new run/job fence.
 * Missing authority leaves cleanup_pending; this function never creates a grant,
 * revives the old run, reads a snapshot, or obtains any WRITE capability. */
export async function recognizeGitRemoteOperation(metadata:GitRemoteMetadata,deps:{currentRunId:string;
  read(request:GitRecognitionRequest,signal:AbortSignal):Promise<GitReadResponse>
  execute(operation:'reconcile',perform:(signal:AbortSignal)=>Promise<GitReadResponse>,success?:readonly number[]):Promise<GitReadResponse>
  record(proof:GitRemoteRecognition):Promise<void>
}):Promise<GitRemoteRecognition|null>{
  if(!uuid.safeParse(deps.currentRunId).success||deps.currentRunId===metadata.oldRunId||metadata.branch!==`pocketctl/export/${metadata.exportId}`
    ||![metadata.commit,metadata.tree].every(v=>sha.safeParse(v).success)||!/^[a-f0-9]{64}$/.test(metadata.descriptionHash))throw new GitReadError('reconcile_not_authorized')
  const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const p=schema.safeParse(value);if(!p.success)throw new GitReadError('provider_unverifiable');return p.data}
  const call=(request:GitRecognitionRequest,success:readonly number[]=[200])=>deps.execute('reconcile',signal=>deps.read(request,signal),success)
  function repo(raw:unknown){const value=parse(z.object({id:z.union([z.string(),z.number().int().safe()]),full_name:z.string(),private:z.boolean()}),raw)
    if(String(value.id)!==metadata.target.providerRepositoryId||value.full_name!==`${metadata.target.owner}/${metadata.target.repository}`||value.private!==metadata.target.private)throw new GitReadError('provider_target_mismatch')}
  repo((await call({action:'repository'})).body)
  const branch=await call({action:'branch',branch:metadata.branch},[200,404]);if(branch.status===404)return null
  const branchSha=metadata.provider==='github'?parse(z.object({ref:z.literal(`refs/heads/${metadata.branch}`),object:z.object({sha})}),branch.body).object.sha
    :parse(z.object({name:z.literal(metadata.branch),commit:z.object({sha})}),branch.body).commit.sha
  if(branchSha!==metadata.commit)throw new GitReadError('provider_conflict')
  const commit=(await call({action:'commit',sha:metadata.commit})).body
  const tree=metadata.provider==='github'?parse(z.object({sha:z.literal(metadata.commit),tree:z.object({sha})}),commit).tree.sha
    :parse(z.object({sha:z.literal(metadata.commit),commit:z.object({tree:z.object({sha})})}),commit).commit.tree.sha
  if(tree!==metadata.tree)throw new GitReadError('provider_conflict')
  const contents=parse(z.object({sha:z.literal(metadata.tree),truncated:z.boolean().optional(),tree:z.array(z.object({path:z.string(),sha,mode:z.string(),type:z.string()})).max(4096)}),(await call({action:'tree',sha:metadata.tree})).body)
  if(contents.truncated||gitTreeHash(contents.tree)!==metadata.tree)throw new GitReadError('provider_unverifiable')
  let found:GitRemoteRecognition|null=null
  for(let page=1;page<=128;page++){
    const values=parse(z.array(z.object({number:z.number().int().positive(),body:z.string().max(65536),head:z.object({ref:z.string(),sha,repo:z.unknown()}),base:z.object({ref:z.string(),repo:z.unknown()})})).max(100),
      (await call({action:'pulls',branch:metadata.branch,page})).body)
    for(const p of values){if(p.head.ref!==metadata.branch||p.base.ref!==metadata.target.branch)continue
      repo(p.head.repo);repo(p.base.repo)
      if(found||p.head.sha!==metadata.commit||createHash('sha256').update(p.body).digest('hex')!==metadata.descriptionHash)throw new GitReadError('provider_conflict')
      found={branch:metadata.branch,commit:metadata.commit,tree:metadata.tree,pullNumber:String(p.number)}
    }
    if(values.length<100){if(found)await deps.record(found);return found}
  }
  throw new GitReadError('request_budget_exhausted')
}
