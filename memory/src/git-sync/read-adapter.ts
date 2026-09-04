import { createHash,randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GitReadError,type GitReadCapability } from './provider.js'
import { GIT_ORIGINS,type GitTransport } from './transport.js'
import { KNOWLEDGE_ROOT,validateRepositoryPath,GIT_INPUT_LIMITS } from './paths.js'

export const FixedGitTarget=z.object({providerRepositoryId:z.string().regex(/^[1-9][0-9]{0,19}$/),owner:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  repository:z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).refine(v=>v!=='.'&&v!=='..'),branch:z.string().min(1).max(255).refine(v=>!/[\x00-\x20~^:?*\[\\]/.test(v)&&!v.includes('..')),private:z.boolean()}).strict()
export type FixedGitTarget=z.infer<typeof FixedGitTarget>
const sha=z.string().regex(/^[a-f0-9]{40}$/),id=z.union([z.string(),z.number().int().safe()])
const repo=z.object({id,full_name:z.string(),private:z.boolean()})
const reference=z.object({ref:z.string(),repo})
const pr=z.object({number:z.number().int().positive(),merged:z.boolean(),merge_commit_sha:sha.nullable().optional(),head:reference,base:reference})
const entry=z.object({path:z.string(),mode:z.string(),type:z.string(),sha,size:z.number().int().nonnegative().optional()})
const parse=<T>(schema:z.ZodType<T>,raw:unknown):T=>{const value=schema.safeParse(raw);if(!value.success)throw new GitReadError('provider_unverifiable');return value.data}
export function createFixedGitReadCapability(provider:'github'|'gitee',options:{target:FixedGitTarget;transport:GitTransport}):GitReadCapability {
  const parsed=FixedGitTarget.safeParse(options.target);if(!parsed.success)throw new GitReadError('provider_target_invalid')
  const target=parsed.data,root=['repos',target.owner,target.repository]
  let continuation:{token:string;commit:string;tree:string;entries:z.infer<typeof entry>[];index:number}|undefined
  function assertRepo(value:z.infer<typeof repo>){if(String(value.id)!==target.providerRepositoryId||value.full_name!==`${target.owner}/${target.repository}`||value.private!==target.private)throw new GitReadError('provider_target_mismatch')}
  return {kind:'live',target:{provider,providerRepositoryId:target.providerRepositoryId,branch:target.branch,origin:GIT_ORIGINS[provider]},
    async request(request,signal){
      let segments:string[],query:Record<string,string>|undefined
      if(request.operation==='repository')segments=root
      else if(request.operation==='merge') {if(!/^[1-9][0-9]{0,14}$/.test(request.number))throw new GitReadError('provider_unverifiable');segments=[...root,'pulls',request.number]}
      else if(request.operation==='commit'){parse(sha,request.sha);segments=provider==='github'?[...root,'git','commits',request.sha]:[...root,'commits',request.sha]}
      else if(request.operation==='poll') {
        const page=request.cursor??'1';if(!/^[1-9][0-9]{0,2}$/.test(page)||Number(page)>128)throw new GitReadError('provider_cursor_invalid')
        segments=[...root,'pulls'];query={state:'all',base:target.branch,per_page:'100',page}
      } else {
        parse(sha,request.commit);parse(sha,request.tree)
        if(request.cursor===null){continuation=undefined;segments=[...root,'git','trees',request.tree];query={recursive:'1'}}
        else {if(!continuation||continuation.token!==request.cursor||continuation.commit!==request.commit||continuation.tree!==request.tree)throw new GitReadError('provider_cursor_invalid')
          segments=[...root,'git','blobs',continuation.entries[continuation.index].sha]}
      }
      const response=await options.transport({segments,query},signal)
      if(response.status!==200)return response
      try {
        let body:unknown
        if(request.operation==='repository') {
          assertRepo(parse(repo,response.body));body={providerRepositoryId:target.providerRepositoryId}
        } else if(request.operation==='merge') {
          // Gitee's incomplete head/base/merge model cannot establish an exact
          // merge commit. A response must supply the full authoritative shape.
          const value=parse(pr,response.body);assertRepo(value.head.repo);assertRepo(value.base.repo)
          const exportId=value.head.ref.match(/^pocketctl\/export\/([0-9a-f-]{36})$/)?.[1]
          if(!exportId||!z.uuid().safeParse(exportId).success||String(value.number)!==request.number||value.base.ref!==target.branch||value.merged&&!value.merge_commit_sha)throw new GitReadError('provider_unverifiable')
          body={providerRepositoryId:target.providerRepositoryId,number:request.number,baseBranch:target.branch,merged:value.merged,exportId,actorId:null,
            ...(value.merged?{mergeCommit:value.merge_commit_sha}:{})}
        } else if(request.operation==='commit') {
          const value=provider==='github'?parse(z.object({sha,tree:z.object({sha})}),response.body)
            :(()=>{const v=parse(z.object({sha,commit:z.object({tree:z.object({sha})})}),response.body);return {sha:v.sha,tree:v.commit.tree}})()
          if(value.sha!==request.sha)throw new GitReadError('provider_unverifiable')
          body={sha:value.sha,tree:value.tree.sha}
        } else if(request.operation==='poll') {
          const values=parse(z.array(z.unknown()).max(100),response.body),changes:{number:string;exportId:string}[]=[]
          for(const raw of values){
            // Ordinary fork PRs (including deleted head repositories) are not
            // export candidates. Their repository proof is irrelevant here.
            const hint=parse(z.object({head:z.object({ref:z.string()})}),raw)
            if(!hint.head.ref.startsWith('pocketctl/export/'))continue
            const value=parse(z.object({number:z.number().int().positive(),base:reference,head:reference}),raw)
            assertRepo(value.base.repo);assertRepo(value.head.repo)
            if(value.base.ref!==target.branch)throw new GitReadError('provider_target_mismatch')
            changes.push({number:String(value.number),exportId:parse(z.uuid(),value.head.ref.slice('pocketctl/export/'.length))})
          }
          const page=Number(request.cursor??1);if(values.length===100&&page===128)throw new GitReadError('provider_cursor_invalid')
          body={providerRepositoryId:target.providerRepositoryId,branch:target.branch,changes,nextCursor:values.length===100?String(page+1):null}
        } else if(request.cursor===null) {
          const value=parse(z.object({sha,truncated:z.boolean().optional(),tree:z.array(entry).max(4096)}),response.body)
          if(value.sha!==request.tree||value.truncated)throw new GitReadError('provider_unverifiable')
          const entries:z.infer<typeof entry>[]=[],seen=new Set<string>()
          for(const item of value.tree){
            if(item.path.includes('..')||item.path.startsWith('/')||item.path.includes('\\'))throw new GitReadError('provider_unverifiable')
            if(!item.path.startsWith(KNOWLEDGE_ROOT+'/'))continue
            if(item.type==='tree'&&item.mode==='040000')continue
            if(item.mode!=='100644'||item.type!=='blob'||item.size===undefined||item.size>262144||seen.has(item.path))throw new GitReadError('provider_unverifiable')
            validateRepositoryPath(item.path);seen.add(item.path);entries.push(item)
          }
          if(entries.length>GIT_INPUT_LIMITS.maxFiles||entries.reduce((n,e)=>n+e.size!,0)>GIT_INPUT_LIMITS.maxTotalBytes)throw new GitReadError('provider_unverifiable')
          continuation=entries.length?{token:randomUUID(),commit:request.commit,tree:request.tree,entries,index:0}:undefined
          body={commit:request.commit,tree:request.tree,files:[],nextCursor:continuation?.token??null}
        } else {
          const state=continuation!,item=state.entries[state.index],value=parse(z.object({sha,encoding:z.literal('base64'),size:z.number().int().nonnegative(),content:z.string().max(400000)}),response.body)
          const normalized=value.content.replace(/[\r\n]/g,''),bytes=Buffer.from(normalized,'base64')
          if(bytes.toString('base64')!==normalized||value.sha!==item.sha||value.size!==bytes.length||item.size!==bytes.length
            ||createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')!==item.sha)throw new GitReadError('provider_unverifiable')
          state.index++;state.token=randomUUID();continuation=state.index<state.entries.length?state:undefined
          body={commit:request.commit,tree:request.tree,files:[{path:item.path,mode:'100644',bytes}],nextCursor:continuation?.token??null}
        }
        return {...response,body}
      }catch(error){throw new GitReadError(error instanceof GitReadError?error.code:'provider_unverifiable',false,1000,response.receivedBytes??0)}
    }}
}
