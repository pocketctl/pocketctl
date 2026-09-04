import type { GitConnection } from './repository.js'
import type { FixedGitTarget } from './read-adapter.js'
import { FixedGitTarget as Target } from './read-adapter.js'
import type { GitReadResponse } from './provider.js'
import { GitReadError } from './provider.js'
import type { RepositoryFile } from './types.js'
import { validateRepositoryPath } from './paths.js'

export type GitWriteRequest={action:'repository'}|{action:'branch';branch:string}|{action:'tree';sha:string}|{action:'commit';sha:string}
  |{action:'pulls';branch:string;page:number}|{action:'create_tree';baseTree:string;files:RepositoryFile[]}
  |{action:'create_commit';tree:string;parent:string;message:string;date:string}
  |{action:'create_branch';branch:string;sha:string}|{action:'file';path:string;ref:string}
  |{action:'write_file';path:string;branch:string;bytes:Uint8Array;expectedBlob:string|null;message:string}
  |{action:'create_pull';branch:string;body:string;title:string}
export interface GitWriteEndpoint{segments:string[];method:'GET'|'POST'|'PUT';query?:Record<string,string>;body?:Record<string,unknown>;encoding?:'json'|'form'}
declare const testCapability:unique symbol
/** Only the testing module constructs this capability; no production factory or
 * runtime dependency exposes it. Plain JSON/booleans cannot supply its function. */
export interface GitFixtureWriteCapability {
  readonly [testCapability]:true;kind:'fixture';provider:'github'|'gitee';target:FixedGitTarget
  request(input:GitWriteRequest,signal:AbortSignal):Promise<GitReadResponse>
}
export interface GitFixtureWriteRegistry {resolve(connection:GitConnection):Promise<GitFixtureWriteCapability|null>}
const checkSha=(s:string)=>{if(!/^[a-f0-9]{40}$/.test(s))throw new GitReadError('provider_unverifiable');return s}
const exportBranch=(s:string)=>{if(!/^pocketctl\/export\/[0-9a-f-]{36}$/.test(s))throw new GitReadError('provider_target_invalid');return s}
/** Pure protocol encoding, no HTTP and no credential. Gitee writes use documented
 * formData. GitHub immutable create only: no ref PATCH/force update exists here. */
export function gitWriteEndpoint(provider:'github'|'gitee',fixed:FixedGitTarget,input:GitWriteRequest):GitWriteEndpoint {
  const t=Target.parse(fixed),root=['repos',t.owner,t.repository],encoding=provider==='github'?'json':'form'
  switch(input.action){
    case 'repository':return {method:'GET',segments:root}
    case 'branch':return provider==='github'?{method:'GET',segments:[...root,'git','ref','heads',input.branch]}:{method:'GET',segments:[...root,'branches',input.branch]}
    case 'tree':return {method:'GET',segments:[...root,'git','trees',checkSha(input.sha)],query:{recursive:'1'}}
    case 'commit':return {method:'GET',segments:provider==='github'?[...root,'git','commits',checkSha(input.sha)]:[...root,'commits',checkSha(input.sha)]}
    case 'pulls':
      if(!Number.isInteger(input.page)||input.page<1||input.page>128)throw new GitReadError('provider_cursor_invalid')
      return {method:'GET',segments:[...root,'pulls'],query:{state:'all',head:`${t.owner}:${exportBranch(input.branch)}`,base:t.branch,per_page:'100',page:String(input.page)}}
    case 'create_tree':
      if(provider!=='github')throw new GitReadError('provider_unavailable')
      return {method:'POST',segments:[...root,'git','trees'],encoding,body:{base_tree:checkSha(input.baseTree),tree:input.files.map(f=>{
        validateRepositoryPath(f.path);return {path:f.path,mode:'100644',type:'blob',content:new TextDecoder('utf-8',{fatal:true}).decode(f.bytes)}})}}
    case 'create_commit':{
      if(provider!=='github')throw new GitReadError('provider_unavailable')
      const author={name:'PocketCtl Memory',email:'memory@pocketctl.invalid',date:input.date}
      return {method:'POST',segments:[...root,'git','commits'],encoding,body:{tree:checkSha(input.tree),parents:[checkSha(input.parent)],message:input.message,author,committer:author}}
    }
    case 'create_branch':return {method:'POST',segments:provider==='github'?[...root,'git','refs']:[...root,'branches'],encoding,
      body:provider==='github'?{ref:`refs/heads/${exportBranch(input.branch)}`,sha:checkSha(input.sha)}:{branch_name:exportBranch(input.branch),refs:checkSha(input.sha)}}
    case 'file':validateRepositoryPath(input.path);return {method:'GET',segments:[...root,'contents',...input.path.split('/')],query:{ref:input.ref}}
    case 'write_file':
      if(provider!=='gitee')throw new GitReadError('provider_unavailable');validateRepositoryPath(input.path)
      return {method:input.expectedBlob?'PUT':'POST',segments:[...root,'contents',...input.path.split('/')],encoding,
        body:{branch:exportBranch(input.branch),message:input.message,content:Buffer.from(input.bytes).toString('base64'),...(input.expectedBlob?{sha:checkSha(input.expectedBlob)}:{})}}
    case 'create_pull':return {method:'POST',segments:[...root,'pulls'],encoding,body:{head:exportBranch(input.branch),base:t.branch,title:input.title,body:input.body,draft:true}}
  }
}
